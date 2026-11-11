"""Tests for meaningful, data-driven, non-repetitive KPI & chart recommendations."""
import json
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.models.execution_context import current_identity
from api.platform.agent_chart_recommender import (
    ChartRecommenderAgent,
    concept_signature,
    recommendation_signature,
)
from api.platform.agent_domain_classifier import DomainClassifierAgent
from api.platform.contracts import SemanticField, SemanticModel
from api.platform.ingestion import IngestionService
from api.platform.semantic import SemanticRegistry
from api.platform.store import MetadataStore
from api.services.analytics_engine import AnalyticsEngine
from api.services.dataset_service import DatasetService


class RecommendationQualityAndDeduplicationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = MetadataStore(Path(self.tempdir.name) / "test.sqlite3", backend="sqlite")
        self.registry = SemanticRegistry(self.store)
        self.entry = {
            "id": "ds-rec-test",
            "workspaceId": "ws-test",
            "owner": "owner",
            "visibility": "private",
            "currentVersion": 1,
        }
        self.token = current_identity.set({"user_id": "owner", "workspace_id": "ws-test", "roles": ["Admin"], "role": "Admin"})
        self.recommender = ChartRecommenderAgent()
        self.engine = AnalyticsEngine()

    def tearDown(self):
        current_identity.reset(self.token)
        self.tempdir.cleanup()

    def _sales_dataframe_and_model(self):
        dates = pd.date_range("2025-01-01", periods=24, freq="7D").strftime("%Y-%m-%d").tolist()
        regions = ["North", "South", "East", "West"] * 6
        categories = ["Cloud", "Analytics", "Security"] * 8
        channels = ["Direct", "Partner"] * 12
        rows = []
        for i in range(24):
            rows.append(
                {
                    "OrderID": f"ORD-{1000 + i}",
                    "OrderDate": dates[i],
                    "Region": regions[i],
                    "Category": categories[i],
                    "Channel": channels[i],
                    "Revenue": round(1000.0 + i * 125.5, 2),
                    "MarginPct": round(18.0 + (i % 5) * 2.5, 2),
                    "ConstantFlag": 1,
                    "MostlyEmpty": None if i < 23 else 5.0,
                    "Notes": f"Unique order comment number {i}",
                }
            )
        df = pd.DataFrame(rows)
        df["OrderDate"] = pd.to_datetime(df["OrderDate"])

        model = SemanticModel(
            dataset_id="ds-rec-test",
            data_version=1,
            revision=1,
            domain="Enterprise B2B Sales",
            grain="One customer order line",
            status="approved",
            fields=[
                SemanticField(name="OrderID", semantic_name="Order ID", type="identifier", role="identifier", aggregations=["COUNT", "COUNT_DISTINCT"], default_aggregation="COUNT_DISTINCT"),
                SemanticField(name="OrderDate", semantic_name="Order Date", type="date", role="time", aggregations=["COUNT", "COUNT_DISTINCT"]),
                SemanticField(name="Region", semantic_name="Region", type="string", role="dimension", aggregations=["COUNT", "COUNT_DISTINCT"]),
                SemanticField(name="Category", semantic_name="Product Category", type="string", role="dimension", aggregations=["COUNT", "COUNT_DISTINCT"]),
                SemanticField(name="Channel", semantic_name="Sales Channel", type="string", role="dimension", aggregations=["COUNT", "COUNT_DISTINCT"]),
                SemanticField(name="Revenue", semantic_name="Revenue", type="decimal", role="measure", currency="USD", aggregations=["SUM", "AVG", "MIN", "MAX", "COUNT"], default_aggregation="SUM"),
                SemanticField(name="MarginPct", semantic_name="Margin Pct", type="decimal", role="measure", unit="%", aggregations=["AVG", "MIN", "MAX", "COUNT"], default_aggregation="AVG"),
                SemanticField(name="ConstantFlag", semantic_name="Constant Flag", type="integer", role="measure", aggregations=["SUM", "AVG", "COUNT"], default_aggregation="SUM"),
                SemanticField(name="MostlyEmpty", semantic_name="Mostly Empty", type="decimal", role="measure", aggregations=["SUM", "AVG", "COUNT"], default_aggregation="SUM"),
                SemanticField(name="Notes", semantic_name="Notes", type="string", role="dimension", aggregations=["COUNT", "COUNT_DISTINCT"]),
            ],
        )
        return df, model

    def test_generates_meaningful_non_repetitive_recommendations_and_ignores_noise_columns(self):
        df, model = self._sales_dataframe_and_model()
        with patch("api.services.ai_core_service.ai_core_service.generate_structured_completion", return_value=None):
            recs = self.recommender.recommend(df, model, max_items=6)

        self.assertGreaterEqual(len(recs), 4)
        signatures = [recommendation_signature(r) for r in recs]
        self.assertEqual(len(signatures), len(set(signatures)), "Recommendations must not repeat signatures")

        # Constant, mostly empty, and free-text columns must not appear
        all_deps = {dep for r in recs for dep in r.get("dependencies", [])}
        self.assertNotIn("ConstantFlag", all_deps)
        self.assertNotIn("MostlyEmpty", all_deps)
        self.assertNotIn("Notes", all_deps)

        # Rate/percentage AVG metric must not be titled "Total Margin Pct"
        margin_kpis = [r for r in recs if r["kind"] == "kpi" and "MarginPct" in r.get("dependencies", [])]
        for kpi in margin_kpis:
            self.assertNotIn("total", kpi["title"].lower())
            self.assertEqual(kpi["query_plan"]["aggregation"], "AVG")

        # Dense date column should use time_grouping and execute cleanly
        trend_charts = [r for r in recs if r["kind"] in ("line", "area")]
        self.assertTrue(trend_charts, "Expected at least one temporal trend chart")
        self.assertIn("time_grouping", trend_charts[0]["query_plan"])

        # Every recommended QueryPlan must execute cleanly against df
        for r in recs:
            exec_res = self.engine.execute(r["query_plan"], dataframe=df, semantic_model=model)
            self.assertTrue(exec_res.success, f"Failed executing {r['title']}: {exec_res.error}")
            self.assertTrue(exec_res.data, f"Empty result for {r['title']}")

    def test_categorical_only_dataset_still_yields_meaningful_count_charts(self):
        df = pd.DataFrame(
            [
                {"TicketID": f"T-{i}", "Priority": ["High", "Medium", "Low"][i % 3], "Team": ["Platform", "Infra", "Data", "Sec"][i % 4]}
                for i in range(12)
            ]
        )
        model = SemanticModel(
            dataset_id="ds-rec-test",
            data_version=1,
            revision=1,
            domain="IT Support Tickets",
            grain="One support ticket",
            status="approved",
            fields=[
                SemanticField(name="TicketID", semantic_name="Ticket ID", type="identifier", role="identifier", aggregations=["COUNT", "COUNT_DISTINCT"], default_aggregation="COUNT_DISTINCT"),
                SemanticField(name="Priority", semantic_name="Priority", type="string", role="dimension", aggregations=["COUNT", "COUNT_DISTINCT"]),
                SemanticField(name="Team", semantic_name="Assigned Team", type="string", role="dimension", aggregations=["COUNT", "COUNT_DISTINCT"]),
            ],
        )
        with patch("api.services.ai_core_service.ai_core_service.generate_structured_completion", return_value=None):
            recs = self.recommender.recommend(df, model, max_items=6)
        self.assertGreaterEqual(len(recs), 2)
        self.assertTrue(any(r["kind"] != "kpi" for r in recs), "Expected breakdown charts even without numeric measures")

    def test_propose_analytics_preserves_upload_recommendations_and_never_duplicates(self):
        df, model = self._sales_dataframe_and_model()
        csv_bytes = df.assign(OrderDate=df["OrderDate"].dt.strftime("%Y-%m-%d")).to_csv(index=False).encode("utf-8")
        prepared_df, _ = IngestionService().prepare(csv_bytes, "sales.csv")
        snapshot = {
            "columns": DatasetService._columns(prepared_df),
            "rows": DatasetService._rows(prepared_df),
        }

        proposed_model = self.registry.propose(self.entry, 1, snapshot, model.model_dump(mode="json"))
        approved = self.registry.review(self.entry, 1, proposed_model.revision, "approved")

        # 1. Simulate Agent 3 upload recommendations persisted as proposed (or published after upload)
        with patch("api.services.ai_core_service.ai_core_service.generate_structured_completion", return_value=None):
            upload_recs = self.recommender.recommend(prepared_df, approved, max_items=5)
            persisted_upload = self.registry.persist_recommendations(self.entry, 1, approved.revision, upload_recs, model=approved)
            self.assertEqual(len(persisted_upload), len(upload_recs))
            upload_ids = {i.id for i in persisted_upload}

            # 2. Simulate user clicking "Propose AI Recommendations" in Build Your KPI
            plan1 = self.registry.propose_analytics(self.entry, 1, approved.revision, snapshot)
            all_after_first = self.registry.items(self.entry, 1, approved.revision)

            # Existing upload-generated definitions MUST still exist
            self.assertTrue(upload_ids.issubset({i.id for i in all_after_first}))
            # Combined signatures MUST have zero duplicates
            sigs1 = [recommendation_signature(i) for i in all_after_first]
            self.assertEqual(len(sigs1), len(set(sigs1)), "Duplicates found after first propose_analytics call")
            self.assertGreater(len(all_after_first), len(persisted_upload))

            # 3. Click "Propose AI Recommendations" multiple more times until exhausted
            self.registry.propose_analytics(self.entry, 1, approved.revision, snapshot)
            plan3 = self.registry.propose_analytics(self.entry, 1, approved.revision, snapshot)
            all_after_third = self.registry.items(self.entry, 1, approved.revision)
            sigs3 = [recommendation_signature(i) for i in all_after_third]
            self.assertEqual(len(sigs3), len(set(sigs3)), "Duplicates found across repeated propose_analytics calls")
            self.assertIsInstance(plan1.items, list)
            self.assertIsInstance(plan3.items, list)

    def test_concurrent_workflow_saves_do_not_conflict(self):
        from concurrent.futures import ThreadPoolExecutor
        import contextvars
        from unittest.mock import patch
        from api.platform import workflow as workflow_mod

        with patch.object(workflow_mod, "semantic_registry", self.registry):
            orch = workflow_mod.WorkflowOrchestrator()

            def _save(idx: int):
                return orch.save(
                    self.entry,
                    1,
                    "analytics_review",
                    "awaiting_review",
                    {"last_reviewed_item": {"id": f"item_{idx}", "revision": 1, "decision": "approved"}},
                )

            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = [pool.submit(contextvars.copy_context().run, _save, i) for i in range(6)]
                results = [f.result() for f in futures]
            self.assertEqual(len(results), 6)

    def test_domain_classifier_handles_decimal_tokens_think_tags_and_dataset_name(self):
        df = pd.DataFrame(
            {
                "ClaimID": ["C1", "C2", "C3", "C4", "C5", "C6"],
                "PaidAmount": [Decimal("120.50"), Decimal("240.00"), Decimal("85.25"), Decimal("410.00"), Decimal("95.00"), Decimal("150.75")],
                "IsValid": ["Yes", "Yes", "No", "Yes", "Yes", "No"],
                "DowntimeHours": [2.5, 4.0, 1.0, 3.5, 2.0, 5.0],
                "UpdatedBy": ["Alice", "Bob", "Alice", "Carol", "Bob", "Alice"],
                "ServiceDate": ["2025-01-01", "2025-01-05", "2025-01-12", "2025-02-01", "2025-02-10", "2025-02-18"],
            }
        )
        llm_payload = {
            "domain": "Healthcare Insurance Claims",
            "grain": "One medical insurance claim",
            "column_annotations": {
                "paidamount": {"semantic_name": "Paid Amount", "role": "measure", "default_aggregation": "SUM", "currency": "USD"},
                "downtimehours": {"semantic_name": "Processing Hours", "role": "measure", "default_aggregation": "AVG"},
            },
        }
        raw_llm = f"<think>Inspecting first 5 rows...</think>\n```json\n{json.dumps(llm_payload)}\n```"
        classifier = DomainClassifierAgent()
        with patch("api.services.ai_core_service.ai_core_service.generate_structured_completion", return_value=raw_llm) as mock_llm:
            model = classifier.analyze(df, dataset_id="ds-claims", data_version=1, dataset_name="Medical_Claims_2025.csv")

        self.assertIn("Medical_Claims_2025.csv", mock_llm.call_args.args[0])
        self.assertIn("C1", mock_llm.call_args.args[0])
        self.assertEqual(model.domain, "Healthcare Insurance Claims")
        fields_by_name = {f.name: f for f in model.fields}
        self.assertEqual(fields_by_name["PaidAmount"].role, "measure")
        self.assertEqual(fields_by_name["PaidAmount"].type, "decimal")
        self.assertEqual(fields_by_name["IsValid"].role, "dimension")
        self.assertEqual(fields_by_name["DowntimeHours"].role, "measure")
        self.assertEqual(fields_by_name["UpdatedBy"].role, "dimension")
        self.assertEqual(fields_by_name["ServiceDate"].role, "time")

    def test_chart_recommender_uses_first_5_rows_llm_only_and_never_repeats_existing(self):
        df, model = self._sales_dataframe_and_model()
        existing = [
            {
                "id": "existing_1",
                "title": "Total Revenue",
                "kind": "kpi",
                "query_plan": {"metric": "Revenue", "aggregation": "SUM"},
            },
            {
                "id": "existing_2",
                "title": "Revenue by Region",
                "kind": "bar",
                "query_plan": {"metric": "Revenue", "aggregation": "SUM", "dimension": "Region"},
            },
        ]
        # First LLM response collides with existing items (even using measures syntax and donut kind);
        # retry response provides genuinely new angles.
        collision_resp = json.dumps(
            {
                "recommendations": [
                    {
                        "title": "SUM Revenue",
                        "kind": "kpi",
                        "explanation": "Duplicate KPI",
                        "query_plan": {"measures": [{"field": "Revenue", "aggregation": "SUM"}]},
                    },
                    {
                        "title": "Revenue Share by Region",
                        "kind": "donut",
                        "explanation": "Duplicate chart concept",
                        "query_plan": {"metric": "Revenue", "aggregation": "SUM", "dimension": "Region"},
                    },
                ]
            }
        )
        fresh_resp = json.dumps(
            {
                "recommendations": [
                    {
                        "title": "Average Margin %",
                        "kind": "kpi",
                        "explanation": "Tracks average profit margin percentage.",
                        "selected_by_default": True,
                        "query_plan": {"intent": "analytical", "metric": "MarginPct", "aggregation": "AVG"},
                    },
                    {
                        "title": "Margin % by Sales Channel",
                        "kind": "bar",
                        "explanation": "Compares profitability across sales channels.",
                        "selected_by_default": True,
                        "query_plan": {"intent": "analytical", "metric": "MarginPct", "aggregation": "AVG", "dimension": "Channel"},
                    },
                ]
            }
        )
        with patch(
            "api.services.ai_core_service.ai_core_service.generate_structured_completion",
            side_effect=[collision_resp, fresh_resp],
        ) as mock_llm:
            recs = self.recommender.recommend(df, model, existing_items=existing, max_items=6, dataset_name="B2B_Sales.csv")

        self.assertEqual(mock_llm.call_count, 2)
        self.assertIn("ORD-1000", mock_llm.call_args_list[0].args[0])
        self.assertNotIn("ORD-1006", mock_llm.call_args_list[0].args[0])  # strictly first 5 rows
        # Must NOT pad with hardcoded fallback items when LLM succeeded
        self.assertEqual(len(recs), 2)
        titles = [r["title"] for r in recs]
        self.assertEqual(titles, ["Average Margin %", "Margin % by Sales Channel"])
        existing_concepts = {concept_signature(e) for e in existing}
        for r in recs:
            self.assertNotIn(concept_signature(r), existing_concepts)


if __name__ == "__main__":
    unittest.main()
