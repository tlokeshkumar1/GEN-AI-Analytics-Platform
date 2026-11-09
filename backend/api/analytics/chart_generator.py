from typing import List, Dict, Any

class ChartGenerator:
    def recommend_chart_type(self, data: List[Dict[str, Any]]) -> str:
        if not data:
            return "bar"
        first_row = data[0]
        keys = list(first_row.keys())
        if any("DATE" in k.upper() or "MONTH" in k.upper() or "QUARTER" in k.upper() for k in keys):
            return "line"
        if len(data) <= 5:
            return "pie"
        return "bar"

chart_generator = ChartGenerator()
