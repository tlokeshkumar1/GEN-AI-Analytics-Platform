"""Dedicated HANA repository for DATASETS_METADATA.

Keeps dataset file catalogs, versions, schema revisions, and ingestion provenance
cleanly separated from PLATFORM_METADATA (which handles execution dashboard data,
credentials, and connections).
"""

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, List

from api.utils.logger import get_logger

logger = get_logger("platform.datasets_metadata")


class DatasetsMetadataRepository:
    def __init__(self, workspace_id: Optional[str] = None):
        self.workspace_id = workspace_id or os.getenv(
            "PLATFORM_WORKSPACE_ID", "default"
        )
        self._cached_catalog: Optional[Dict[str, Any]] = None
        self._cached_catalog_time: float = 0.0
        self._ttl_seconds: float = 60.0
        self._cached_schema: Dict[str, List[Dict[str, Any]]] = {}
        self._cached_hana_tables: Optional[Dict[str, int]] = None
        self._cached_hana_tables_time: float = 0.0

    def invalidate_cache(self):
        self._cached_catalog = None
        self._cached_catalog_time = 0.0
        self._cached_hana_tables = None
        self._cached_hana_tables_time = 0.0
        self._cached_schema.clear()

    def _client(self):
        try:
            from api.database.hana_client import hana_client

            return hana_client
        except Exception as exc:
            logger.warning(f"HANA client unavailable for datasets_metadata: {exc}")
            return None

    def is_available(self) -> bool:
        client = self._client()
        if not client:
            return False
        try:
            client.execute_query("SELECT 1 FROM DATASETS_METADATA LIMIT 1")
            return True
        except Exception:
            return False

    def get_catalog(
        self, seed_fallback_path: Optional[Path] = None, force_refresh: bool = False
    ) -> Optional[Dict[str, Any]]:
        now = time.time()
        if (
            not force_refresh
            and self._cached_catalog is not None
            and (now - self._cached_catalog_time) < self._ttl_seconds
        ):
            return self._cached_catalog

        client = self._client()
        if not client:
            return None

        try:
            sql = """
                SELECT WORKSPACE_ID, DATASET_ID, NAME, FOLDER, CURRENT_VERSION,
                       IS_ACTIVE, OWNER_ID, REVISION, VERSIONS_JSON, METADATA_JSON, UPDATED_AT
                FROM DATASETS_METADATA
                WHERE WORKSPACE_ID = ?
                ORDER BY UPDATED_AT DESC
            """
            rows = client.execute_query(sql, (self.workspace_id,))
            if not rows and seed_fallback_path and seed_fallback_path.exists():
                logger.info(
                    f"DATASETS_METADATA is empty. Seeding from {seed_fallback_path.name}..."
                )
                seed_data = json.loads(seed_fallback_path.read_text(encoding="utf-8"))
                self.save_catalog(seed_data)
                rows = client.execute_query(sql, (self.workspace_id,))

            if not rows:
                return None

            datasets: Dict[str, Any] = {}
            active_id = None
            imported_files: List[str] = []

            for row in rows:
                d_id = str(row.get("DATASET_ID") or "")
                if d_id == "__catalog__":
                    # Special record for catalog-wide metadata
                    meta_raw = row.get("METADATA_JSON")
                    if meta_raw:
                        meta = (
                            json.loads(meta_raw)
                            if isinstance(meta_raw, str)
                            else meta_raw
                        )
                        imported_files = meta.get("importedFiles", [])
                    continue
                if d_id.startswith("__"):
                    # System metadata record (e.g. __project_sessions__) - exclude from public datasets
                    continue

                versions_raw = row.get("VERSIONS_JSON")
                versions = (
                    json.loads(versions_raw)
                    if isinstance(versions_raw, str)
                    else (versions_raw or [])
                )

                meta_raw = row.get("METADATA_JSON")
                meta = (
                    json.loads(meta_raw)
                    if isinstance(meta_raw, str)
                    else (meta_raw or {})
                )

                is_active = bool(row.get("IS_ACTIVE"))
                if is_active:
                    active_id = d_id

                updated_at = row.get("UPDATED_AT")
                if isinstance(updated_at, datetime):
                    updated_at_str = updated_at.isoformat()
                else:
                    updated_at_str = str(updated_at or "")

                entry = {
                    "id": d_id,
                    "name": row.get("NAME"),
                    "folder": row.get("FOLDER") or d_id,
                    "currentVersion": int(row.get("CURRENT_VERSION") or 1),
                    "workspaceId": row.get("WORKSPACE_ID") or self.workspace_id,
                    "ownerId": row.get("OWNER_ID"),
                    "readers": meta.get("readers", ["*"]),
                    "writers": meta.get("writers", []),
                    "tableName": meta.get("tableName") or meta.get("table_name"),
                    "table_name": meta.get("table_name") or meta.get("tableName"),
                    "displayName": meta.get("displayName") or meta.get("display_name"),
                    "display_name": meta.get("display_name") or meta.get("displayName"),
                    "sheetName": meta.get("sheetName") or meta.get("sheet_name"),
                    "sheet_name": meta.get("sheet_name") or meta.get("sheetName"),
                    "sourceFilename": meta.get("sourceFilename")
                    or meta.get("source_filename")
                    or meta.get("sourceFile"),
                    "sourceFile": meta.get("sourceFile")
                    or meta.get("sourceFilename")
                    or meta.get("source_filename"),
                    "tableManagedByUpload": meta.get("tableManagedByUpload", False),
                    "ingestionStatus": meta.get("ingestionStatus"),
                    "cloudTable": meta.get("cloudTable"),
                    "preprocessingAudit": meta.get("preprocessingAudit"),
                    "domain": meta.get("domain"),
                    "versions": versions,
                    "updatedAt": updated_at_str,
                }
                datasets[d_id] = entry

            if not active_id and datasets:
                active_id = next(iter(datasets.keys()))

            result = {
                "datasets": datasets,
                "activeDatasetId": active_id,
                "importedFiles": imported_files,
            }
            self._cached_catalog = result
            self._cached_catalog_time = time.time()
            return result
        except Exception as exc:
            logger.error(f"Failed to read catalog from DATASETS_METADATA: {exc}")
            return None

    def save_catalog(self, catalog: Dict[str, Any]) -> bool:
        self.invalidate_cache()
        client = self._client()
        if not client:
            return False

        try:
            catalog.get("activeDatasetId")
            datasets = catalog.get("datasets", {})

            # Upsert each dataset
            for d_id, entry in datasets.items():
                is_active = True
                table_name = entry.get("tableName") or entry.get("table_name")
                display_name = entry.get("displayName") or entry.get("display_name")
                sheet_name = entry.get("sheetName") or entry.get("sheet_name")
                source_file = (
                    entry.get("sourceFile")
                    or entry.get("sourceFilename")
                    or entry.get("source_filename")
                )

                meta = {
                    "readers": entry.get("readers", ["*"]),
                    "writers": entry.get("writers", []),
                    "tableName": table_name,
                    "table_name": table_name,
                    "displayName": display_name,
                    "display_name": display_name,
                    "sheetName": sheet_name,
                    "sheet_name": sheet_name,
                    "sourceFilename": source_file,
                    "sourceFile": source_file,
                    "tableManagedByUpload": entry.get("tableManagedByUpload", False),
                    "ingestionStatus": entry.get("ingestionStatus"),
                    "cloudTable": entry.get("cloudTable"),
                    "preprocessingAudit": entry.get("preprocessingAudit"),
                    "domain": entry.get("domain"),
                }
                versions_json = json.dumps(
                    entry.get("versions", []), ensure_ascii=False
                )
                metadata_json = json.dumps(meta, ensure_ascii=False)

                # Persist clean name: prefer clean display_name or table_name over raw filename
                persisted_name = display_name or table_name or entry.get("name", d_id)

                sql = """
                    UPSERT DATASETS_METADATA (
                        WORKSPACE_ID, DATASET_ID, NAME, FOLDER, CURRENT_VERSION,
                        IS_ACTIVE, OWNER_ID, VERSIONS_JSON, METADATA_JSON, UPDATED_AT
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    WITH PRIMARY KEY
                """
                client.execute_query(
                    sql,
                    (
                        self.workspace_id,
                        d_id,
                        persisted_name,
                        entry.get("folder", d_id),
                        int(entry.get("currentVersion", 1)),
                        is_active,
                        entry.get("ownerId"),
                        versions_json,
                        metadata_json,
                    ),
                )

            # Store catalog-wide metadata (__catalog__)
            catalog_meta = json.dumps(
                {"importedFiles": catalog.get("importedFiles", [])}, ensure_ascii=False
            )
            catalog_sql = """
                UPSERT DATASETS_METADATA (
                    WORKSPACE_ID, DATASET_ID, NAME, FOLDER, CURRENT_VERSION,
                    IS_ACTIVE, OWNER_ID, VERSIONS_JSON, METADATA_JSON, UPDATED_AT
                ) VALUES (?, '__catalog__', 'Catalog Metadata', '', 1, FALSE, NULL, '[]', ?, CURRENT_TIMESTAMP)
                WITH PRIMARY KEY
            """
            client.execute_query(catalog_sql, (self.workspace_id, catalog_meta))

            # Delete any dataset rows removed from catalog (protect internal system records starting with __)
            current_ids = set(datasets.keys())
            current_ids.add("__catalog__")
            existing_rows = client.execute_query(
                "SELECT DATASET_ID FROM DATASETS_METADATA WHERE WORKSPACE_ID = ?",
                (self.workspace_id,),
            )
            for row in existing_rows:
                row_id = str(row.get("DATASET_ID") or "")
                if row_id and not row_id.startswith("__") and row_id not in current_ids:
                    client.execute_query(
                        "DELETE FROM DATASETS_METADATA WHERE WORKSPACE_ID = ? AND DATASET_ID = ?",
                        (self.workspace_id, row_id),
                    )

            logger.info(
                f"Successfully saved {len(datasets)} datasets to HANA DATASETS_METADATA"
            )
            return True
        except Exception as exc:
            logger.error(f"Failed to save catalog to DATASETS_METADATA: {exc}")
            return False

    def delete_dataset(self, dataset_id: str) -> bool:
        """Explicitly purge a dataset registration from DATASETS_METADATA."""
        if str(dataset_id).startswith("__"):
            logger.warning(
                f"Blocked deletion of protected system record '{dataset_id}'"
            )
            return False
        self.invalidate_cache()
        client = self._client()
        if not client:
            return False
        try:
            sql = "DELETE FROM DATASETS_METADATA WHERE WORKSPACE_ID = ? AND DATASET_ID = ?"
            client.execute_query(sql, (self.workspace_id, dataset_id))
            logger.info(
                f"Purged dataset '{dataset_id}' from DATASETS_METADATA for workspace '{self.workspace_id}'"
            )
            return True
        except Exception as exc:
            logger.error(
                f"Failed to delete dataset '{dataset_id}' from DATASETS_METADATA: {exc}"
            )
            return False

    def _list_hana_tables(self) -> Dict[str, int]:
        now = time.time()
        if (
            self._cached_hana_tables is not None
            and (now - self._cached_hana_tables_time) < 30.0
        ):
            return self._cached_hana_tables

        client = self._client()
        if not client:
            return {}

        system_tables = {
            "DATASETS_METADATA",
            "PLATFORM_METADATA",
            "VECTOR_TABLE",
            "CHAT_MESSAGES",
            "CHAT_SESSIONS",
        }
        hana_tables: Dict[str, int] = {}
        try:
            raw_tables = client.execute_query(
                "SELECT TABLE_NAME, RECORD_COUNT FROM SYS.M_TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA"
            )
            for r in raw_tables:
                t_name = str(r.get("TABLE_NAME", "")).upper()
                if t_name and t_name not in system_tables:
                    hana_tables[t_name] = int(r.get("RECORD_COUNT") or 0)
        except Exception:
            try:
                raw_tables = client.execute_query(
                    "SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA"
                )
                for r in raw_tables:
                    t_name = str(r.get("TABLE_NAME", "")).upper()
                    if t_name and t_name not in system_tables:
                        hana_tables[t_name] = 1
            except Exception as e:
                logger.warning(f"Failed to query HANA table catalog: {e}")

        if hana_tables:
            self._cached_hana_tables = hana_tables
            self._cached_hana_tables_time = now
        return hana_tables

    def get_table_record_count(self, table_name: str) -> Optional[int]:
        hana_tables = self._list_hana_tables()
        return hana_tables.get(str(table_name or "").upper())

    def _resolve_physical_table(self, table_name: Optional[str] = None) -> str:
        """Dynamically resolve the existing physical table directly from SAP HANA Cloud catalog."""
        hana_tables = self._list_hana_tables()

        # 2. Extract potential table name hints from input and current execution selection
        candidates: List[str] = []
        if table_name:
            clean_t = (
                str(table_name)
                .split(".")[0]
                .strip()
                .replace(" ", "_")
                .replace("-", "_")
                .upper()
            )
            candidates.extend([clean_t, str(table_name).upper()])

        try:
            from api.models.execution_context import current_selection

            sel = current_selection.get()
            if not table_name and sel and getattr(sel, "entry", None):
                entry = sel.entry
                for key in ("physical_table_name", "tableName", "table_name"):
                    if entry.get(key):
                        candidates.append(str(entry[key]).upper())
                if entry.get("folder"):
                    candidates.append(
                        str(entry["folder"])
                        .split(".")[0]
                        .strip()
                        .replace(" ", "_")
                        .replace("-", "_")
                        .upper()
                    )
                if entry.get("name"):
                    stem = (
                        str(entry["name"])
                        .split(".")[0]
                        .strip()
                        .replace(" ", "_")
                        .replace("-", "_")
                        .upper()
                    )
                    candidates.extend([stem, f"DS_{stem[:18]}"])
        except Exception:
            pass

        # 3. Match candidates against actual HANA tables (prefer tables with records > 0)
        for c in candidates:
            c_clean = c.replace('"', "").strip()
            if c_clean in hana_tables and hana_tables[c_clean] > 0:
                return c_clean

        for c in candidates:
            c_clean = c.replace('"', "").strip()
            if c_clean in hana_tables:
                return c_clean

        raise ValueError(
            "No exact HANA table mapping exists for the selected dataset. Reconcile its metadata before use."
        )

    def load_schema_from_hana(
        self, table_name: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Fast schema lookup from HANA Cloud (under 20ms) without transferring 20,000 rows."""
        resolved_table = self._resolve_physical_table(table_name)
        if resolved_table in self._cached_schema:
            return self._cached_schema[resolved_table]

        client = self._client()
        if not client:
            return []

        try:
            physical = client.execute_query(
                "SELECT COLUMN_NAME, DATA_TYPE_NAME FROM SYS.TABLE_COLUMNS "
                "WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ? ORDER BY POSITION",
                (resolved_table,),
            )
            if physical and all(
                "COLUMN_NAME" in c and "DATA_TYPE_NAME" in c for c in physical
            ):
                types = {
                    "TINYINT": "number",
                    "SMALLINT": "number",
                    "INTEGER": "number",
                    "BIGINT": "number",
                    "DECIMAL": "decimal",
                    "SMALLDECIMAL": "decimal",
                    "REAL": "decimal",
                    "DOUBLE": "decimal",
                    "DATE": "date",
                    "TIMESTAMP": "date",
                    "SECONDDATE": "date",
                    "BOOLEAN": "boolean",
                }
                columns = [
                    {
                        "name": c["COLUMN_NAME"],
                        "type": types.get(c["DATA_TYPE_NAME"].upper(), "string"),
                        "required": False,
                    }
                    for c in physical
                ]
                self._cached_schema[resolved_table] = columns
                return columns
            sample = client.execute_query(f'SELECT TOP 1 * FROM "{resolved_table}"')
            if not sample:
                return []

            columns = []
            for col_name, val in sample[0].items():
                from decimal import Decimal
                from datetime import date

                col_type = (
                    "boolean"
                    if isinstance(val, bool)
                    else "decimal"
                    if isinstance(val, Decimal)
                    else "date"
                    if isinstance(val, (date, datetime))
                    else "number"
                    if isinstance(val, (int, float))
                    else "string"
                )
                columns.append({"name": col_name, "type": col_type, "required": False})

            self._cached_schema[resolved_table] = columns
            return columns
        except Exception as exc:
            logger.error(f"Failed to load schema from HANA {resolved_table}: {exc}")
            return []

    def load_rows_from_hana(
        self, table_name: Optional[str] = None
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Fetch rows and build column schema directly from SAP HANA Cloud table."""
        resolved_table = self._resolve_physical_table(table_name)
        client = self._client()
        if not client:
            return [], []

        try:
            rows = client.execute_query(f'SELECT * FROM "{resolved_table}"')
            if not rows:
                return [], []

            sample = rows[0]
            columns = []
            for col_name, val in sample.items():
                col_type = "number" if isinstance(val, (int, float)) else "string"
                columns.append({"name": col_name, "type": col_type, "required": False})

            # Dynamically detect best identifier column for frontend row keys
            sample_keys = [str(k) for k in sample.keys()]
            id_key = next(
                (k for k in sample_keys if k.lower() in ("id", "row_id")), None
            )
            if not id_key:
                id_key = next(
                    (
                        k
                        for k in sample_keys
                        if k.lower().endswith(("_id", "id", "_key", "_code"))
                    ),
                    None,
                )

            # Ensure every row has __rowId for frontend tables
            for idx, r in enumerate(rows):
                if "__rowId" not in r:
                    row_val = r.get(id_key) if id_key else None
                    r["__rowId"] = str(
                        row_val
                        if row_val not in (None, "")
                        else (r.get("id") or f"row_{idx}")
                    )

            return rows, columns
        except Exception as exc:
            logger.error(
                f"Failed to load dataset rows from HANA {resolved_table}: {exc}"
            )
            return [], []


datasets_metadata_repo = DatasetsMetadataRepository()
