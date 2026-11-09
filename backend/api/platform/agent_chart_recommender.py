"""
Agent 3: Visualization & Chart Recommendation Agent
====================================================
Analyzes clean dataset distributions and inferred domain semantics to propose
the top 4-6 curated analytical charts and KPI scorecards with live preview data
and '[x] Include on Dashboard' approval support.
"""

from typing import Dict, Any, List, Optional
import pandas as pd
import numpy as np

from api.platform.contracts import SemanticModel, SemanticField
from api.models.query_plan import QueryPlan
from api.utils.logger import get_logger

logger = get_logger("agent.chart_recommender")


class ChartRecommenderAgent:
    """
    Autonomous visualization recommendation agent.
    Proposes domain-tailored charts and KPI scorecards with precomputed preview data.
    """

    def recommend(self, df: pd.DataFrame, model: SemanticModel) -> List[Dict[str, Any]]:
        """
        Generate 4 to 6 recommended chart and KPI definitions.
        """
        if df is None or df.empty or not model or not model.fields:
            return []

        measures = [f for f in model.fields if f.role == "measure"]
        dimensions = [f for f in model.fields if f.role == "dimension"]
        time_fields = [f for f in model.fields if f.role == "time"]
        identifiers = [f for f in model.fields if f.role == "identifier"]

        recommendations: List[Dict[str, Any]] = []

        # ── 1. Top KPI Stat Tiles (1 to 3 tiles) ─────────────────────────────
        for idx, m in enumerate(measures[:2]):
            agg = m.default_aggregation or "SUM"
            val = self._compute_kpi_value(df, m.name, agg)
            unit_prefix = "$" if m.currency == "USD" else ""
            unit_suffix = "%" if m.unit == "%" else ""
            formatted = f"{unit_prefix}{val:,.2f}{unit_suffix}" if isinstance(val, (int, float)) else str(val)

            recommendations.append({
                "id": f"rec_kpi_{m.name.lower()}",
                "title": f"Total {m.semantic_name}",
                "kind": "kpi",
                "revision": 1,
                "semantic_revision": model.revision,
                "query_plan": {
                    "intent": "analytical",
                    "metric": m.name,
                    "aggregation": agg,
                    "dimension": None,
                    "filters": []
                },
                "explanation": f"Primary {model.domain} executive scorecard tracking {m.semantic_name}.",
                "selected_by_default": True,
                "preview_value": formatted,
                "status": "proposed"
            })

        # KPI for primary count
        if identifiers:
            id_col = identifiers[0].name
            count_val = int(df[id_col].nunique())
            recommendations.append({
                "id": f"rec_kpi_count_{id_col.lower()}",
                "title": f"Total {identifiers[0].semantic_name}s",
                "kind": "kpi",
                "revision": 1,
                "semantic_revision": model.revision,
                "query_plan": {
                    "intent": "analytical",
                    "metric": id_col,
                    "aggregation": "COUNT_DISTINCT",
                    "dimension": None,
                    "filters": []
                },
                "explanation": f"Total volume count of distinct {identifiers[0].semantic_name} records.",
                "selected_by_default": True,
                "preview_value": f"{count_val:,}",
                "status": "proposed"
            })

        primary_measure = measures[0] if measures else None

        # ── 2. Temporal Trend Chart (Line / Area) ────────────────────────────
        if time_fields and primary_measure:
            time_col = time_fields[0].name
            trend_data = self._compute_trend_preview(df, time_col, primary_measure.name, primary_measure.default_aggregation or "SUM")
            if trend_data:
                recommendations.append({
                    "id": f"rec_trend_{time_col.lower()}_{primary_measure.name.lower()}",
                    "title": f"{primary_measure.semantic_name} Trajectory over {time_fields[0].semantic_name}",
                    "kind": "line",
                    "revision": 1,
                    "semantic_revision": model.revision,
                    "query_plan": {
                        "intent": "analytical",
                        "metric": primary_measure.name,
                        "aggregation": primary_measure.default_aggregation or "SUM",
                        "dimension": time_col,
                        "sort": {"column": time_col, "direction": "ASC"},
                        "filters": []
                    },
                    "explanation": f"Temporal progression showing {primary_measure.semantic_name} movement over time.",
                    "selected_by_default": True,
                    "preview_rows": trend_data,
                    "status": "proposed"
                })

        # ── 3. Categorical Breakdown (Bar Chart) ─────────────────────────────
        # Pick dimension with optimal cardinality (3 to 15 distinct values)
        bar_dim = self._find_best_dimension(df, dimensions, min_card=3, max_card=15)
        if bar_dim and primary_measure:
            bar_data = self._compute_category_preview(df, bar_dim.name, primary_measure.name, primary_measure.default_aggregation or "SUM", limit=10)
            if bar_data:
                recommendations.append({
                    "id": f"rec_bar_{bar_dim.name.lower()}_{primary_measure.name.lower()}",
                    "title": f"{primary_measure.semantic_name} by {bar_dim.semantic_name}",
                    "kind": "bar",
                    "revision": 1,
                    "semantic_revision": model.revision,
                    "query_plan": {
                        "intent": "analytical",
                        "metric": primary_measure.name,
                        "aggregation": primary_measure.default_aggregation or "SUM",
                        "dimension": bar_dim.name,
                        "sort": {"column": primary_measure.name, "direction": "DESC"},
                        "limit": 10,
                        "filters": []
                    },
                    "explanation": f"Categorical distribution comparing {primary_measure.semantic_name} across {bar_dim.semantic_name}.",
                    "selected_by_default": True,
                    "preview_rows": bar_data,
                    "status": "proposed"
                })

        # ── 4. Composition Share (Donut / Pie Chart) ────────────────────────
        # Pick low-cardinality dimension (2 to 6 values)
        donut_dim = self._find_best_dimension(df, dimensions, min_card=2, max_card=6, exclude=bar_dim.name if bar_dim else None)
        if donut_dim and primary_measure:
            donut_data = self._compute_category_preview(df, donut_dim.name, primary_measure.name, primary_measure.default_aggregation or "SUM", limit=6)
            if donut_data:
                recommendations.append({
                    "id": f"rec_donut_{donut_dim.name.lower()}_{primary_measure.name.lower()}",
                    "title": f"{donut_dim.semantic_name} Share Breakdown",
                    "kind": "donut",
                    "revision": 1,
                    "semantic_revision": model.revision,
                    "query_plan": {
                        "intent": "analytical",
                        "metric": primary_measure.name,
                        "aggregation": primary_measure.default_aggregation or "SUM",
                        "dimension": donut_dim.name,
                        "sort": {"column": primary_measure.name, "direction": "DESC"},
                        "limit": 6,
                        "filters": []
                    },
                    "explanation": f"Proportional composition showing {donut_dim.semantic_name} contribution.",
                    "selected_by_default": False,
                    "preview_rows": donut_data,
                    "status": "proposed"
                })

        # ── 5. Top-N Ranking (Horizontal Bar) ────────────────────────────────
        rank_dim = self._find_best_dimension(df, dimensions, min_card=8, max_card=100, exclude=bar_dim.name if bar_dim else None)
        if rank_dim and primary_measure:
            rank_data = self._compute_category_preview(df, rank_dim.name, primary_measure.name, primary_measure.default_aggregation or "SUM", limit=10)
            if rank_data:
                recommendations.append({
                    "id": f"rec_rank_{rank_dim.name.lower()}_{primary_measure.name.lower()}",
                    "title": f"Top 10 {rank_dim.semantic_name}s by {primary_measure.semantic_name}",
                    "kind": "horizontal_bar",
                    "revision": 1,
                    "semantic_revision": model.revision,
                    "query_plan": {
                        "intent": "ranking",
                        "metric": primary_measure.name,
                        "aggregation": primary_measure.default_aggregation or "SUM",
                        "dimension": rank_dim.name,
                        "sort": {"column": primary_measure.name, "direction": "DESC"},
                        "limit": 10,
                        "filters": []
                    },
                    "explanation": f"Leaderboard ranking of top performing {rank_dim.semantic_name}s.",
                    "selected_by_default": False,
                    "preview_rows": rank_data,
                    "status": "proposed"
                })

        logger.info(f"[ChartRecommenderAgent] Generated {len(recommendations)} curated recommendations.")
        return recommendations

    def _compute_kpi_value(self, df: pd.DataFrame, col: str, agg: str) -> float:
        """Safely compute scalar KPI."""
        try:
            series = pd.to_numeric(df[col], errors='coerce').dropna()
            if agg == "AVG":
                return float(series.mean()) if not series.empty else 0.0
            elif agg == "COUNT":
                return float(len(series))
            return float(series.sum()) if not series.empty else 0.0
        except Exception:
            return 0.0

    def _compute_trend_preview(self, df: pd.DataFrame, time_col: str, measure_col: str, agg: str) -> List[Dict[str, Any]]:
        """Compute aggregated monthly/date trend preview."""
        try:
            temp = df[[time_col, measure_col]].dropna().copy()
            temp[measure_col] = pd.to_numeric(temp[measure_col], errors='coerce')
            grouped = temp.groupby(time_col)[measure_col].agg('mean' if agg == "AVG" else 'sum').reset_index()
            grouped = grouped.sort_values(by=time_col).head(15)
            return [
                {time_col: str(row[time_col]), measure_col: round(float(row[measure_col]), 2)}
                for _, row in grouped.iterrows()
            ]
        except Exception:
            return []

    def _compute_category_preview(self, df: pd.DataFrame, dim_col: str, measure_col: str, agg: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Compute aggregated categorical breakdown preview."""
        try:
            temp = df[[dim_col, measure_col]].dropna().copy()
            temp[measure_col] = pd.to_numeric(temp[measure_col], errors='coerce')
            grouped = temp.groupby(dim_col)[measure_col].agg('mean' if agg == "AVG" else 'sum').reset_index()
            grouped = grouped.sort_values(by=measure_col, ascending=False).head(limit)
            return [
                {dim_col: str(row[dim_col]), measure_col: round(float(row[measure_col]), 2)}
                for _, row in grouped.iterrows()
            ]
        except Exception:
            return []

    def _find_best_dimension(self, df: pd.DataFrame, dimensions: List[SemanticField], min_card: int, max_card: int, exclude: Optional[str] = None) -> Optional[SemanticField]:
        """Find dimension matching cardinality constraints."""
        for d in dimensions:
            if exclude and d.name == exclude:
                continue
            card = df[d.name].nunique()
            if min_card <= card <= max_card:
                return d
        # Fallback to any dimension
        for d in dimensions:
            if not exclude or d.name != exclude:
                return d
        return None


chart_recommender_agent = ChartRecommenderAgent()

