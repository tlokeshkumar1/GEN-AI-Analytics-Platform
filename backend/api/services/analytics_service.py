"""Natural-language adapter over the shared deterministic analytical executor."""
import time
from api.services.analytics_engine import analytics_engine
from api.services.intent_engine import intent_engine


class AnalyticsService:
    def process_analytics_query(self, query):
        started = time.perf_counter()
        try:
            plan = intent_engine.classify(query)
            if not isinstance(plan, dict):
                plan = {}

            # Normalize chart type to allowed values: bar, line, scatter, pie
            chart_type = plan.get("chart_type")
            if chart_type and chart_type not in ("bar", "line", "scatter", "pie"):
                if chart_type in ("donut", "area"):
                    plan["chart_type"] = "pie" if chart_type == "donut" else "line"
                else:
                    plan["chart_type"] = "bar"

            # Ensure metric and aggregation are valid
            if plan.get("metric") and not plan.get("aggregation"):
                plan["aggregation"] = "SUM"

            # Filter allowed keys for QueryPlan validation
            allowed_keys = {
                "intent", "metric", "aggregation", "dimension", "dimensions",
                "measures", "filters", "date_filter", "time_grouping", "joins",
                "derived_metrics", "comparison", "sort", "limit", "chart_type",
                "requires_vector_search", "requires_structured_query"
            }
            clean_plan = {k: v for k, v in plan.items() if k in allowed_keys and v is not None}
            if "filters" not in clean_plan:
                clean_plan["filters"] = []

            parsing_ms = (time.perf_counter() - started) * 1000
            result = analytics_engine.execute(clean_plan)

            return {
                "query": query,
                "generated_sql": "",
                "execution_backend": "pandas",
                "execution_label": "Executed with the deterministic DataFrame engine",
                "status": getattr(result, "status", "success" if result.success else "invalid_query"),
                "results": result.data or [],
                "summary_insights": result.error or ("No matching records." if not result.data else f"Calculated from {result.records_matched} matching records."),
                "recommended_chart": plan.get("chart_type") or "table",
                "parsing_latency": parsing_ms,
                "execution_time_ms": getattr(result, "execution_time_ms", 0),
                "hana_latency": None,
                "sql_determinism": None,
                "records_scanned": getattr(result, "records_total", 0),
                "records_matched": getattr(result, "records_matched", 0),
                "query_plan": clean_plan,
            }
        except Exception as e:
            parsing_ms = (time.perf_counter() - started) * 1000
            return {
                "query": query,
                "generated_sql": "",
                "execution_backend": "pandas",
                "execution_label": "Execution Error",
                "status": "invalid_query",
                "results": [],
                "summary_insights": f"Query could not be parsed: {str(e)}",
                "recommended_chart": "table",
                "parsing_latency": parsing_ms,
                "execution_time_ms": 0,
                "hana_latency": None,
                "sql_determinism": None,
                "records_scanned": 0,
                "records_matched": 0,
                "query_plan": {},
            }


analytics_service = AnalyticsService()
