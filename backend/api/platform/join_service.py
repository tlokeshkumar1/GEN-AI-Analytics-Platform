"""Dynamic cross-table join discovery and resolution service.

Discovers relationships between datasets dynamically by inspecting column schemas,
semantic metadata, and live value overlap in SAP HANA Cloud or snapshot DataFrames.
Strict zero-hardcoding: operates purely on relational metadata, key inference, and data overlap.
"""
import re
import time
from typing import Any, Dict, List, Optional, Tuple
import pandas as pd

from api.utils.logger import get_logger

logger = get_logger("platform.join_service")


class CrossTableJoinService:
    """Zero-hardcoding service for discovering and executing cross-table joins."""

    def __init__(self):
        self._graph_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
        self._cache_ttl: float = 30.0  # seconds

    def invalidate_cache(self):
        """Invalidate in-memory join graph caches."""
        self._graph_cache.clear()

    @staticmethod
    def _normalize_name(name: str) -> str:
        """Strip non-alphanumeric characters and lowercase for key matching."""
        return re.sub(r"[^a-z0-9]", "", str(name).lower())

    @staticmethod
    def _score_key_pair(left_col: str, right_col: str, left_role: Optional[str] = None, right_role: Optional[str] = None) -> int:
        """Score candidate column pair for join potential based purely on name patterns and semantic roles.

        Returns a score from 0 to 100.
        """
        l_norm = CrossTableJoinService._normalize_name(left_col)
        r_norm = CrossTableJoinService._normalize_name(right_col)

        if not l_norm or not r_norm:
            return 0

        score = 0
        if l_norm == r_norm:
            score = 90
        elif l_norm.endswith(r_norm) or r_norm.endswith(l_norm):
            score = 75
        elif any(k in l_norm for k in ("id", "key", "code", "num", "no")) and any(k in r_norm for k in ("id", "key", "code", "num", "no")):
            score = 60
        else:
            return 0

        # Bonus for semantic role hints
        if left_role in ("identifier", "key") or right_role in ("identifier", "key"):
            score += 10

        return min(score, 100)

    def _get_dataset_entry_and_snapshot(self, dataset_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """Fetch catalog entry and current snapshot for a dataset."""
        try:
            from api.services.dataset_service import dataset_service
            catalog = dataset_service._catalog()
            entry = dataset_service._entry(catalog, dataset_id, for_chat=True)
            if not entry:
                return None, None
            snapshot = dataset_service._snapshot(entry, entry.get("currentVersion", 1))
            return entry, snapshot
        except Exception as exc:
            logger.warning(f"Failed to load entry/snapshot for dataset '{dataset_id}': {exc}")
            return None, None

    def get_dataset_columns(self, dataset_id: str) -> List[Dict[str, Any]]:
        """Return columns with name, type, and optional semantic role."""
        entry, snapshot = self._get_dataset_entry_and_snapshot(dataset_id)
        if not snapshot or "columns" not in snapshot:
            return []

        cols = []
        # Attempt to get semantic fields for role hints
        roles_by_name = {}
        try:
            from api.platform.semantic import semantic_registry
            if entry:
                model = semantic_registry.get(entry, entry.get("currentVersion", 1), 1, approved=False)
                if model and hasattr(model, "fields"):
                    for f in model.fields:
                        roles_by_name[f.name.lower()] = f.role
        except Exception:
            pass

        for c in snapshot["columns"]:
            c_name = c.get("name", "")
            cols.append({
                "name": c_name,
                "type": c.get("type", "string"),
                "role": roles_by_name.get(c_name.lower(), "dimension" if c.get("type") in ("string", "date") else "measure"),
            })
        return cols

    def _resolve_physical_table_name(self, entry: Dict[str, Any]) -> str:
        """Resolve HANA physical table name dynamically."""
        from api.platform.datasets_metadata_repository import datasets_metadata_repo
        candidates = []
        if entry.get("tableName"):
            candidates.append(entry["tableName"])
        if entry.get("table_name"):
            candidates.append(entry["table_name"])
        if entry.get("physical_table_name"):
            candidates.append(entry["physical_table_name"])
        if entry.get("name"):
            candidates.append(entry["name"])
        if entry.get("folder"):
            candidates.append(entry["folder"])
        for cand in candidates:
            resolved = datasets_metadata_repo._resolve_physical_table(cand)
            if resolved:
                return resolved
        return entry.get("tableName") or entry.get("table_name") or entry.get("name", "DATASET_TABLE")

    def _verify_overlap_in_hana(
        self, left_table: str, right_table: str, left_col: str, right_col: str
    ) -> Optional[Tuple[int, int, int, int, int]]:
        """Verify data overlap directly in SAP HANA Cloud without moving raw rows.

        Returns (overlap_count, total_left, distinct_left, total_right, distinct_right)
        or None if HANA is unavailable or query fails.
        """
        try:
            from api.database.hana_client import hana_client
            # 1. Overlap count
            overlap_sql = f"""
                SELECT COUNT(DISTINCT L."{left_col}") AS OVERLAP_COUNT
                FROM "{left_table}" L
                INNER JOIN "{right_table}" R ON L."{left_col}" = R."{right_col}"
                WHERE L."{left_col}" IS NOT NULL AND R."{right_col}" IS NOT NULL
            """
            rows = hana_client.execute_query(overlap_sql)
            if not rows or rows[0].get("OVERLAP_COUNT") is None:
                return None
            overlap = int(rows[0].get("OVERLAP_COUNT", 0))

            # 2. Distinct & total counts on right
            r_sql = f'SELECT COUNT(*) AS TOTAL, COUNT(DISTINCT "{right_col}") AS UNIQ FROM "{right_table}" WHERE "{right_col}" IS NOT NULL'
            r_rows = hana_client.execute_query(r_sql)
            total_r = int(r_rows[0].get("TOTAL", 0)) if r_rows else 0
            uniq_r = int(r_rows[0].get("UNIQ", 0)) if r_rows else 0

            # 3. Distinct & total counts on left
            l_sql = f'SELECT COUNT(*) AS TOTAL, COUNT(DISTINCT "{left_col}") AS UNIQ FROM "{left_table}" WHERE "{left_col}" IS NOT NULL'
            l_rows = hana_client.execute_query(l_sql)
            total_l = int(l_rows[0].get("TOTAL", 0)) if l_rows else 0
            uniq_l = int(l_rows[0].get("UNIQ", 0)) if l_rows else 0

            return overlap, total_l, uniq_l, total_r, uniq_r
        except Exception as exc:
            logger.debug(f"HANA overlap verification failed ({left_table} <-> {right_table}): {exc}")
            return None

    def _verify_overlap_in_pandas(
        self, left_df: pd.DataFrame, right_df: pd.DataFrame, left_col: str, right_col: str
    ) -> Tuple[int, int, int, int, int]:
        """Verify data overlap in memory using pandas DataFrames.

        Returns (overlap_count, total_left, distinct_left, total_right, distinct_right).
        """
        l_series = left_df[left_col].dropna().astype(str).str.strip()
        r_series = right_df[right_col].dropna().astype(str).str.strip()

        # Ignore empty strings
        l_vals = set(l_series[l_series != ""])
        r_vals = set(r_series[r_series != ""])

        overlap = len(l_vals.intersection(r_vals))
        total_l = len(l_series)
        uniq_l = len(l_vals)
        total_r = len(r_series)
        uniq_r = len(r_vals)

        return overlap, total_l, uniq_l, total_r, uniq_r

    def _determine_cardinality(self, total_l: int, uniq_l: int, total_r: int, uniq_r: int) -> Tuple[str, bool, Optional[str]]:
        """Determine cardinality and aggregation safety.

        Returns (cardinality, aggregation_safe, warning_message).
        """
        l_unique = (total_l > 0 and uniq_l == total_l)
        r_unique = (total_r > 0 and uniq_r == total_r)

        if l_unique and r_unique:
            return "one_to_one", True, None
        elif not l_unique and r_unique:
            # Left has many rows, right is unique lookup table
            return "many_to_one", True, None
        elif l_unique and not r_unique:
            # Left is single parent row, right has multiple child rows
            # Measuring left additive metrics (SUM, AVG) joined with right dimensions will multiply parent rows!
            return (
                "one_to_many",
                False,
                "Notice: Dimension table has multiple rows per parent record. Additive measures (SUM, AVG) on the parent table may be multiplied; use COUNT or select Dimension from the parent table instead."
            )
        else:
            return (
                "many_to_many",
                False,
                "Both tables contain non-unique join keys. Aggregations may produce row inflation."
            )

    def resolve_join(self, left_dataset_id: str, right_dataset_id: str) -> Dict[str, Any]:
        """Dynamically resolve join viability between any two datasets.

        Checks:
        1. Both datasets exist and have columns.
        2. Finds candidate key pairs with name/role heuristic scoring.
        3. Verifies non-empty live data overlap (overlap_count > 0).
        4. Calculates cardinality and aggregation safety.
        Returns a clean structured join resolution.
        """
        if not left_dataset_id or not right_dataset_id:
            return {"joinable": False, "reason": "Both left and right dataset IDs must be specified."}

        if left_dataset_id == right_dataset_id:
            return {"joinable": False, "reason": "Cannot cross-join a dataset with itself."}

        left_entry, left_snapshot = self._get_dataset_entry_and_snapshot(left_dataset_id)
        right_entry, right_snapshot = self._get_dataset_entry_and_snapshot(right_dataset_id)

        if not left_entry or not left_snapshot:
            return {"joinable": False, "reason": f"Dataset '{left_dataset_id}' could not be loaded."}
        if not right_entry or not right_snapshot:
            return {"joinable": False, "reason": f"Dataset '{right_dataset_id}' could not be loaded."}

        left_cols = self.get_dataset_columns(left_dataset_id)
        right_cols = self.get_dataset_columns(right_dataset_id)

        if not left_cols or not right_cols:
            return {"joinable": False, "reason": "One or both datasets have no columns."}

        # 1. Build scored candidate key pairs
        candidates: List[Tuple[int, str, str]] = []
        for l_c in left_cols:
            for r_c in right_cols:
                score = self._score_key_pair(l_c["name"], r_c["name"], l_c.get("role"), r_c.get("role"))
                if score >= 50:
                    candidates.append((score, l_c["name"], r_c["name"]))

        candidates.sort(key=lambda x: x[0], reverse=True)

        if not candidates:
            return {
                "joinable": False,
                "left_dataset_id": left_dataset_id,
                "right_dataset_id": right_dataset_id,
                "reason": "No matching join key column found between the selected tables."
            }

        # 2. Verify data overlap
        from api.services.dataset_service import dataset_service
        left_table = self._resolve_physical_table_name(left_entry)
        right_table = self._resolve_physical_table_name(right_entry)

        # Lazy load DataFrames only if HANA check fails or is unavailable
        left_df = None
        right_df = None

        best_match = None
        for score, l_key, r_key in candidates:
            # Try HANA first
            hana_overlap = self._verify_overlap_in_hana(left_table, right_table, l_key, r_key)
            if hana_overlap is not None:
                overlap, total_l, uniq_l, total_r, uniq_r = hana_overlap
            else:
                if left_df is None:
                    left_df = dataset_service._frame(left_snapshot["rows"], left_snapshot["columns"])
                if right_df is None:
                    right_df = dataset_service._frame(right_snapshot["rows"], right_snapshot["columns"])
                overlap, total_l, uniq_l, total_r, uniq_r = self._verify_overlap_in_pandas(
                    left_df, right_df, l_key, r_key
                )

            if overlap > 0:
                cardinality, agg_safe, warning = self._determine_cardinality(total_l, uniq_l, total_r, uniq_r)
                best_match = {
                    "joinable": True,
                    "left_dataset_id": left_dataset_id,
                    "right_dataset_id": right_dataset_id,
                    "left_table": left_table,
                    "right_table": right_table,
                    "left_key": l_key,
                    "right_key": r_key,
                    "overlap_count": overlap,
                    "cardinality": cardinality,
                    "aggregation_safe": agg_safe,
                    "warning": warning,
                    "score": score
                }
                break

        if not best_match:
            return {
                "joinable": False,
                "left_dataset_id": left_dataset_id,
                "right_dataset_id": right_dataset_id,
                "reason": f"Tables have candidate keys, but no overlapping records were found."
            }

        return best_match

    def get_workspace_join_graph(self, workspace_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Compute all discoverable valid joins across datasets in the workspace."""
        now = time.time()
        cache_key = workspace_id or "default"
        if cache_key in self._graph_cache:
            ts, cached_graph = self._graph_cache[cache_key]
            if (now - ts) < self._cache_ttl:
                return cached_graph

        from api.services.dataset_service import dataset_service
        catalog = dataset_service._catalog()
        datasets = catalog.get("datasets", {})
        ds_ids = list(datasets.keys())

        valid_edges: List[Dict[str, Any]] = []
        for i in range(len(ds_ids)):
            for j in range(len(ds_ids)):
                if i == j:
                    continue
                left_id = ds_ids[i]
                right_id = ds_ids[j]
                try:
                    res = self.resolve_join(left_id, right_id)
                    if res.get("joinable"):
                        valid_edges.append(res)
                except Exception as exc:
                    logger.debug(f"Error resolving join {left_id} <-> {right_id}: {exc}")

        self._graph_cache[cache_key] = (now, valid_edges)
        return valid_edges

    def load_joined_dataframe(
        self,
        left_dataset_id: str,
        right_dataset_id: str,
        left_key: str,
        right_key: str,
        how: str = "left",
        columns_to_keep: Optional[List[str]] = None
    ) -> pd.DataFrame:
        """Load and merge two datasets into a single pandas DataFrame."""
        from api.services.dataset_service import dataset_service
        left_entry, left_snapshot = self._get_dataset_entry_and_snapshot(left_dataset_id)
        right_entry, right_snapshot = self._get_dataset_entry_and_snapshot(right_dataset_id)

        if not left_snapshot or not right_snapshot:
            raise ValueError("Failed to load snapshots for joining datasets.")

        left_df = dataset_service._frame(left_snapshot["rows"], left_snapshot["columns"])
        right_df = dataset_service._frame(right_snapshot["rows"], right_snapshot["columns"])

        if left_key not in left_df.columns:
            # Case-insensitive resolution
            matched = next((c for c in left_df.columns if c.lower() == left_key.lower()), None)
            if not matched:
                raise ValueError(f"Key column '{left_key}' not found in left dataset.")
            left_key = matched

        if right_key not in right_df.columns:
            matched = next((c for c in right_df.columns if c.lower() == right_key.lower()), None)
            if not matched:
                raise ValueError(f"Key column '{right_key}' not found in right dataset.")
            right_key = matched

        # Avoid column collisions (except the join key)
        overlapping_cols = [c for c in right_df.columns if c in left_df.columns and c != right_key]
        if overlapping_cols:
            suffix = f"_{self._normalize_name(right_entry.get('name', 'right'))[:6]}"
            right_df = right_df.rename(columns={c: f"{c}{suffix}" for c in overlapping_cols})

        merged = left_df.merge(
            right_df,
            left_on=left_key,
            right_on=right_key,
            how=how
        )
        return merged


join_service = CrossTableJoinService()

