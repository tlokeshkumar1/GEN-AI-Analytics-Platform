from typing import Dict, Any, List, Optional
import re
import pandas as pd
from api.services.data_service import data_service
from api.services.schema_service import schema_service
from api.utils.logger import get_logger

logger = get_logger("services.dashboard_service")


def _humanize(name: str) -> str:
    return re.sub(r"([a-z])([A-Z])", r"\1 \2", name.replace("_", " ")).strip().title()


def _format_metric(val: float, name: str) -> str:
    low = name.lower()
    if any(k in low for k in ("pct", "percent", "ratio", "rate")):
        return f"{val:.1f}%"
    if any(k in low for k in ("usd", "revenue", "sales", "salary", "cost", "price", "margin", "amount", "budget", "profit")):
        return f"${val:,.0f}"
    return f"{val:,.0f}"


def _pct_change(curr: float, prev: float) -> tuple[str, str]:
    if prev == 0:
        return "0.0%", "neutral"
    diff = ((curr - prev) / abs(prev)) * 100.0
    sign = "+" if diff > 0 else ""
    trend = "up" if diff > 0 else ("down" if diff < 0 else "neutral")
    return f"{sign}{diff:.1f}%", trend


class DashboardService:
    def get_dashboard_data(self) -> Dict[str, Any]:
        """Get dynamic KPIs and chart series from the active dataset or HANA table."""
        df = data_service.get_dataframe()
        kpis = data_service.get_kpis()

        if df is None or df.empty:
            formatted_kpis = [
                {"title": "Primary Metric", "value": f"{kpis.get('total_revenue', 0):,.0f}", "change": "0.0%", "trend": "neutral"},
                {"title": "Secondary Metric", "value": f"{kpis.get('total_quantity', 0):,}", "change": "0.0%", "trend": "neutral"},
                {"title": "Average Value", "value": f"{kpis.get('avg_margin', 0):,.1f}", "change": "0.0%", "trend": "neutral"},
                {"title": "Distinct Categories", "value": str(kpis.get('country_count', 0)), "change": "0.0%", "trend": "neutral"},
            ]
        else:
            meta = schema_service._build_metadata(df)
            measures = [k for k, v in meta.items() if v.is_measure]
            dimensions = [k for k, v in meta.items() if v.is_dimension and not v.is_identifier]
            date_cols = [k for k, v in meta.items() if v.is_date]

            m1 = measures[0] if measures else None
            m2 = measures[1] if len(measures) > 1 else None
            d1 = dimensions[0] if dimensions else None

            m1_change, m1_trend = "0.0%", "neutral"
            m2_change, m2_trend = "0.0%", "neutral"
            avg_change, avg_trend = "0.0%", "neutral"
            d1_change, d1_trend = "0.0%", "neutral"

            if date_cols and (m1 or d1):
                try:
                    t_col = date_cols[0]
                    temp_df = df.copy()
                    temp_df["_period_sort"] = pd.to_datetime(temp_df[t_col], errors="coerce")
                    if temp_df["_period_sort"].notna().sum() >= 2:
                        temp_df = temp_df.dropna(subset=["_period_sort"])
                        temp_df["_period_key"] = temp_df["_period_sort"].dt.to_period("M").astype(str)
                    else:
                        temp_df["_period_key"] = temp_df[t_col].astype(str)
                        temp_df = temp_df[temp_df["_period_key"].str.strip() != ""]

                    agg_spec: Dict[str, Any] = {"row_cnt": (df.columns[0], "count")}
                    if m1:
                        agg_spec["m1_sum"] = (m1, "sum")
                        agg_spec["m1_avg"] = (m1, "mean")
                    if m2:
                        agg_spec["m2_sum"] = (m2, "sum")
                    if d1:
                        agg_spec["d1_uniq"] = (d1, lambda s: s.dropna().astype(str).str.strip().loc[lambda x: x != ""].nunique())

                    periods = temp_df.groupby("_period_key").agg(**agg_spec).reset_index().sort_values("_period_key")
                    if len(periods) >= 2:
                        curr, prev = periods.iloc[-1], periods.iloc[-2]
                        if m1:
                            m1_change, m1_trend = _pct_change(float(curr["m1_sum"]), float(prev["m1_sum"]))
                            avg_change, avg_trend = _pct_change(float(curr["m1_avg"]), float(prev["m1_avg"]))
                        if m2:
                            m2_change, m2_trend = _pct_change(float(curr["m2_sum"]), float(prev["m2_sum"]))
                        else:
                            m2_change, m2_trend = _pct_change(float(curr["row_cnt"]), float(prev["row_cnt"]))
                        if d1:
                            d1_change, d1_trend = _pct_change(float(curr["d1_uniq"]), float(prev["d1_uniq"]))
                except Exception as exc:
                    logger.debug(f"Period-over-period calculation skipped: {exc}")

            m1_sum = float(pd.to_numeric(df[m1], errors="coerce").sum()) if m1 else float(len(df))
            m1_avg = float(pd.to_numeric(df[m1], errors="coerce").mean()) if m1 else 0.0
            m2_sum = float(pd.to_numeric(df[m2], errors="coerce").sum()) if m2 else float(len(df))
            d1_uniq = int(df[d1].dropna().nunique()) if d1 else int(len(df))

            formatted_kpis = [
                {
                    "title": f"Total {_humanize(m1)}" if m1 else "Total Records",
                    "value": _format_metric(m1_sum, m1) if m1 else f"{len(df):,}",
                    "change": m1_change,
                    "trend": m1_trend,
                },
                {
                    "title": f"Total {_humanize(m2)}" if m2 else "Record Count",
                    "value": _format_metric(m2_sum, m2) if m2 else f"{len(df):,}",
                    "change": m2_change,
                    "trend": m2_trend,
                },
                {
                    "title": f"Average {_humanize(m1)}" if m1 else "Average",
                    "value": _format_metric(m1_avg, m1) if m1 else "0",
                    "change": avg_change,
                    "trend": avg_trend,
                },
                {
                    "title": f"Active {_humanize(d1)}" if d1 else "Unique Records",
                    "value": f"{d1_uniq:,}",
                    "change": d1_change,
                    "trend": d1_trend,
                },
            ]

        return {
            "kpis": formatted_kpis,
            "revenue_trend": data_service.get_revenue_trend(),
            "region_breakdown": data_service.get_region_breakdown(),
            "country_breakdown": data_service.get_country_breakdown(),
            "category_breakdown": data_service.get_category_breakdown(),
            "quarterly_performance": data_service.get_quarterly_performance(),
            "top_products": data_service.get_top_products(),
        }


dashboard_service = DashboardService()
