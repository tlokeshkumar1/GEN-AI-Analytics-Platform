import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pandas as pd
from api.platform.contracts import Relationship, SemanticModel, SemanticField, DerivedMetric
from api.platform.formulas import formula, validated_join
from api.services.analytics_engine import AnalyticsEngine


class ReviewedCalculations(unittest.TestCase):
    def test_boolean_filters_and_output_name_collisions(self):
        frame = pd.DataFrame({"Active": [True, False], "Output": [10, 20]})
        engine = AnalyticsEngine()
        result = engine.execute({"metric": "Output", "aggregation": "SUM", "filters": [{"column": "Active", "operator": "=", "value": True}]}, frame)
        self.assertTrue(result.success, result.error)
        self.assertIn(str(result.summary["value"]), ["10", "10.0", "10.00"])
        result = engine.execute({"metric": "Output", "aggregation": "SUM", "derived_metrics": ["Output"]}, frame)
        self.assertFalse(result.success)

    def test_formula_language_and_missing_denominator(self):
        self.assertEqual(formula("profit / revenue * 100", {"profit": Decimal("0.10"), "revenue": Decimal("0.20")}), Decimal(50))
        self.assertIsNone(formula("profit / revenue", {"profit": Decimal(1), "revenue": Decimal(0)}))
        for expression in ["__import__('os').system('x')", "x ** 2", "x[0]", "True"]:
            with self.assertRaises((ValueError, SyntaxError)):
                formula(expression, {"x": Decimal(1)})

    def test_cardinality_rejects_row_multiplication(self):
        relation = Relationship(id="employees", right_dataset_id="hr", right_version=1, right_semantic_revision=1,
                                left_keys=["EmployeeID"], right_keys=["ID"], cardinality="many_to_one")
        left = pd.DataFrame({"EmployeeID": ["001", "001"], "Amount": [10, 20]})
        right = pd.DataFrame({"ID": ["001"], "Department": ["IT"]})
        joined = validated_join(left, right, relation)
        self.assertEqual(len(joined), len(left))
        self.assertEqual(joined["Amount"].sum(), 30)
        with self.assertRaises(ValueError):
            validated_join(left, pd.concat([right, right]), relation)

    def test_approved_derived_metric_uses_ratio_of_totals(self):
        model = SemanticModel(dataset_id="sales", data_version=1, revision=1,
                              fields=[SemanticField(name="Revenue", semantic_name="Revenue", type="decimal", role="measure", aggregations=["SUM"]),
                                      SemanticField(name="Profit", semantic_name="Profit", type="decimal", role="measure", aggregations=["SUM"])],
                              derived_metrics=[DerivedMetric(name="Margin", expression="profit / revenue * 100", description="Weighted margin",
                                                             dependencies={"profit": {"field": "Profit", "aggregation": "SUM"}, "revenue": {"field": "Revenue", "aggregation": "SUM"}})])
        frame = pd.DataFrame({"Revenue": [Decimal(10), Decimal(90)], "Profit": [Decimal(5), Decimal(9)]})
        result = AnalyticsEngine().execute({"derived_metrics": ["Margin"]}, frame, {"Revenue": ["SUM"], "Profit": ["SUM"]}, model)
        self.assertTrue(result.success, result.error)
        self.assertEqual(float(result.data[0]["Margin"]), 14.0)

    def test_period_comparisons_preserve_zero_and_missing_semantics(self):
        frame = pd.DataFrame({"Date": pd.to_datetime(["2024-01-01", "2025-01-01"]), "Output": [Decimal(0), Decimal(20)]})
        result = AnalyticsEngine().execute({"metric": "Output", "aggregation": "SUM", "comparison": {
            "column": "Date", "current_start": "2025-01-01", "current_end": "2025-12-31",
            "previous_start": "2024-01-01", "previous_end": "2024-12-31"}}, frame)
        self.assertTrue(result.success, result.error)
        self.assertEqual(float(result.data[0]["difference_Output"]), 20.0)
        self.assertIsNone(result.data[0]["change_percent_Output"])

    def test_temporal_dimensions_sort_chronologically(self):
        frame = pd.DataFrame({
            "MonthLabel": ["2025-11", "2023-08", "2025-12", "2023-01", "2024-05"],
            "Revenue": [Decimal(10), Decimal(20), Decimal(30), Decimal(40), Decimal(50)]
        })
        result = AnalyticsEngine().execute({"metric": "Revenue", "aggregation": "SUM", "dimension": "MonthLabel"}, frame)
        self.assertTrue(result.success, result.error)
        months = [r["MonthLabel"] for r in result.data]
        self.assertEqual(months, ["2023-01", "2023-08", "2024-05", "2025-11", "2025-12"])


if __name__ == "__main__":
    unittest.main()
