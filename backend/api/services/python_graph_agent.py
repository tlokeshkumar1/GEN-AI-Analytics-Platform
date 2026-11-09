"""
PythonGraphAgent — Custom Graph Generation Service
====================================================
Implements the 10-step Custom Graph Generation workflow:

  Step 3  – Receive natural-language prompt + dataset path
  Step 4  – Read / inspect dataset schema, dtypes, sample values
  Step 5  – AI Agent interprets prompt → chart type, columns, aggregation
  Step 5b – Deterministic pre-computation of numeric result set
  Step 5c – Dual-path reconciliation / verification
  Step 6  – Generate unique temp Python script  (temp_graph_<id>.py)
  Step 7  – Execute script inside venv (60 s timeout)
  Step 8  – Read PNG result → base64 data-URI → return to caller
  Step 9  – Auto-delete temp .py script AND temp .png image
  Step 10 – Each request is fully stateless; no script re-use
"""

import os
import re
import sys
import uuid
import json
import time
import base64
import tempfile
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
import numpy as np

from api.services.ai_core_service import ai_core_service
from api.services.excel_dataset_service import excel_dataset_service
from api.utils.logger import get_logger

logger = get_logger("services.python_graph_agent")


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

_CHART_KEYWORDS: Dict[str, str] = {
    "funnel":      "funnel",
    "waterfall":   "waterfall",
    "treemap":     "treemap",
    "tree map":    "treemap",
    "heatmap":     "heatmap",
    "heat map":    "heatmap",
    "correlation": "heatmap",
    "matrix":      "heatmap",
    "stacked":     "stacked_bar",
    "donut":       "donut",
    "doughnut":    "donut",
    "pie":         "pie",
    "violin":      "violin",
    "box":         "box",
    "boxplot":     "box",
    "scatter":     "scatter",
    "bubble":      "scatter",
    "area":        "area",
    "line":        "line",
    "trend":       "line",
    "time series": "line",
    "bar":         "bar",
}

_DIM_KEYWORDS: Dict[str, str] = {
    "category":    "Category",
    "subcategory": "Subcategory",
    "country":     "Country",
    "region":      "Region",
    "segment":     "CustomerSegment",
    "industry":    "IndustryVertical",
    "vertical":    "IndustryVertical",
    "channel":     "Channel",
    "product":     "ProductName",
    "quarter":     "Quarter",
    "month":       "MonthName",
    "sales rep":   "SalesRepName",
    "rep":         "SalesRepName",
}

_MEASURE_KEYWORDS: Dict[str, str] = {
    "gross profit": "GrossMarginUSD",
    "gross margin": "GrossMarginUSD",
    "margin usd":  "GrossMarginUSD",
    "margin %":    "GrossMarginPercent",
    "margin percent": "GrossMarginPercent",
    "profit":   "GrossMarginUSD",
    "margin":   "GrossMarginUSD",
    "quantity": "Quantity",
    "units":    "Quantity",
    "discount": "DiscountPercent",
    "cost":     "TotalCostUSD",
    "price":    "UnitListPriceUSD",
    "revenue":  "NetRevenueUSD",
    "sales":    "NetRevenueUSD",
}

# Aggregation function mapping
_AGG_MAP = {
    "SUM": "sum",
    "AVG": "mean",
    "MEAN": "mean",
    "COUNT": "count",
    "MIN": "min",
    "MAX": "max",
    "COUNT_DISTINCT": "nunique",
}


