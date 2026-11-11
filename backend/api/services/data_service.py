"""
Data Service for reading KPIs from preprocessed Excel file with session caching.
"""
import os
import re
import pandas as pd
from pathlib import Path
from typing import Dict, Any, List, Optional
from api.utils.logger import get_logger

logger = get_logger("services.data_service")

class CaseInsensitiveRecord(dict):
    """
    A dictionary wrapper enabling access to row fields regardless of casing or formatting
    (e.g., 'RecordName', 'RECORDNAME', 'record_name', 'recordname' all resolve).
    Derives attributes dynamically from data without hardcoded column dictionaries.
    """
    def __init__(self, data=None):
        super().__init__()
        self._lookup = {}
        if data:
            for k, v in dict(data).items():
                self[k] = v

    def _norm(self, key):
        if not isinstance(key, str):
            return key
        return re.sub(r'[\s_\-]+', '', key).lower()

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self._lookup[self._norm(key)] = key

    def __getitem__(self, key):
        if super().__contains__(key):
            return super().__getitem__(key)
        norm = self._norm(key)
        if norm in self._lookup:
            return super().__getitem__(self._lookup[norm])
        raise KeyError(key)

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __contains__(self, key):
        return super().__contains__(key) or self._norm(key) in self._lookup


class DataService:
    """Service to load and cache data from preprocessed Excel file."""
    
    _instance = None
    _cache = None
    _df = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(DataService, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        # Importing a router must not read application data or create cache files.
        pass
    
    def _load_data(self):
        """Load schema sample dynamically from active dataset or SAP HANA Cloud."""
        try:
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = None
            if sel and getattr(sel, "entry", None):
                hint = sel.entry.get("physical_table_name") or sel.entry.get("name")
            target_table = datasets_metadata_repo._resolve_physical_table(hint)
            from api.database.hana_client import hana_client
            rows = hana_client.execute_query(f'SELECT * FROM "{target_table}" LIMIT 100')
            if rows:
                self._df = pd.DataFrame(rows)
                logger.info(f"Schema sample loaded directly from SAP HANA Cloud {target_table}. Shape: {self._df.shape}")
            else:
                self._df = pd.DataFrame()
        except Exception as e:
            logger.error(f"Error loading schema from SAP HANA Cloud: {e}")
            self._df = pd.DataFrame()
    
    def get_dataframe(self) -> pd.DataFrame:
        """Get the dataset dataframe with canonical column naming."""
        from api.services.excel_dataset_service import excel_dataset_service
        current = excel_dataset_service.get_df()
        from api.models.execution_context import current_selection
        if current_selection.get() is not None:
            return current
        if current is not None and not current.empty:
            if current is not self._df:
                self._df = current
                from api.services.schema_service import schema_service
                schema_service.refresh(current)
            return self._df
        if self._df is None or self._df.empty:
            self._load_data()
            if self._df is not None and not self._df.empty:
                from api.services.schema_service import schema_service
                schema_service.refresh(self._df)
        return self._df if self._df is not None else pd.DataFrame()
    
    def _resolve_target_table(self, table_name: Optional[str] = None) -> Optional[str]:
        from api.platform.datasets_metadata_repository import datasets_metadata_repo
        from api.models.execution_context import current_selection
        sel = current_selection.get()
        hint = table_name or (sel.entry.get("physical_table_name") or sel.entry.get("tableName") or sel.entry.get("name") if sel and sel.entry else None)
        return datasets_metadata_repo._resolve_physical_table(hint)

    @staticmethod
    def _quote_ident(name: str) -> str:
        return '"' + str(name).replace('"', '""') + '"'

    def _introspect_hana_table(self, target_table: str) -> Dict[str, List[str]]:
        """Classify a HANA table's columns dynamically without hardcoded column names."""
        from api.database.hana_table_service import hana_table_service
        cols = hana_table_service.get_table_columns(target_table) or []
        measures, dimensions, temporal, identifiers = [], [], [], []
        numeric_types = {"INTEGER", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL", "DOUBLE", "REAL", "FLOAT", "SMALLDECIMAL"}
        date_types = {"DATE", "TIME", "TIMESTAMP", "SECONDDATE"}

        for col in cols:
            name = col.get("name", "")
            dtype = str(col.get("type", "")).upper()
            low = name.lower()
            if not name:
                continue
            is_id = bool(re.search(r"(?:^|_)(?:id|code|key|uuid|guid|num|no)$", low) or re.search(r"[a-z](?:Id|ID|Key|Code|Num|No)$", name))
            is_date = dtype in date_types or (any(t in low for t in ("date", "month", "quarter", "year", "period", "time")) and not any(d in low for d in ("duration", "latency", "uptime")))
            if is_id:
                identifiers.append(name)
            elif is_date:
                temporal.append(name)
            elif dtype in numeric_types:
                measures.append(name)
            else:
                dimensions.append(name)

        return {
            "measures": measures,
            "dimensions": dimensions,
            "temporal": temporal,
            "identifiers": identifiers,
            "all": [c.get("name") for c in cols if c.get("name")],
        }

    def get_kpis(self) -> Dict[str, Any]:
        """Calculate enterprise KPIs dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                nums = df.select_dtypes(include=['number']).columns.tolist()
                measures = [c for c in nums if not re.search(r'(?:^|_)(?:id|code|key)$', c.lower())]
                m1 = measures[0] if measures else (nums[0] if nums else None)
                m2 = measures[1] if len(measures) > 1 else None
                m1_val = round(float(df[m1].sum()), 2) if m1 else 0.0
                m2_val = round(float(df[m2].sum()), 2) if m2 else float(len(df))
                avg_val = round(float(df[m1].mean()), 2) if m1 else 0.0
                cat_cols = df.select_dtypes(include=['object', 'string']).columns.tolist()
                dim_count = int(df[cat_cols[0]].nunique()) if cat_cols else len(df)
                return {
                    "total_revenue": m1_val,
                    "total_quantity": int(m2_val),
                    "avg_margin": avg_val,
                    "country_count": dim_count,
                }
        except Exception as exc:
            logger.debug(f"Dynamic KPI DataFrame check: {exc}")

        try:
            from api.database.hana_client import hana_client
            target_table = self._resolve_target_table()
            if not target_table:
                return {"total_revenue": 0, "total_quantity": 0, "avg_margin": 0, "country_count": 0}
            schema = self._introspect_hana_table(target_table)
            m1 = schema["measures"][0] if schema["measures"] else None
            m2 = schema["measures"][1] if len(schema["measures"]) > 1 else None
            d1 = schema["dimensions"][0] if schema["dimensions"] else (schema["identifiers"][0] if schema["identifiers"] else None)

            m1_expr = f"ROUND(SUM({self._quote_ident(m1)}), 2)" if m1 else "COUNT(*)"
            m2_expr = f"SUM({self._quote_ident(m2)})" if m2 else "COUNT(*)"
            avg_expr = f"ROUND(AVG({self._quote_ident(m1)}), 2)" if m1 else "0"
            d1_expr = f"COUNT(DISTINCT {self._quote_ident(d1)})" if d1 else "COUNT(*)"

            sql = f'SELECT {m1_expr} AS M1, {m2_expr} AS M2, {avg_expr} AS M_AVG, {d1_expr} AS D1 FROM {self._quote_ident(target_table)}'
            rows = hana_client.execute_query(sql)
            if rows:
                r = rows[0]
                return {
                    "total_revenue": float(r.get("M1") or 0),
                    "total_quantity": int(r.get("M2") or 0),
                    "avg_margin": float(r.get("M_AVG") or 0),
                    "country_count": int(r.get("D1") or 0),
                }
        except Exception as e:
            logger.error(f"Error calculating KPIs in SAP HANA Cloud: {e}")
        return {"total_revenue": 0, "total_quantity": 0, "avg_margin": 0, "country_count": 0}

    def get_revenue_trend(self) -> List[Dict[str, Any]]:
        """Get trend dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                date_cols = [c for c in df.columns if any(k in str(c).lower() for k in ["date", "month", "year", "time", "period"])]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                if date_cols and nums:
                    t_col, m_col = date_cols[0], nums[0]
                    second_col = nums[1] if len(nums) > 1 else None
                    agg_dict = {m_col: "sum"}
                    if second_col and second_col != m_col:
                        agg_dict[second_col] = "sum"
                    grouped = df.groupby(t_col).agg(agg_dict).reset_index().head(12)
                    return [{
                        "month": str(r[t_col]),
                        "revenue": round(float(r[m_col]), 2),
                        "profit": round(float(r[second_col]), 2) if (second_col and second_col in r and pd.notna(r[second_col])) else None,
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic trend DataFrame check: {exc}")

        try:
            from api.database.hana_client import hana_client
            target_table = self._resolve_target_table()
            if not target_table:
                return []
            schema = self._introspect_hana_table(target_table)
            t_col = schema["temporal"][0] if schema["temporal"] else (schema["dimensions"][0] if schema["dimensions"] else None)
            m1 = schema["measures"][0] if schema["measures"] else None
            m2 = schema["measures"][1] if len(schema["measures"]) > 1 else None
            if not t_col:
                return []
            t_q = self._quote_ident(t_col)
            m1_expr = f"ROUND(SUM({self._quote_ident(m1)}), 2)" if m1 else "COUNT(*)"
            m2_expr = f", ROUND(SUM({self._quote_ident(m2)}), 2) AS M2" if m2 else ""
            sql = f'SELECT {t_q} AS PERIOD_VAL, {m1_expr} AS M1{m2_expr} FROM {self._quote_ident(target_table)} WHERE {t_q} IS NOT NULL GROUP BY {t_q} ORDER BY {t_q} LIMIT 24'
            rows = hana_client.execute_query(sql)
            if rows:
                return [{
                    "month": str(r.get("PERIOD_VAL")),
                    "revenue": float(r.get("M1") or 0),
                    "profit": float(r.get("M2") or 0) if m2 else None,
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting trend in SAP HANA Cloud: {e}")
        return []

    def _hana_dimension_breakdown(self, dim_index: int = 0, limit: int = 10) -> List[Dict[str, Any]]:
        from api.database.hana_client import hana_client
        target_table = self._resolve_target_table()
        if not target_table:
            return []
        schema = self._introspect_hana_table(target_table)
        dims = schema["dimensions"]
        if not dims:
            return []
        dim = dims[min(dim_index, len(dims) - 1)]
        m1 = schema["measures"][0] if schema["measures"] else None
        dim_q = self._quote_ident(dim)
        m1_expr = f"ROUND(SUM({self._quote_ident(m1)}), 2)" if m1 else "COUNT(*)"
        sql = f'SELECT {dim_q} AS DIM_VAL, {m1_expr} AS MEAS_VAL FROM {self._quote_ident(target_table)} WHERE {dim_q} IS NOT NULL GROUP BY {dim_q} ORDER BY MEAS_VAL DESC LIMIT {int(limit)}'
        return hana_client.execute_query(sql) or []

    def get_region_breakdown(self) -> List[Dict[str, Any]]:
        """Get breakdown by primary dimension dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                dim = cats[0] if cats else None
                meas = nums[0] if nums else None
                if dim and meas:
                    grouped = df.groupby(dim)[meas].sum().reset_index().sort_values(by=meas, ascending=False).head(10)
                    total_val = float(grouped[meas].sum())
                    return [{
                        "region": str(r[dim]),
                        "revenue": round(float(r[meas]), 2),
                        "share": round((float(r[meas]) / total_val * 100.0), 1) if total_val > 0 else 0.0,
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic primary breakdown dataframe check: {exc}")

        try:
            rows = self._hana_dimension_breakdown(dim_index=0, limit=10)
            if rows:
                total_val = sum(float(r.get("MEAS_VAL") or 0) for r in rows)
                return [{
                    "region": str(r.get("DIM_VAL")),
                    "revenue": float(r.get("MEAS_VAL") or 0),
                    "share": round((float(r.get("MEAS_VAL") or 0) / total_val * 100.0), 1) if total_val > 0 else 0.0,
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting primary breakdown in SAP HANA Cloud: {e}")
        return []

    def get_country_breakdown(self) -> List[Dict[str, Any]]:
        """Get breakdown by secondary dimension dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                dim = cats[1] if len(cats) > 1 else (cats[0] if cats else None)
                meas = nums[0] if nums else None
                if dim and meas:
                    grouped = df.groupby(dim)[meas].sum().reset_index().sort_values(by=meas, ascending=False).head(10)
                    return [{"country": str(r[dim]), "revenue": round(float(r[meas]), 2)} for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic secondary breakdown dataframe check: {exc}")

        try:
            rows = self._hana_dimension_breakdown(dim_index=1, limit=10)
            if rows:
                return [{"country": str(r.get("DIM_VAL")), "revenue": float(r.get("MEAS_VAL") or 0)} for r in rows]
        except Exception as e:
            logger.error(f"Error getting secondary breakdown in SAP HANA Cloud: {e}")
        return []

    def get_category_breakdown(self) -> List[Dict[str, Any]]:
        """Get tertiary dimension breakdown dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                if cats and nums:
                    cat_col = cats[2] if len(cats) > 2 else cats[0]
                    m_col = nums[0]
                    grouped = df.groupby(cat_col)[m_col].sum().reset_index().sort_values(by=m_col, ascending=False).head(8)
                    return [{"category": str(r[cat_col]), "revenue": round(float(r[m_col]), 2)} for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic tertiary breakdown check: {exc}")

        try:
            rows = self._hana_dimension_breakdown(dim_index=2, limit=8)
            if rows:
                return [{"category": str(r.get("DIM_VAL")), "revenue": float(r.get("MEAS_VAL") or 0)} for r in rows]
        except Exception as e:
            logger.error(f"Error getting tertiary breakdown in SAP HANA Cloud: {e}")
        return []

    def get_quarterly_performance(self) -> List[Dict[str, Any]]:
        """Get periodic performance dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                q_cols = [c for c in df.columns if any(k in str(c).lower() for k in ["quarter", "qtr", "period", "month", "year", "date"])]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                if q_cols and nums:
                    t_col, m_col = q_cols[0], nums[0]
                    grouped = df.groupby(t_col)[m_col].sum().reset_index().head(8)
                    return [{
                        "quarter_label": str(r[t_col]),
                        "actual": round(float(r[m_col]), 2),
                        "target": round(float(r[m_col]) * 0.9, 0),
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic periodic performance fallback: {exc}")

        try:
            from api.database.hana_client import hana_client
            target_table = self._resolve_target_table()
            if not target_table:
                return []
            schema = self._introspect_hana_table(target_table)
            t_col = schema["temporal"][0] if schema["temporal"] else None
            m1 = schema["measures"][0] if schema["measures"] else None
            if not t_col:
                return []
            t_q = self._quote_ident(t_col)
            m1_expr = f"ROUND(SUM({self._quote_ident(m1)}), 2)" if m1 else "COUNT(*)"
            sql = f'SELECT {t_q} AS P_LABEL, {m1_expr} AS ACTUAL FROM {self._quote_ident(target_table)} WHERE {t_q} IS NOT NULL GROUP BY {t_q} ORDER BY {t_q} LIMIT 8'
            rows = hana_client.execute_query(sql)
            if rows:
                return [{
                    "quarter_label": str(r.get("P_LABEL")),
                    "actual": float(r.get("ACTUAL") or 0),
                    "target": round(float(r.get("ACTUAL") or 0) * 0.9, 0),
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting periodic performance in SAP HANA Cloud: {e}")
        return []

    def get_top_products(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Get top entities/items dynamically from active dataset or SAP HANA Cloud."""
        lim = limit or 10
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                if cats and nums:
                    cat_col, m_col = cats[0], nums[0]
                    u_col = nums[1] if len(nums) > 1 else None
                    grouped = df.groupby(cat_col)[m_col].sum().reset_index().sort_values(by=m_col, ascending=False).head(lim)
                    return [{
                        "product": str(r[cat_col]),
                        "units": int(df[df[cat_col] == r[cat_col]][u_col].sum()) if u_col else int(len(df[df[cat_col] == r[cat_col]])),
                        "revenue": round(float(r[m_col]), 2),
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic top items fallback: {exc}")

        try:
            from api.database.hana_client import hana_client
            target_table = self._resolve_target_table()
            if not target_table:
                return []
            schema = self._introspect_hana_table(target_table)
            d1 = schema["dimensions"][0] if schema["dimensions"] else (schema["identifiers"][0] if schema["identifiers"] else None)
            if not d1:
                return []
            m1 = schema["measures"][0] if schema["measures"] else None
            m2 = schema["measures"][1] if len(schema["measures"]) > 1 else None
            d1_q = self._quote_ident(d1)
            m1_expr = f"ROUND(SUM({self._quote_ident(m1)}), 2)" if m1 else "COUNT(*)"
            m2_expr = f"SUM({self._quote_ident(m2)})" if m2 else "COUNT(*)"
            sql = f'SELECT {d1_q} AS ITEM_NAME, {m2_expr} AS UNITS, {m1_expr} AS VAL FROM {self._quote_ident(target_table)} WHERE {d1_q} IS NOT NULL GROUP BY {d1_q} ORDER BY VAL DESC LIMIT {int(lim)}'
            rows = hana_client.execute_query(sql)
            if rows:
                return [{
                    "product": str(r.get("ITEM_NAME")),
                    "units": int(r.get("UNITS") or 0),
                    "revenue": float(r.get("VAL") or 0),
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting top items in SAP HANA Cloud: {e}")
        return []

    def get_order_ids(self, limit: int = 100) -> List[str]:
        """Get list of primary entity/record IDs dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                id_cols = [c for c in df.columns if any(term in str(c).lower() for term in ["id", "code", "key", "num", "number", "ref"])]
                if not id_cols:
                    id_cols = [c for c in df.columns if str(df[c].dtype) == "object"]
                if id_cols:
                    col = id_cols[0]
                    return [str(x) for x in df[col].dropna().unique()[:limit]]
        except Exception as exc:
            logger.debug(f"Dynamic ID lookup from DataFrame: {exc}")

        try:
            from api.database.hana_client import hana_client
            target_table = self._resolve_target_table()
            if not target_table:
                return []
            schema = self._introspect_hana_table(target_table)
            id_col = schema["identifiers"][0] if schema["identifiers"] else (schema["dimensions"][0] if schema["dimensions"] else None)
            if not id_col:
                return []
            id_q = self._quote_ident(id_col)
            sql = f'SELECT DISTINCT {id_q} AS REC_ID FROM {self._quote_ident(target_table)} WHERE {id_q} IS NOT NULL LIMIT {int(limit)}'
            rows = hana_client.execute_query(sql)
            if rows:
                return [str(r.get("REC_ID")) for r in rows if r.get("REC_ID") is not None]
        except Exception as e:
            logger.error(f"Error getting record IDs in SAP HANA Cloud: {e}")
        return []

    def get_order_details(self, order_id: str) -> Optional[Dict[str, Any]]:
        """Backwards-compatible wrapper for get_record_details."""
        return self.get_record_details(order_id)

    def _lookup_record_in_table(self, table_name: str, clean_id: str) -> Optional[CaseInsensitiveRecord]:
        from api.database.hana_client import hana_client
        schema = self._introspect_hana_table(table_name)
        candidate_columns = schema["identifiers"] or schema["dimensions"][:3]
        tbl_q = self._quote_ident(table_name)
        if not candidate_columns:
            # Fallback when metadata catalog is unavailable: sample 1 row to discover keys dynamically
            try:
                sample = hana_client.execute_query(f"SELECT * FROM {tbl_q} LIMIT 1")
                if sample and isinstance(sample[0], dict):
                    keys = [str(k) for k in sample[0].keys()]
                    id_terms = ("id", "code", "key", "num", "number", "tag", "ref")
                    candidate_columns = [k for k in keys if any(t in k.lower() for t in id_terms)]
                    if not candidate_columns:
                        candidate_columns = [k for k in keys if isinstance(sample[0].get(k), str)][:3]
            except Exception:
                return None
        if not candidate_columns:
            return None
        for col in candidate_columns:
            try:
                col_q = self._quote_ident(col)
                sql = f'SELECT * FROM {tbl_q} WHERE UPPER(CAST({col_q} AS NVARCHAR)) = UPPER(?) LIMIT 1'
                rows = hana_client.execute_query(sql, (clean_id,))
                if rows:
                    return CaseInsensitiveRecord(rows[0])
            except Exception:
                continue
        num_part = re.sub(r'^[A-Za-z]+[-_]?', '', clean_id)
        if num_part and len(num_part) >= 3:
            for col in candidate_columns[:2]:
                try:
                    col_q = self._quote_ident(col)
                    sql_like = f'SELECT * FROM {tbl_q} WHERE CAST({col_q} AS NVARCHAR) LIKE ? LIMIT 1'
                    rows = hana_client.execute_query(sql_like, (f"%{num_part}%",))
                    if rows:
                        return CaseInsensitiveRecord(rows[0])
                except Exception:
                    continue
        return None

    def get_record_details(self, record_id: str, table_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Get details for any record ID dynamically from active DataFrame or SAP HANA Cloud tables."""
        clean_id = str(record_id).strip()
        if not clean_id:
            return None

        # 1. First, check active in-memory DataFrame
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                id_cols = [c for c in df.columns if any(term in str(c).lower() for term in ["id", "code", "key", "num", "number", "tag", "ref"])]
                if not id_cols:
                    id_cols = [c for c in df.columns if str(df[c].dtype) == "object"]
                for col in id_cols:
                    matches = df[df[col].astype(str).str.strip().str.upper() == clean_id.upper()]
                    if not matches.empty:
                        return CaseInsensitiveRecord(matches.iloc[0].to_dict())
        except Exception as e:
            logger.debug(f"DataFrame record lookup skipped ({e})")

        # 2. Query active SAP HANA Cloud table using introspected columns
        target = None
        try:
            target = self._resolve_target_table(table_name)
            if target:
                rec = self._lookup_record_in_table(target, clean_id)
                if rec:
                    return rec
        except Exception as e:
            logger.warning(f"Direct HANA record lookup failed ({e})")

        # 3. Cross-Table Discovery: Check all available datasets in workspace catalog
        try:
            from api.services.dataset_service import dataset_service
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            catalog = dataset_service._catalog()
            for d_id, entry in catalog.get("datasets", {}).items():
                other_hint = entry.get("physical_table_name") or entry.get("tableName") or entry.get("name")
                other_target = datasets_metadata_repo._resolve_physical_table(other_hint)
                if not other_target or other_target == target:
                    continue
                rec = self._lookup_record_in_table(other_target, clean_id)
                if rec:
                    logger.info(f"Resolved record {clean_id} from alternate table '{other_target}' (dataset '{d_id}')")
                    rec["_resolved_table"] = other_target
                    rec["_resolved_dataset_id"] = d_id
                    rec["_resolved_dataset_name"] = entry.get("name")
                    return rec
        except Exception as e:
            logger.debug(f"Cross-table record fallback search failed: {e}")

        return None


# Singleton instance
data_service = DataService()
