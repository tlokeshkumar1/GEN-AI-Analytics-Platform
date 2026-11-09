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
    (e.g., 'ProductName', 'PRODUCTNAME', 'product_name', 'productname' all resolve).
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
    
    def get_kpis(self) -> Dict[str, Any]:
        """Calculate enterprise KPIs dynamically from active dataset or SAP HANA Cloud."""
        try:
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            if selection:
                df = self.get_dataframe()
                if df is not None and not df.empty:
                    nums = df.select_dtypes(include=['number']).columns.tolist()
                    measures = [c for c in nums if not c.lower().endswith(('id', 'code', 'key'))]
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
                        "country_count": dim_count
                    }
        except Exception as exc:
            logger.debug(f"Dynamic KPI fallback check: {exc}")

        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)

            sql = f'''
                SELECT 
                    ROUND(SUM(NETREVENUEUSD), 2) AS TOTAL_REVENUE,
                    SUM(QUANTITY) AS TOTAL_QUANTITY,
                    ROUND(SUM(GROSSMARGINUSD) * 100.0 / NULLIF(SUM(NETREVENUEUSD), 0), 2) AS AVG_MARGIN,
                    COUNT(DISTINCT COUNTRY) AS COUNTRY_COUNT
                FROM "{target_table}"
            '''
            rows = hana_client.execute_query(sql)
            if rows:
                r = rows[0]
                return {
                    "total_revenue": float(r.get("TOTAL_REVENUE") or 0),
                    "total_quantity": int(r.get("TOTAL_QUANTITY") or 0),
                    "avg_margin": float(r.get("AVG_MARGIN") or 0),
                    "country_count": int(r.get("COUNTRY_COUNT") or 0)
                }
        except Exception as e:
            logger.error(f"Error calculating KPIs in SAP HANA Cloud: {e}")
        return {
            "total_revenue": 0,
            "total_quantity": 0,
            "avg_margin": 0,
            "country_count": 0
        }
    
    def get_revenue_trend(self) -> List[Dict[str, Any]]:
        """Get trend dynamically from active dataset or SAP HANA Cloud."""
        try:
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            if selection:
                df = self.get_dataframe()
                if df is not None and not df.empty:
                    date_cols = [c for c in df.columns if any(k in c.lower() for k in ["date", "month", "year", "time", "period"])]
                    nums = [c for c in df.select_dtypes(include=['number']).columns if not c.lower().endswith(('id', 'code', 'key'))]
                    if date_cols and nums:
                        t_col, m_col = date_cols[0], nums[0]
                        profit_col = next((c for c in nums if any(k in c.lower() for k in ["profit", "margin", "grossmargin", "gain"])), None)
                        agg_dict = {m_col: "sum"}
                        if profit_col and profit_col != m_col:
                            agg_dict[profit_col] = "sum"
                        grouped = df.groupby(t_col).agg(agg_dict).reset_index().head(12)
                        return [{
                            "month": str(r[t_col]),
                            "revenue": round(float(r[m_col]), 2),
                            "profit": round(float(r[profit_col]), 2) if (profit_col and profit_col in r and pd.notna(r[profit_col])) else None
                        } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic trend fallback check: {exc}")

        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)
            sql = f'''
                SELECT YEAR, MONTHNUM, MONTHLABEL,
                       ROUND(SUM(NETREVENUEUSD), 2) AS REVENUE,
                       ROUND(SUM(GROSSMARGINUSD), 2) AS PROFIT
                FROM "{target_table}"
                GROUP BY YEAR, MONTHNUM, MONTHLABEL
                ORDER BY YEAR, MONTHNUM
            '''
            rows = hana_client.execute_query(sql)
            if rows:
                return [{
                    "month": str(r.get("MONTHLABEL") or f"{r.get('YEAR')}-{r.get('MONTHNUM')}"),
                    "revenue": float(r.get("REVENUE") or 0),
                    "profit": float(r.get("PROFIT") or 0)
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting revenue trend in SAP HANA Cloud: {e}")
        return []
    
    def get_region_breakdown(self) -> List[Dict[str, Any]]:
        """Get breakdown by primary dimension dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not c.lower().endswith(('id', 'code', 'key'))]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not c.lower().endswith(('id', 'code', 'key'))]
                # Look specifically for region/category/department
                preferred_cats = [c for c in cats if any(term in c.lower() for term in ["region", "department", "category", "division", "segment"])]
                dim = preferred_cats[0] if preferred_cats else (cats[0] if cats else None)
                meas = nums[0] if nums else None
                if dim and meas:
                    grouped = df.groupby(dim)[meas].sum().reset_index().sort_values(by=meas, ascending=False).head(10)
                    total_val = float(grouped[meas].sum())
                    return [{
                        "region": str(r[dim]),
                        "revenue": round(float(r[meas]), 2),
                        "share": round((float(r[meas]) / total_val * 100.0), 1) if total_val > 0 else 0.0
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic region dataframe check: {exc}")

        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)

            sql = f'''
                SELECT REGION, ROUND(SUM(NETREVENUEUSD), 2) AS REVENUE
                FROM "{target_table}"
                WHERE REGION IS NOT NULL
                GROUP BY REGION
                ORDER BY REVENUE DESC
            '''
            rows = hana_client.execute_query(sql)
            if rows:
                total_revenue = sum(float(r.get("REVENUE") or 0) for r in rows)
                result = []
                for r in rows:
                    rev = float(r.get("REVENUE") or 0)
                    share = (rev / total_revenue * 100.0) if total_revenue > 0 else 0.0
                    result.append({
                        "region": str(r.get("REGION")),
                        "revenue": rev,
                        "share": round(share, 1)
                    })
                return result
        except Exception as e:
            logger.error(f"Error getting region breakdown in SAP HANA Cloud: {e}")
        return []
    
    def get_country_breakdown(self) -> List[Dict[str, Any]]:
        """Get breakdown by secondary dimension dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not c.lower().endswith(('id', 'code', 'key'))]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not c.lower().endswith(('id', 'code', 'key'))]
                preferred_cats = [c for c in cats if any(term in c.lower() for term in ["country", "state", "city", "location", "origin", "branch"])]
                dim = preferred_cats[0] if preferred_cats else (cats[1] if len(cats) > 1 else (cats[0] if cats else None))
                meas = nums[0] if nums else None
                if dim and meas:
                    grouped = df.groupby(dim)[meas].sum().reset_index().sort_values(by=meas, ascending=False).head(10)
                    return [{
                        "country": str(r[dim]),
                        "revenue": round(float(r[meas]), 2)
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic country dataframe check: {exc}")

        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)

            sql = f'''
                SELECT COUNTRY, ROUND(SUM(NETREVENUEUSD), 2) AS REVENUE
                FROM "{target_table}"
                WHERE COUNTRY IS NOT NULL
                GROUP BY COUNTRY
                ORDER BY REVENUE DESC
                LIMIT 10
            '''
            rows = hana_client.execute_query(sql)
            if rows:
                return [{
                    "country": str(r.get("COUNTRY")),
                    "revenue": float(r.get("REVENUE") or 0)
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting country breakdown in SAP HANA Cloud: {e}")
        return []
    
    def get_category_breakdown(self) -> List[Dict[str, Any]]:
        """Get category breakdown dynamically from active dataset or SAP HANA Cloud."""
        try:
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            if selection:
                df = self.get_dataframe()
                if df is not None and not df.empty:
                    cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not c.lower().endswith(('id', 'code', 'key'))]
                    nums = [c for c in df.select_dtypes(include=['number']).columns if not c.lower().endswith(('id', 'code', 'key'))]
                    if cats and nums:
                        cat_col, m_col = cats[0], nums[0]
                        grouped = df.groupby(cat_col)[m_col].sum().reset_index().sort_values(by=m_col, ascending=False).head(8)
                        return [{
                            "category": str(r[cat_col]),
                            "revenue": round(float(r[m_col]), 2)
                        } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic category fallback check: {exc}")

        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)

            sql = f'''
                SELECT CATEGORY, ROUND(SUM(NETREVENUEUSD), 2) AS REVENUE
                FROM "{target_table}"
                WHERE CATEGORY IS NOT NULL
                GROUP BY CATEGORY
                ORDER BY REVENUE DESC
            '''
            rows = hana_client.execute_query(sql)
            if rows:
                return [{
                    "category": str(r.get("CATEGORY")),
                    "revenue": float(r.get("REVENUE") or 0)
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting category breakdown in SAP HANA Cloud: {e}")
        return []
    
    def get_quarterly_performance(self) -> List[Dict[str, Any]]:
        """Get quarterly performance dynamically from active dataset or SAP HANA Cloud."""
        try:
            df = self.get_dataframe()
            if df is not None and not df.empty:
                q_cols = [c for c in df.columns if any(k in str(c).lower() for k in ["quarter", "qtr", "period", "month", "year"])]
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                if q_cols and nums:
                    t_col, m_col = q_cols[0], nums[0]
                    grouped = df.groupby(t_col)[m_col].sum().reset_index().head(8)
                    return [{
                        "quarter_label": str(r[t_col]),
                        "actual": round(float(r[m_col]), 2),
                        "target": round(float(r[m_col]) * 0.9, 0)
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic quarterly fallback: {exc}")

        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)
            sql = f'''
                SELECT YEAR, QUARTER, ROUND(SUM(NETREVENUEUSD), 2) AS ACTUAL
                FROM "{target_table}"
                WHERE YEAR IS NOT NULL AND QUARTER IS NOT NULL
                GROUP BY YEAR, QUARTER
                ORDER BY YEAR, QUARTER
            '''
            rows = hana_client.execute_query(sql)
            if rows:
                result = []
                for r in rows:
                    actual = float(r.get("ACTUAL") or 0)
                    result.append({
                        "quarter_label": f"{r.get('YEAR')} {r.get('QUARTER')}",
                        "actual": actual,
                        "target": round(actual * 0.9, 0)
                    })
                return result
        except Exception as e:
            logger.error(f"Error getting quarterly performance in SAP HANA Cloud: {e}")
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
                        "units": int(df[df[cat_col] == r[cat_col]][u_col].sum()) if u_col else 1,
                        "revenue": round(float(r[m_col]), 2)
                    } for _, r in grouped.iterrows()]
        except Exception as exc:
            logger.debug(f"Dynamic top products fallback: {exc}")

        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)
            sql = f'''
                SELECT PRODUCTNAME, 
                       SUM(QUANTITY) AS UNITS, 
                       ROUND(SUM(NETREVENUEUSD), 2) AS REVENUE 
                FROM "{target_table}" 
                WHERE PRODUCTNAME IS NOT NULL 
                GROUP BY PRODUCTNAME 
                ORDER BY REVENUE DESC 
                LIMIT {lim}
            '''
            rows = hana_client.execute_query(sql)
            if rows:
                return [{
                    "product": str(r.get("PRODUCTNAME")),
                    "units": int(r.get("UNITS") or 0),
                    "revenue": float(r.get("REVENUE") or 0)
                } for r in rows]
        except Exception as e:
            logger.error(f"Error getting top products in SAP HANA Cloud: {e}")
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
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
            target_table = datasets_metadata_repo._resolve_physical_table(hint)
            sql = f'SELECT DISTINCT ORDERID FROM "{target_table}" WHERE ORDERID IS NOT NULL LIMIT {limit}'
            rows = hana_client.execute_query(sql)
            if rows:
                return [str(r.get("ORDERID")) for r in rows if r.get("ORDERID")]
        except Exception as e:
            logger.error(f"Error getting order IDs in SAP HANA Cloud: {e}")
        return []
    
    def get_order_details(self, order_id: str) -> Optional[Dict[str, Any]]:
        """Backwards-compatible wrapper for get_record_details."""
        return self.get_record_details(order_id)

    def get_record_details(self, record_id: str, table_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Get details for any record ID dynamically from SAP HANA Cloud active table or DataFrame without hardcoding."""
        import re
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

        # 2. Query SAP HANA Cloud
        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = table_name or (sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None)
            target = datasets_metadata_repo._resolve_physical_table(hint)

            candidate_columns = ["ORDERID", "ID", "PATIENT_ID", "EMPLOYEE_ID", "CUSTOMER_ID", "CODE", "KEY"]
            for col in candidate_columns:
                try:
                    sql = f'SELECT * FROM "{target}" WHERE UPPER("{col}") = UPPER(?) LIMIT 1'
                    rows = hana_client.execute_query(sql, (clean_id,))
                    if rows:
                        return CaseInsensitiveRecord(rows[0])
                except Exception:
                    continue

            num_part = re.sub(r'^[A-Za-z]+[-_]?', '', clean_id)
            if num_part and len(num_part) >= 3:
                for col in ["ORDERID", "ID"]:
                    try:
                        sql_like = f'SELECT * FROM "{target}" WHERE "{col}" LIKE ? LIMIT 1'
                        rows = hana_client.execute_query(sql_like, (f"%{num_part}%",))
                        if rows:
                            return CaseInsensitiveRecord(rows[0])
                    except Exception:
                        continue
        except Exception as e:
            logger.warning(f"Direct HANA record lookup failed ({e})")

        return None


# Singleton instance
data_service = DataService()