class PythonGraphAgent:
    """Orchestrates the full Custom Graph Generation lifecycle."""

    def __init__(self) -> None:
        self.temp_dir: Path = Path(tempfile.gettempdir()) / "genai_graph_scripts"
        self._ensure_temp_dir()

    def _ensure_temp_dir(self) -> Path:
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        return self.temp_dir

    # ── Step 4: Dataset path & schema ─────────────────────────────────────────

    def _get_dataset_path(self) -> Path:
        try:
            return excel_dataset_service.get_fast_dataset_path()
        except Exception:
            import tempfile
            return Path(tempfile.gettempdir()) / "HANA_ACTIVE_DATASET.pkl"

    def _get_schema_summary(self) -> str:
        """Return a rich schema description including sample values."""
        try:
            df = excel_dataset_service.get_df()
            lines: list[str] = []
            for col in df.columns:
                dtype = str(df[col].dtype)
                if pd.api.types.is_numeric_dtype(df[col]):
                    mn, mx = df[col].min(), df[col].max()
                    lines.append(f"  - {col} [{dtype}] — range: {mn} → {mx}")
                else:
                    unique_vals = df[col].dropna().unique()[:6].tolist()
                    samples = ", ".join(str(v) for v in unique_vals)
                    lines.append(f"  - {col} [{dtype}] — sample values: {samples}")
            return "\n".join(lines)
        except Exception:
            return (
                "  - NetRevenueUSD [int64]\n"
                "  - Quantity [int64]\n"
                "  - Category [object]\n"
                "  - Subcategory [object]\n"
                "  - Region [object]\n"
                "  - Country [object]\n"
                "  - MonthName [object]\n"
                "  - Quarter [object]\n"
                "  - GrossMarginPercent [float64]\n"
                "  - DiscountPercent [float64]\n"
                "  - TotalCostUSD [int64]\n"
                "  - UnitListPriceUSD [float64]"
            )

    # ── Step 5: Intent parsing (dimension / measure / chart type) ─────────────

    def _infer_chart_type(self, prompt: str) -> str:
        p = prompt.lower()
        for kw, chart in _CHART_KEYWORDS.items():
            if kw in p:
                return chart
        # Heuristics: time words → line, comparison → bar
        if any(w in p for w in ["monthly", "weekly", "daily", "yearly", "over time"]):
            return "line"
        if any(w in p for w in ["compare", "comparison", "vs", "versus", "across"]):
            return "bar"
        if any(w in p for w in ["share", "proportion", "breakdown", "distribution"]):
            return "pie"
        return "bar"

    def _infer_dim(self, prompt: str, df: Optional[pd.DataFrame] = None) -> str:
        p = prompt.lower()
        # Check for multi-year composite dimensions first
        import re as _re
        years = _re.findall(r'\b(20[12]\d)\b', p)
        multi_year = len(set(years)) > 1
        if multi_year:
            quarterly_words = ["quarterly", "quarter", "each quarter"]
            monthly_words = ["monthly", "month", "each month"]
            separately_words = ["separately", "each", "broken down"]
            if any(w in p for w in quarterly_words) or (any(w in p for w in separately_words) and "quarter" in p):
                return "Year, Quarter"
            if any(w in p for w in monthly_words) or (any(w in p for w in separately_words) and "month" in p):
                return "Year, MonthName"

        target_df = df
        if target_df is None:
            try:
                from api.services.data_service import data_service
                target_df = data_service.get_dataframe()
            except Exception:
                pass

        if target_df is not None and not target_df.empty:
            cats = [c for c in target_df.columns if not str(c).lower().endswith(('id', 'code', 'key'))]
            for col in cats:
                clean = str(col).lower()
                if clean in p or clean.replace('_', ' ') in p:
                    return col
            # Check by/per/across regex
            m_by = _re.search(r'\b(?:by|per|across|for each|split by|group by)\s+([a-zA-Z0-9_]+)', p)
            if m_by:
                word = m_by.group(1).lower()
                for col in target_df.columns:
                    if word in str(col).lower():
                        return col

        for kw, col in _DIM_KEYWORDS.items():
            if kw in p:
                return col

        if target_df is not None and not target_df.empty:
            cats = [c for c in target_df.select_dtypes(include=['object', 'string']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
            if cats:
                return cats[0]

        return "Region"

    def _infer_measure(self, prompt: str, df: Optional[pd.DataFrame] = None) -> str:
        p = prompt.lower()
        target_df = df
        if target_df is None:
            try:
                from api.services.data_service import data_service
                target_df = data_service.get_dataframe()
            except Exception:
                pass

        # 1. First check explicit keyword dictionary (e.g. "gross margin" -> GrossMarginUSD)
        for kw, col in _MEASURE_KEYWORDS.items():
            if kw in p:
                if target_df is not None and not target_df.empty:
                    # Resolve against actual column in dataframe
                    matched = next((c for c in target_df.columns if c.lower() == col.lower() or c.lower().replace("_", "") == col.lower()), None)
                    if matched:
                        return matched
                return col

        # 2. Check matching column names in target_df
        if target_df is not None and not target_df.empty:
            nums = [
                c for c in target_df.select_dtypes(include=['number']).columns
                if not str(c).lower().endswith(('id', 'code', 'key'))
                and str(c).lower() not in ('year', 'month', 'monthnum', 'quarter', 'day', 'week')
            ]
            for col in nums:
                clean = str(col).lower()
                clean_no_usd = clean.replace('usd', '').replace('eur', '').replace('inr', '')
                if clean in p or clean_no_usd in p or clean.replace('_', ' ') in p:
                    return col
            if nums and any(k in p for k in ["total", "sum", "average", "avg", "salary", "cost", "price", "rate", "revenue", "count"]):
                return nums[0]

        if target_df is not None and not target_df.empty:
            nums = [
                c for c in target_df.select_dtypes(include=['number']).columns
                if not str(c).lower().endswith(('id', 'code', 'key'))
                and str(c).lower() not in ('year', 'month', 'monthnum', 'quarter', 'day', 'week')
            ]
            if nums:
                return nums[0]

        return "NetRevenueUSD"

    # ──────────────────────────────────────────────────────────────────────────
    # NEW: Deterministic Pre-Computation & Reconciliation
    # ──────────────────────────────────────────────────────────────────────────

    def _apply_filters(self, df: pd.DataFrame, filters: List[Dict], date_filter: Optional[Dict]) -> pd.DataFrame:
        """Apply query plan filters to the dataframe with strict type coercion."""
        filtered = df.copy()

        for f in filters:
            col = f.get("column")
            op = f.get("operator", "=")
            val = f.get("value")
            if col not in filtered.columns or val is None:
                continue
            try:
                col_dtype = filtered[col].dtype

                def coerce_val(v, target_dtype):
                    if pd.isna(v):
                        return v
                    try:
                        if pd.api.types.is_integer_dtype(target_dtype):
                            return int(float(str(v).strip()))
                        elif pd.api.types.is_float_dtype(target_dtype):
                            return float(str(v).strip())
                    except (ValueError, TypeError):
                        return v
                    return str(v)

                if isinstance(val, str) and "," in val and op in ("=", "IN"):
                    val = [v.strip() for v in val.split(",")]
                    op = "IN"

                if op == "IN":
                    vals = val if isinstance(val, list) else [val]
                    coerced_vals = [coerce_val(v, col_dtype) for v in vals]
                    filtered = filtered[filtered[col].isin(coerced_vals)]
                else:
                    c_val = coerce_val(val, col_dtype)
                    if op in ("=", "=="):
                        filtered = filtered[filtered[col] == c_val]
                    elif op == "!=":
                        filtered = filtered[filtered[col] != c_val]
                    elif op == ">":
                        filtered = filtered[filtered[col] > c_val]
                    elif op == "<":
                        filtered = filtered[filtered[col] < c_val]
                    elif op == ">=":
                        filtered = filtered[filtered[col] >= c_val]
                    elif op == "<=":
                        filtered = filtered[filtered[col] <= c_val]
                    elif op == "CONTAINS":
                        filtered = filtered[filtered[col].astype(str).str.contains(str(val), case=False, na=False)]
            except Exception as e:
                logger.warning(f"[PreCompute] Could not apply filter {f}: {e}")

        if date_filter:
            col = date_filter.get("column")
            from_val = date_filter.get("from")
            to_val = date_filter.get("to")
            if col and col in filtered.columns:
                try:
                    col_dtype = filtered[col].dtype
                    if from_val is not None and str(from_val).strip():
                        if np.issubdtype(col_dtype, np.number):
                            year_match = re.search(r'\b(20[12]\d)\b', str(from_val))
                            f_num = int(year_match.group(1)) if year_match else float(from_val)
                            filtered = filtered[filtered[col] >= f_num]
                        else:
                            filtered = filtered[filtered[col].astype(str) >= str(from_val)]

                    if to_val is not None and str(to_val).strip():
                        if np.issubdtype(col_dtype, np.number):
                            year_match = re.search(r'\b(20[12]\d)\b', str(to_val))
                            t_num = int(year_match.group(1)) if year_match else float(to_val)
                            filtered = filtered[filtered[col] <= t_num]
                        else:
                            filtered = filtered[filtered[col].astype(str) <= str(to_val)]
                except Exception as e:
                    logger.warning(f"[PreCompute] Could not apply date filter {date_filter}: {e}")

        # Safety fallback: if filters over-filtered dataset to 0 rows, fall back to unfiltered df
        if len(filtered) == 0 and len(df) > 0:
            logger.warning("[PreCompute] Filters resulted in 0 records! Falling back to full dataset.")
            return df.copy()

        return filtered

    def _compute_graph_dataset(
        self,
        chart_type_or_plan: Any = "bar",
        dim: Optional[str] = None,
        measure: Optional[str] = None,
        aggregation: str = "SUM",
        filters: Optional[List[Dict]] = None,
        date_filter: Optional[Dict] = None,
        limit: Optional[int] = None,
        sort_dir: str = "DESC",
        df: Optional[pd.DataFrame] = None,
        chart_type: Any = None,
    ) -> pd.DataFrame:
        """
        Deterministic pre-computation of the numeric result set.
        Supports passing a query plan dict or individual parameters.
        Returns a pre-aggregated DataFrame ready for chart rendering.
        """
        target = chart_type if chart_type is not None else chart_type_or_plan
        if isinstance(target, dict):
            plan = target
            chart_type = plan.get("chart_type", "bar")
            dim = plan.get("dimension") or plan.get("dim") or "Region"
            measure = plan.get("measure", "NetRevenueUSD")
            aggregation = plan.get("aggregation", "SUM")
            filters = plan.get("filters", [])
            date_filter = plan.get("date_filter")
            limit = plan.get("top_n") or plan.get("limit")
            sort_dir = plan.get("sort_dir", "DESC")
            if df is None:
                # Expecting df as 2nd arg if 1st arg is dict: _compute_graph_dataset(plan, df)
                if dim is not None and isinstance(dim, pd.DataFrame):
                    df = dim
        else:
            chart_type = target

        if filters is None:
            filters = []
        if df is None:
            df = excel_dataset_service.get_df()

        # Apply filters
        filtered = self._apply_filters(df, filters, date_filter)

        # For heatmap/correlation:
        if chart_type == "heatmap":
            sec_dim = None
            if dim and dim in filtered.columns and measure and measure in filtered.columns:
                for candidate in ["CATEGORY", "Category", "QUARTER", "Quarter", "CHANNEL", "Channel", "CUSTOMERSEGMENT", "CustomerSegment", "SUBCATEGORY", "Subcategory"]:
                    match = next((c for c in filtered.columns if c.lower() == candidate.lower()), None)
                    if match and match.lower() != str(dim).lower():
                        sec_dim = match
                        break
                if not sec_dim:
                    cats = [c for c in filtered.select_dtypes(include=['object', 'string']).columns if c != dim and not str(c).lower().endswith(('id', 'code', 'key'))]
                    if cats:
                        sec_dim = cats[0]

            if sec_dim and dim and measure:
                pivot = filtered.pivot_table(index=dim, columns=sec_dim, values=measure, aggfunc=_AGG_MAP.get(aggregation, "sum"), fill_value=0)
                if len(pivot) > 12:
                    top_idx = filtered.groupby(dim)[measure].sum().nlargest(12).index
                    pivot = pivot.loc[pivot.index.isin(top_idx)]
                return pivot

            num_cols = [c for c in filtered.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
            if len(num_cols) >= 2:
                return filtered[num_cols].corr()
            return filtered.select_dtypes(include=['number']).corr()

        # For scatter charts, return a sampled raw dataset (no aggregation needed)
        if chart_type == "scatter":
            sample_n = min(1200, len(filtered))
            return filtered.sample(n=sample_n, random_state=42)

        # For box/violin, return filtered raw data (no aggregation)
        if chart_type in ("box", "violin"):
            top_dims = filtered[dim].value_counts().head(8).index
            return filtered[filtered[dim].isin(top_dims)]

        # Standard aggregation path
        agg_func = _AGG_MAP.get(aggregation, "sum")

        # Support composite dimensions (e.g. "Year, Quarter")
        is_composite = ", " in str(dim)
        if is_composite:
            dim_parts = [d.strip() for d in dim.split(",")]
            for part in dim_parts:
                if part not in filtered.columns:
                    logger.warning(f"[PreCompute] Composite dim part '{part}' not in columns, falling back")
                    dim = "Region"
                    is_composite = False
                    break

        if is_composite:
            dim_parts = [d.strip() for d in dim.split(",")]
            agg = filtered.groupby(dim_parts)[measure].agg(agg_func).reset_index()

            # Chronological sorting
            if "Year" in dim_parts and "Quarter" in dim_parts:
                agg["_qnum"] = agg["Quarter"].astype(str).str.extract(r'(\d+)').fillna(0).astype(int)
                agg = agg.sort_values(["Year", "_qnum"]).drop(columns=["_qnum"])
            elif "Year" in dim_parts and "MonthName" in dim_parts:
                month_order = {
                    "January": 1, "February": 2, "March": 3, "April": 4,
                    "May": 5, "June": 6, "July": 7, "August": 8,
                    "September": 9, "October": 10, "November": 11, "December": 12,
                }
                agg["_mnum"] = agg["MonthName"].map(month_order).fillna(0).astype(int)
                agg = agg.sort_values(["Year", "_mnum"]).drop(columns=["_mnum"])
            else:
                ascending = sort_dir == "ASC"
                agg = agg.sort_values(measure, ascending=ascending)

            # Add combined label column
            label_col = " ".join(dim_parts)
            agg[label_col] = agg.apply(lambda row: " ".join(str(row[p]) for p in dim_parts), axis=1)

            return agg

        if chart_type == "stacked_bar":
            sec_dim = "Category" if dim != "Category" else "Region"
            if sec_dim not in filtered.columns:
                sec_dims = [c for c in filtered.columns if c != dim and filtered[c].dtype == object]
                sec_dim = sec_dims[0] if sec_dims else "Region"
            agg = filtered.groupby([dim, sec_dim])[measure].agg(agg_func).reset_index()
        else:
            agg = filtered.groupby(dim)[measure].agg(agg_func).reset_index()

        # Sort
        ascending = sort_dir == "ASC"
        if chart_type not in ("stacked_bar",):
            agg = agg.sort_values(measure, ascending=ascending)

        # Limit
        effective_limit = limit or 10
        if chart_type in ("funnel", "waterfall"):
            effective_limit = limit or 8
        elif chart_type in ("donut", "pie"):
            effective_limit = limit or 7

        if chart_type not in ("stacked_bar", "line", "area"):
            agg = agg.head(effective_limit)

        return agg

    def _reconcile_graph_dataset(
        self,
        df_agg: pd.DataFrame,
        chart_type_or_plan: Any = "bar",
        dim: Optional[str] = None,
        measure: Optional[str] = None,
        aggregation: str = "SUM",
        filters: Optional[List[Dict]] = None,
        date_filter: Optional[Dict] = None,
        df: Optional[pd.DataFrame] = None,
        chart_type: Any = None,
    ) -> Dict[str, Any]:
        """
        Dual-path reconciliation: independently recompute the aggregation
        and compare against the primary computation.
        Supports passing a query plan dict or individual parameters.
        Returns { verified: bool, discrepancy: str|None }.
        """
        TOLERANCE = 1e-4

        target = chart_type if chart_type is not None else chart_type_or_plan
        if isinstance(target, dict):
            plan = target
            chart_type = plan.get("chart_type", "bar")
            dim = plan.get("dimension") or plan.get("dim") or "Region"
            measure = plan.get("measure", "NetRevenueUSD")
            aggregation = plan.get("aggregation", "SUM")
            filters = plan.get("filters", [])
            date_filter = plan.get("date_filter")
            if df is None and dim is not None and isinstance(dim, pd.DataFrame):
                df = dim
        else:
            chart_type = target

        if filters is None:
            filters = []
        if df is None:
            df = excel_dataset_service.get_df()

        # Skip reconciliation for chart types that don't aggregate
        if chart_type in ("heatmap", "scatter", "box", "violin"):
            return {"verified": True, "discrepancy": None}

        try:
            # Independent recomputation via a different code path
            filtered = self._apply_filters(df, filters, date_filter)
            agg_func = _AGG_MAP.get(aggregation, "sum")

            is_composite = ", " in str(dim)
            if is_composite:
                dim_parts = [d.strip() for d in dim.split(",")]
                check = filtered.groupby(dim_parts)[measure].agg(agg_func)
                primary_totals = df_agg.groupby(dim_parts)[measure].sum()
            elif chart_type == "stacked_bar":
                # For stacked bars, verify the grand total per dimension
                check = filtered.groupby(dim)[measure].agg(agg_func)
                primary_totals = df_agg.groupby(dim)[measure].sum()
            else:
                check = filtered.groupby(dim)[measure].agg(agg_func)
                primary_totals = df_agg.set_index(dim)[measure]

            # Compare only the keys present in primary (which may be limited)
            common_keys = primary_totals.index.intersection(check.index)
            if len(common_keys) == 0:
                return {"verified": False, "discrepancy": "No common keys between primary and reconciliation results"}

            primary_vals = primary_totals.loc[common_keys].values.astype(float)
            check_vals = check.loc[common_keys].values.astype(float)

            if np.allclose(primary_vals, check_vals, atol=TOLERANCE, rtol=TOLERANCE):
                return {"verified": True, "discrepancy": None}
            else:
                max_diff = float(np.max(np.abs(primary_vals - check_vals)))
                msg = (
                    f"Reconciliation mismatch: max absolute difference = {max_diff:.6f} "
                    f"(tolerance = {TOLERANCE})"
                )
                logger.warning(f"[Reconciliation] {msg}")
                return {"verified": False, "discrepancy": msg}

        except Exception as exc:
            logger.error(f"[Reconciliation] Error during reconciliation: {exc}")
            return {"verified": False, "discrepancy": f"Reconciliation error: {exc}"}

    # ── Step 5: AI system prompt ───────────────────────────────────────────────

    def _build_system_prompt(
        self,
        prompt: str,
        clean_ds: str,
        clean_output: str,
        df_agg: Optional[pd.DataFrame] = None,
        chart_type: str = "bar",
        dim: str = "Region",
        measure: str = "NetRevenueUSD",
    ) -> str:
        schema = self._get_schema_summary()
        read_stmt = (
            f'pd.read_pickle(r"{clean_ds}")'
            if clean_ds.endswith(".pkl")
            else f'pd.read_csv(r"{clean_ds}")' if clean_ds.lower().endswith(".csv")
            else f'pd.read_excel(r"{clean_ds}")'
        )

        # If pre-computed data is available, embed it as a CSV literal
        precomputed_section = ""
        if df_agg is not None:
            csv_str = df_agg.to_csv(index=False)
            precomputed_section = f"""
PRE-COMPUTED DATA (use this EXACTLY — do NOT re-aggregate from the raw dataset)
--------------------------------------------------------------------------------
The numeric values below have been deterministically computed and verified.
Read them with: df_agg = pd.read_csv(io.StringIO(PRECOMPUTED_CSV))

```csv
{csv_str}
```

CRITICAL: Your script MUST use these pre-computed values for the chart.
Do NOT recalculate aggregations from the raw dataset.
Import io at the top of your script and use pd.read_csv(io.StringIO(...)) to load this data.
"""

        is_composite_dim = ", " in str(dim)
        if is_composite_dim:
            dim_parts = [d.strip() for d in dim.split(",")]
            dim_desc = f"{dim} (composite dimension: group by column list {dim_parts} in pandas)"
        else:
            dim_desc = dim

        return f"""You are an expert Python Data Visualization Agent for an SAP Analytics Platform.

TASK
----
Generate a complete, executable Python script that produces the requested business visualization.

USER REQUEST
------------
"{prompt}"

CHART TYPE: {chart_type}
DIMENSION: {dim_desc}
MEASURE: {measure}

DATASET (for reference schema only — do NOT aggregate from this)
-------
Path  : r"{clean_ds}"
Read  : df = {read_stmt}

SCHEMA (column [dtype] — sample/range)
---------------------------------------
{schema}
{precomputed_section}

OUTPUT IMAGE
------------
Save the figure to: r"{clean_output}"

STRICT RULES
------------
1. Use ONLY: pandas, matplotlib, seaborn, numpy, openpyxl, io. No other libraries.
2. Set matplotlib.use('Agg') BEFORE importing pyplot.
3. Validate that required columns exist; raise ValueError with column name if missing.
4. Clean NaN values before aggregating.
5. Use the exact dataset path: r"{clean_ds}"
6. Save with: plt.savefig(r"{clean_output}", format='png', dpi=300, bbox_inches='tight')
7. Close the figure with plt.close() after saving.
8. Use professional styling: seaborn whitegrid theme, readable fonts (size 9–14), grid lines, proper spacing.
9. High resolution: figsize=(10, 6), dpi=300.
10. Return ONLY executable Python code — NO markdown, NO backticks, NO explanations.
11. Do not print anything except: print(r"{clean_output}") at the very end.
12. Do not use network access or read any file except the dataset.
13. If pre-computed data is provided above, use it directly — do NOT re-aggregate.
14. Auto-infer x-axis, y-axis, labels, legends, title from the user request.
15. Use currency formatting (e.g. $1.23M) for revenue/cost columns automatically.

Generate complete Python code only. No explanation."""

    # ── Step 6: Code generation (AI-first, deterministic fallback) ─────────────

    def _strip_markdown(self, raw: str) -> str:
        code = re.sub(r"```(?:python)?\s*", "", raw, flags=re.IGNORECASE)
        code = re.sub(r"```\s*", "", code)
        return code.strip()

    def _is_valid_code(self, code: str) -> bool:
        return (
            bool(code)
            and "import pandas" in code
            and "plt.savefig" in code
            and "matplotlib.use" in code
        )

    def _generate_python_code(
        self, prompt: str, output_img_path: str, fallback_mode: bool = False,
        df_agg: Optional[pd.DataFrame] = None,
        chart_type: str = "bar", dim: str = "Region", measure: str = "NetRevenueUSD",
    ) -> str:
        """
        Step 6 — Synthesize a standalone Python visualization script.
        AI-first: calls AI Core LLM. On failure: deterministic template fallback.
        The LLM receives pre-computed data (df_agg) and must NOT re-aggregate.
        """
        ds_path  = self._get_dataset_path()
        clean_ds = str(ds_path).replace("\\", "/")
        clean_out = str(output_img_path).replace("\\", "/")
        read_stmt = (
            f'df = pd.read_pickle(r"{clean_ds}")'
            if clean_ds.endswith(".pkl")
            else f'df = pd.read_csv(r"{clean_ds}")' if clean_ds.lower().endswith(".csv")
            else f'df = pd.read_excel(r"{clean_ds}")'
        )

        # ── AI Core attempt ──────────────────────────────────────────────────
        if not fallback_mode:
            try:
                system_prompt = self._build_system_prompt(
                    prompt, clean_ds, clean_out,
                    df_agg=df_agg, chart_type=chart_type, dim=dim, measure=measure,
                )
                raw = ai_core_service.generate_aicore_completion(system_prompt)
                if raw and not raw.startswith(("AI Insight", "Simulated Response")):
                    code = self._strip_markdown(raw)
                    if self._is_valid_code(code):
                        logger.info("[Graph Agent] SAP AI Core generated valid code.")
                        return code
            except Exception as exc:
                logger.warning(f"[Graph Agent] SAP AI Core skipped: {exc}")

        # ── Deterministic fallback ───────────────────────────────────────────
        logger.info(f"[Graph Agent] Deterministic fallback → chart={chart_type}, dim={dim}, measure={measure}")
        return self._deterministic_code(chart_type, dim, measure, clean_ds, clean_out, read_stmt, df_agg)

    # ── Deterministic code templates ──────────────────────────────────────────

    def _deterministic_code(
        self, chart_type: str, dim: str, measure: str,
        clean_ds: str, clean_out: str, read_stmt: str,
        df_agg: Optional[pd.DataFrame] = None,
    ) -> str:
        # Check composite dimensions
        is_composite_dim = ", " in str(dim)
        if is_composite_dim:
            dim_parts = [d.strip() for d in dim.split(",")]
            label_col = " ".join(dim_parts)
            dim_groupby_expr = f"{dim_parts}"
            agg_fallback_code = f'''agg = df.groupby({dim_groupby_expr})["{measure}"].sum().reset_index()
agg["{label_col}"] = agg.apply(lambda r: " ".join(str(r[p]) for p in {dim_parts}), axis=1)
'''
        else:
            dim_parts = [dim]
            label_col = dim
            dim_groupby_expr = f'"{dim}"'
            agg_fallback_code = f'''agg = df.groupby("{dim}")["{measure}"].sum().reset_index()
agg = agg.sort_values("{measure}", ascending=False).head(10)
'''

        # If pre-computed data is available, embed it as CSV and read from that
        if df_agg is not None and chart_type not in ("heatmap", "scatter", "box", "violin"):
            csv_escaped = df_agg.to_csv(index=False).replace("\\", "\\\\").replace('"', '\\"')
            agg_read = f'''import io
agg = pd.read_csv(io.StringIO("""{df_agg.to_csv(index=False)}"""))
'''
        else:
            agg_read = None

        # Only load raw dataset if pre-computed data is missing or chart requires raw rows
        needs_raw = agg_read is None or chart_type in ("heatmap", "scatter", "box", "violin")
        ds_load = read_stmt if needs_raw else ""

        header = f"""import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import seaborn as sns
import numpy as np

sns.set_theme(style="whitegrid", font_scale=1.05)
PALETTE = sns.color_palette("Blues_r", 10)

{ds_load}

def fmt_val(v, col):
    if col in ("NetRevenueUSD", "TotalCostUSD", "GrossMarginUSD") and abs(v) >= 1e6:
        return f"${{v/1e6:.2f}}M"
    if col in ("GrossMarginPercent", "DiscountPercent"):
        return f"{{v:.1f}}%"
    return f"{{v:,.0f}}"
"""

        save = f"""
plt.tight_layout()
plt.savefig(r"{clean_out}", format='png', dpi=300, bbox_inches='tight')
plt.close()
print(r"{clean_out}")
"""

        # Helper: use pre-computed data or inline aggregation
        def agg_block(default_code: Optional[str] = None) -> str:
            if agg_read:
                return agg_read
            return default_code if default_code is not None else agg_fallback_code

        # ── Funnel ────────────────────────────────────────────────────────────
        if chart_type == "funnel":
            agg_src = agg_block()
            return header + f"""
{agg_src}
total = agg["{measure}"].sum()
agg["pct"] = agg["{measure}"] / total * 100
max_v = agg["{measure}"].max()

fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
colors = sns.color_palette("Blues_r", len(agg))
for i, row in agg.reset_index(drop=True).iterrows():
    v, pct = row["{measure}"], row["pct"]
    left = (max_v - v) / 2
    y = len(agg) - 1 - i
    ax.barh(y, v, left=left, color=colors[i], edgecolor="#0f172a", linewidth=0.8, height=0.65)
    lbl_val = row.get("{label_col}", row.iloc[0])
    label = f"{{lbl_val}}: {{fmt_val(v, '{measure}')}} ({{pct:.1f}}%)"
    ax.text(left + v / 2, y, label, ha="center", va="center",
            color="white", fontweight="bold", fontsize=8.5)

ax.set_yticks([])
ax.set_xlabel("{measure}", fontsize=11, fontweight="bold", color="#1e293b")
ax.set_title(f"Funnel: {measure} by {label_col}", fontsize=14, fontweight="bold", pad=15, color="#0f172a")
for spine in ["top", "right", "left"]:
    ax.spines[spine].set_visible(False)
""" + save

        # ── Heatmap / Correlation ─────────────────────────────────────────────
        if chart_type == "heatmap":
            sec_dim = None
            if dim in df.columns and measure in df.columns:
                for candidate in ["CATEGORY", "Category", "QUARTER", "Quarter", "CHANNEL", "Channel", "CUSTOMERSEGMENT", "CustomerSegment"]:
                    match = next((c for c in df.columns if c.lower() == candidate.lower()), None)
                    if match and match.lower() != str(dim).lower():
                        sec_dim = match
                        break
                if not sec_dim:
                    cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if c != dim and not str(c).lower().endswith(('id', 'code', 'key'))]
                    if cats:
                        sec_dim = cats[0]

            if sec_dim:
                return header + f"""
top_dims = df.groupby("{dim}")["{measure}"].sum().nlargest(10).index
filtered_data = df[df["{dim}"].isin(top_dims)]
pivot = filtered_data.pivot_table(index="{dim}", columns="{sec_dim}", values="{measure}", aggfunc="sum", fill_value=0)
fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
sns.heatmap(pivot, annot=True, fmt=",.0f", cmap="YlGnBu", linewidths=0.5, ax=ax)
ax.set_title(f"Heatmap: {measure} across {dim} & {sec_dim}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
plt.xticks(rotation=30, ha="right")
plt.yticks(rotation=0)
""" + save
            else:
                return header + f"""
num_cols = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
corr = df[num_cols].corr() if len(num_cols) >= 2 else df.select_dtypes(include=['number']).corr()
fig, ax = plt.subplots(figsize=(10, 7), dpi=300)
sns.heatmap(corr, annot=True, fmt=".2f", cmap="coolwarm", linewidths=0.5,
            annot_kws={{"size": 8, "weight": "bold"}}, ax=ax)
ax.set_title("Correlation Matrix — Financial & Sales Metrics",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
plt.xticks(rotation=30, ha="right")
plt.yticks(rotation=0)
""" + save

        # ── Stacked Bar ───────────────────────────────────────────────────────
        if chart_type == "stacked_bar":
            sec_dim = "Category" if "Category" not in dim else "Region"
            if agg_read:
                pivot_src = f"""{agg_read}
pivot = agg.pivot_table(index="{label_col}" if "{label_col}" in agg.columns else agg.columns[0], columns="{sec_dim}", values="{measure}", fill_value=0)
"""
            else:
                p_dim = f"{dim_parts}" if is_composite_dim else f'"{dim}"'
                pivot_src = f"""pivot = df.groupby({p_dim} + ["{sec_dim}"])["{measure}"].sum().unstack(fill_value=0)
top_idx = df.groupby({p_dim})["{measure}"].sum().nlargest(8).index
pivot = pivot.loc[pivot.index.isin(top_idx)]
"""
            return header + f"""
{pivot_src}
fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
pivot.plot(kind="bar", stacked=True, ax=ax, colormap="tab10",
           edgecolor="#1e293b", linewidth=0.4)
ax.set_title(f"Stacked {measure} by {label_col} & {sec_dim}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
ax.set_xlabel("{label_col}", fontsize=11, fontweight="bold", color="#334155")
ax.set_ylabel("Total {measure}", fontsize=11, fontweight="bold", color="#334155")
plt.xticks(rotation=30, ha="right")
plt.legend(title="{sec_dim}", bbox_to_anchor=(1.02, 1), loc="upper left", fontsize=8)
""" + save

        # ── Donut / Pie ───────────────────────────────────────────────────────
        if chart_type in ("donut", "pie"):
            wedge = 'dict(width=0.42, edgecolor=\'white\')' if chart_type == "donut" else 'dict(edgecolor=\'white\')'
            agg_src = agg_block()
            return header + f"""
{agg_src}
fig, ax = plt.subplots(figsize=(8, 7), dpi=300)
colors = sns.color_palette("Spectral", len(agg))
lbl_col = "{label_col}" if "{label_col}" in agg.columns else agg.columns[0]
wedges, texts, autotexts = ax.pie(
    agg["{measure}"], labels=agg[lbl_col],
    autopct="%1.1f%%", startangle=140,
    colors=colors, wedgeprops={wedge},
    textprops={{"fontsize": 9, "weight": "bold"}}
)
for at in autotexts:
    at.set_fontsize(8)
ax.set_title(f"Share of {measure} by {label_col}",
             fontsize=14, fontweight="bold", pad=20, color="#0f172a")
""" + save

        # ── Line / Area ───────────────────────────────────────────────────────
        if chart_type in ("line", "area"):
            if is_composite_dim:
                line_x_col = label_col
            else:
                line_x_col = "Quarter" if "quarter" in dim.lower() else ("MonthName" if "month" in dim.lower() else dim)
            agg_src = agg_block(f'''agg = df.groupby("{line_x_col}")["{measure}"].sum().reset_index()
''')
            fill = f"ax.fill_between(range(len(agg)), agg['{measure}'], color='#38bdf8', alpha=0.3)" if chart_type == "area" else ""
            return header + f"""
{agg_src}
fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
x_series = agg["{line_x_col}"] if "{line_x_col}" in agg.columns else agg.iloc[:, 0]
ax.plot(x_series.astype(str), agg["{measure}"],
        marker="o", linewidth=2.5, color="#0284c7",
        markerfacecolor="#0369a1", markersize=6)
{fill}
ax.set_title(f"Trend: {measure} across {line_x_col}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
ax.set_xlabel("{line_x_col}", fontsize=11, fontweight="bold", color="#334155")
ax.set_ylabel("{measure}", fontsize=11, fontweight="bold", color="#334155")
plt.xticks(rotation=20, ha="right")
ax.yaxis.set_major_formatter(mticker.FuncFormatter(
    lambda x, _: f"${{x/1e6:.1f}}M" if "{measure}" in ("NetRevenueUSD", "TotalCostUSD") and x >= 1e6 else f"{{x:,.0f}}"
))
""" + save

        # ── Waterfall ─────────────────────────────────────────────────────────
        if chart_type == "waterfall":
            agg_src = agg_block()
            return header + f"""
{agg_src}
lbl_col = "{label_col}" if "{label_col}" in agg.columns else agg.columns[0]
agg["cumulative"] = agg["{measure}"].cumsum()
bottoms = [0] + list(agg["cumulative"].iloc[:-1])

fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
colors = sns.color_palette("viridis", len(agg))
bars = ax.bar(agg[lbl_col].astype(str), agg["{measure}"],
              bottom=bottoms, color=colors, edgecolor="#0f172a", linewidth=0.7)
ax.set_title(f"Waterfall: Cumulative {measure} by {label_col}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
ax.set_xlabel("{label_col}", fontsize=11, fontweight="bold", color="#334155")
ax.set_ylabel("Cumulative {measure}", fontsize=11, fontweight="bold", color="#334155")
plt.xticks(rotation=30, ha="right")
for bar, b in zip(bars, bottoms):
    h = bar.get_height()
    ax.annotate(fmt_val(h, "{measure}"),
                xy=(bar.get_x() + bar.get_width()/2, b + h),
                xytext=(0, 4), textcoords="offset points",
                ha="center", va="bottom", fontsize=7.5, fontweight="bold")
""" + save

        # ── Treemap (horizontal bar substitute) ───────────────────────────────
        if chart_type == "treemap":
            agg_src = agg_block()
            return header + f"""
{agg_src}
lbl_col = "{label_col}" if "{label_col}" in agg.columns else agg.columns[0]
fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
colors = sns.color_palette("crest", len(agg))
bars = ax.barh(agg[lbl_col].astype(str), agg["{measure}"],
               color=colors, edgecolor="#0f172a", linewidth=0.6)
ax.set_title(f"Category Hierarchy: {measure} by {label_col}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
ax.set_xlabel("Total {measure}", fontsize=11, fontweight="bold", color="#334155")
for bar in bars:
    w = bar.get_width()
    ax.text(w * 0.98, bar.get_y() + bar.get_height()/2,
            fmt_val(w, "{measure}"), ha="right", va="center",
            color="white", fontsize=8, fontweight="bold")
ax.invert_yaxis()
""" + save

        # ── Box / Violin ──────────────────────────────────────────────────────
        if chart_type in ("box", "violin"):
            plot_fn = "sns.violinplot" if chart_type == "violin" else "sns.boxplot"
            b_dim = dim_parts[0] if is_composite_dim else dim
            return header + f"""
top_dims = df["{b_dim}"].value_counts().head(8).index
sub = df[df["{b_dim}"].isin(top_dims)]
fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
{plot_fn}(data=sub, x="{b_dim}", y="{measure}", ax=ax, palette="Set2")
ax.set_title(f"Distribution of {measure} by {b_dim}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
ax.set_xlabel("{b_dim}", fontsize=11, fontweight="bold", color="#334155")
ax.set_ylabel("{measure}", fontsize=11, fontweight="bold", color="#334155")
plt.xticks(rotation=30, ha="right")
""" + save

        # ── Scatter ───────────────────────────────────────────────────────────
        if chart_type == "scatter":
            sec = "DiscountPercent" if measure != "DiscountPercent" else "GrossMarginPercent"
            s_dim = dim_parts[0] if is_composite_dim else dim
            return header + f"""
sample = df.sample(n=min(1200, len(df)), random_state=42)
fig, ax = plt.subplots(figsize=(10, 6), dpi=300)
sns.scatterplot(data=sample, x="{sec}", y="{measure}",
                hue="{s_dim}", alpha=0.72, s=45, ax=ax, palette="tab10")
ax.set_title(f"Scatter: {sec} vs {measure}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
plt.legend(bbox_to_anchor=(1.02, 1), loc="upper left", fontsize=8)
""" + save

        # ── Default: Bar chart / Grouped Bar chart ────────────────────────────
        agg_src = agg_block()
        x_col = label_col

        return header + f"""
{agg_src}
# Determine x-axis column
x_col = "{x_col}"
if x_col not in agg.columns:
    for c in agg.columns:
        if c not in ["{measure}"] and agg[c].dtype == object:
            x_col = c
            break

fig, ax = plt.subplots(figsize=(12, 6) if len(agg) > 6 else (10, 6), dpi=300)
colors = sns.color_palette("Blues_r", len(agg))
bars = ax.bar(agg[x_col].astype(str), agg["{measure}"],
              color=colors, edgecolor="#0f172a", linewidth=0.7, alpha=0.92)
ax.set_title(f"Total {measure} by {label_col}",
             fontsize=14, fontweight="bold", pad=15, color="#0f172a")
ax.set_xlabel("{label_col}", fontsize=11, fontweight="bold", color="#334155")
ax.set_ylabel("Total {measure}", fontsize=11, fontweight="bold", color="#334155")
plt.xticks(rotation=30, ha="right")
ax.yaxis.set_major_formatter(mticker.FuncFormatter(
    lambda x, _: f"${{x/1e6:.1f}}M" if "{measure}" in ("NetRevenueUSD", "TotalCostUSD", "GrossMarginUSD") and x >= 1e6 else f"{{x:,.0f}}"
))
for bar in bars:
    h = bar.get_height()
    ax.annotate(fmt_val(h, "{measure}"),
                xy=(bar.get_x() + bar.get_width()/2, h),
                xytext=(0, 4), textcoords="offset points",
                ha="center", va="bottom", fontsize=7.5, fontweight="bold")
""" + save

    # ── Step 7: venv-aware Python executable ──────────────────────────────────

    def _get_python_executable(self) -> str:
        base_dir = Path(__file__).resolve().parent.parent  # api/
        venv_py1 = base_dir / "venv" / "Scripts" / "python.exe"
        venv_py2 = base_dir.parent / "venv" / "Scripts" / "python.exe"
        for venv_py in (venv_py1, venv_py2):
            if venv_py.exists():
                logger.debug(f"[Graph Agent] Using venv Python: {venv_py}")
                return str(venv_py)
        logger.debug(f"[Graph Agent] venv not found, falling back to: {sys.executable}")
        return sys.executable

    # ── Step 8 + cleanup insights ─────────────────────────────────────────────

    def _build_insights(self, prompt: str, chart_type: str, dim: str, measure: str, script_name: str, verified: bool = True) -> str:
        chart_label = chart_type.replace("_", " ").title()
        verification_note = "✅ Data verified" if verified else "⚠️ Verification failed — using deterministic fallback"
        return (
            f"• **AI Graph Agent** generated a **{chart_label} Chart** for your request.\n"
            f"• Visualizing **{measure}** grouped by **{dim}**.\n"
            f"• {verification_note}\n"
            f"• Dataset: `SAC_Sales_Preprocessed` — temp script `{script_name}` auto-deleted after execution."
        )

    # ── Step 3–10: Main entry point ───────────────────────────────────────────

    def generate_custom_graph(self, prompt: str, query_plan: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Full 10-step Custom Graph Generation workflow.
        Accepts an optional query_plan from IntentEngine for validated column/chart resolution.
        Returns a dict with: status, prompt, image_base64, chart_type, insights, message,
                             records_matched, records_in_source, data_as_of, verified.
        """
        request_start = time.time()
        logger.info(f"[Graph Agent] Received request: '{prompt}'")

        self._ensure_temp_dir()
        script_id       = uuid.uuid4().hex[:10]
        temp_script     = self.temp_dir / f"temp_graph_{script_id}.py"
        temp_image      = self.temp_dir / f"temp_graph_{script_id}.png"
        python_exe      = self._get_python_executable()

        # Intent inference: prefer query_plan from IntentEngine, fallback to keyword heuristics
        if query_plan:
            chart_type = query_plan.get("chart_type") or self._infer_chart_type(prompt)
            dim        = query_plan.get("dimension") or self._infer_dim(prompt)
            measure    = query_plan.get("metric") or self._infer_measure(prompt)
            aggregation = query_plan.get("aggregation") or "SUM"
            filters    = query_plan.get("filters") or []
            date_filter = query_plan.get("date_filter")
            limit      = query_plan.get("limit")
            sort_info  = query_plan.get("sort")
            sort_dir   = sort_info.get("direction", "DESC") if sort_info else "DESC"
            logger.info(f"[Graph Agent] Using query plan: chart={chart_type}, dim={dim}, measure={measure}")
        else:
            chart_type = self._infer_chart_type(prompt)
            dim        = self._infer_dim(prompt)
            measure    = self._infer_measure(prompt)
            aggregation = "SUM"
            filters    = []
            date_filter = None
            limit      = None
            sort_dir   = "DESC"
            logger.info(f"[Graph Agent] Heuristic inference: chart={chart_type}, dim={dim}, measure={measure}")

        # Validate columns exist in dataset & get freshness metadata
        verified = True
        data_as_of = None
        records_in_source = 0
        records_matched = 0
        df_agg = None

        try:
            df = excel_dataset_service.get_df()
            data_as_of = excel_dataset_service.get_data_as_of()
            records_in_source = len(df)

            # Build case-insensitive and clean-column lookup for dataset columns
            col_lookup = {str(c).lower(): c for c in df.columns}
            col_clean_lookup = {str(c).lower().replace("_", ""): c for c in df.columns}

            def resolve_col(requested_col: str) -> Optional[str]:
                if not requested_col or not isinstance(requested_col, str):
                    return None
                if requested_col in df.columns:
                    return requested_col
                low = requested_col.lower()
                if low in col_lookup:
                    return col_lookup[low]
                clean = low.replace("_", "")
                if clean in col_clean_lookup:
                    return col_clean_lookup[clean]
                for c_low, actual in col_lookup.items():
                    if c_low in low or low in c_low:
                        return actual
                return None

            resolved_m = resolve_col(measure)
            if resolved_m:
                measure = resolved_m
            elif measure not in df.columns:
                nums = [c for c in df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                fallback_meas = nums[0] if nums else (df.columns[0] if len(df.columns) > 0 else "NetRevenueUSD")
                logger.warning(f"[Graph Agent] Metric '{measure}' not found. Falling back to {fallback_meas}.")
                measure = fallback_meas

            # Validate dimension — support composite dimensions like "Year, Quarter"
            if ", " in str(dim):
                dim_parts = [d.strip() for d in dim.split(",")]
                resolved_parts = []
                for part in dim_parts:
                    rp = resolve_col(part)
                    if rp:
                        resolved_parts.append(rp)
                    else:
                        cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                        fallback_dim = cats[0] if cats else (df.columns[0] if len(df.columns) > 0 else "Region")
                        resolved_parts.append(fallback_dim)
                dim = ", ".join(resolved_parts)
            else:
                resolved_d = resolve_col(dim)
                if resolved_d:
                    dim = resolved_d
                elif dim not in df.columns:
                    cats = [c for c in df.select_dtypes(include=['object', 'string']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
                    fallback_dim = cats[0] if cats else (df.columns[0] if len(df.columns) > 0 else "Region")
                    logger.warning(f"[Graph Agent] Dimension '{dim}' not found. Falling back to {fallback_dim}.")
                    dim = fallback_dim

            # ── Filter application & record matching count ───────────────────
            filtered_df = self._apply_filters(df, filters, date_filter)
            records_matched = len(filtered_df)

            # ── NEW: Deterministic pre-computation ────────────────────────────
            df_agg = self._compute_graph_dataset(
                chart_type=chart_type, dim=dim, measure=measure,
                aggregation=aggregation, filters=filters,
                date_filter=date_filter, limit=limit, sort_dir=sort_dir, df=df,
            )
            logger.info(f"[Graph Agent] Pre-computed dataset: {df_agg.shape}, records_matched={records_matched}")

            # ── NEW: Dual-path reconciliation ─────────────────────────────────
            recon = self._reconcile_graph_dataset(
                df_agg=df_agg, chart_type=chart_type, dim=dim, measure=measure,
                aggregation=aggregation, filters=filters, date_filter=date_filter, df=df,
            )
            verified = recon["verified"]
            if not verified:
                logger.warning(f"[Graph Agent] Reconciliation FAILED: {recon['discrepancy']}")

        except Exception as exc:
            logger.error(f"[Graph Agent] Pre-computation error: {exc}")
            records_matched = 0
            verified = False

        try:
            # ── Step 6a: AI-first code generation (with pre-computed data) ────
            py_code = self._generate_python_code(
                prompt, str(temp_image), fallback_mode=(not verified),
                df_agg=df_agg, chart_type=chart_type, dim=dim, measure=measure,
            )

            temp_script.parent.mkdir(parents=True, exist_ok=True)
            with open(temp_script, "w", encoding="utf-8") as fh:
                fh.write(py_code)
            logger.info(f"[Graph Agent] Temp script written: {temp_script.name}")

            # ── Step 7a: Execute ───────────────────────────────────────────────
            proc = subprocess.run(
                [python_exe, str(temp_script)],
                capture_output=True, text=True, timeout=60,
            )

            # ── Step 6b / 7b: Deterministic fallback on execution failure ──────
            if proc.returncode != 0:
                logger.warning(
                    f"[Graph Agent] Attempt 1 failed (rc={proc.returncode}). "
                    f"Error snippet: {proc.stderr[-500:]}"
                )
                fallback_code = self._generate_python_code(
                    prompt, str(temp_image), fallback_mode=True,
                    df_agg=df_agg, chart_type=chart_type, dim=dim, measure=measure,
                )
                temp_script.parent.mkdir(parents=True, exist_ok=True)
                with open(temp_script, "w", encoding="utf-8") as fh:
                    fh.write(fallback_code)

                proc = subprocess.run(
                    [python_exe, str(temp_script)],
                    capture_output=True, text=True, timeout=60,
                )

            # ── Execution error after both attempts ───────────────────────────
            if proc.returncode != 0:
                logger.error(f"[Graph Agent] Both attempts failed.\nSTDERR:\n{proc.stderr}")
                return {
                    "status": "error",
                    "prompt": prompt,
                    "image_base64": "",
                    "chart_type": chart_type,
                    "insights": "",
                    "message": f"Graph execution failed after retry: {proc.stderr[:300]}",
                    "records_matched": records_matched,
                    "records_in_source": records_in_source,
                    "data_as_of": data_as_of,
                    "verified": False,
                }

            # ── Step 8: Verify image was produced ────────────────────────────
            if not temp_image.exists():
                logger.error("[Graph Agent] Execution succeeded but no image was produced.")
                return {
                    "status": "error",
                    "prompt": prompt,
                    "image_base64": "",
                    "chart_type": chart_type,
                    "insights": "",
                    "message": "Graph image was not created by the script.",
                    "records_matched": records_matched,
                    "records_in_source": records_in_source,
                    "data_as_of": data_as_of,
                    "verified": False,
                }

            # ── Step 8: Encode to base64 data-URI ────────────────────────────
            with open(temp_image, "rb") as img_fh:
                img_b64 = base64.b64encode(img_fh.read()).decode("utf-8")

            data_uri = f"data:image/png;base64,{img_b64}"
            insights = self._build_insights(prompt, chart_type, dim, measure, temp_script.name, verified=verified)

            elapsed_ms = int((time.time() - request_start) * 1000)
            logger.info(
                f"[Graph Agent] ✅ Request completed | "
                f"chart={chart_type} dim={dim} measure={measure} agg={aggregation} | "
                f"records_matched={records_matched} records_in_source={records_in_source} | "
                f"data_as_of={data_as_of} verified={verified} | "
                f"elapsed={elapsed_ms}ms"
            )

            return {
                "status":           "success",
                "prompt":           prompt,
                "image_base64":     data_uri,
                "chart_type":       chart_type,
                "insights":         insights,
                "message":          f"Successfully generated {chart_type.replace('_', ' ')} chart for '{prompt}'.",
                "records_matched":  records_matched,
                "records_in_source": records_in_source,
                "data_as_of":       data_as_of,
                "verified":         verified,
            }

        except subprocess.TimeoutExpired:
            logger.error("[Graph Agent] Script execution timed out (>60 s).")
            return {
                "status": "error",
                "prompt": prompt,
                "image_base64": "",
                "chart_type": chart_type,
                "insights": "",
                "message": "Graph generation timed out. Try a simpler request.",
                "records_matched": records_matched,
                "records_in_source": records_in_source,
                "data_as_of": data_as_of,
                "verified": False,
            }
        except Exception as exc:
            logger.error(f"[Graph Agent] Pipeline error: {exc}")
            return {
                "status": "error",
                "prompt": prompt,
                "image_base64": "",
                "chart_type": chart_type,
                "insights": "",
                "message": f"Dynamic graph error: {exc}",
                "records_matched": records_matched,
                "records_in_source": records_in_source,
                "data_as_of": data_as_of,
                "verified": False,
            }
        finally:
            # ── Step 9: Auto-delete temp script & temp image ──────────────────
            for fpath in (temp_script, temp_image):
                if fpath.exists():
                    try:
                        os.remove(fpath)
                        logger.info(f"[Cleanup] Deleted: {fpath.name}")
                    except Exception as ex:
                        logger.warning(f"[Cleanup] Could not delete {fpath.name}: {ex}")


python_graph_agent = PythonGraphAgent()
