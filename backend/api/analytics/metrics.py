from typing import List, Dict, Any

class AnalyticsMetrics:
    def calculate_totals(self, data: List[Dict[str, Any]]) -> Dict[str, float]:
        revenue = sum(row.get("TOTAL_REVENUE", 0) for row in data if isinstance(row.get("TOTAL_REVENUE"), (int, float)))
        profit = sum(row.get("TOTAL_PROFIT", 0) for row in data if isinstance(row.get("TOTAL_PROFIT"), (int, float)))
        return {"total_revenue": revenue, "total_profit": profit}

analytics_metrics = AnalyticsMetrics()
