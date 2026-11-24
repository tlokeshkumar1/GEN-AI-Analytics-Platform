"""Schema-driven chat answers across unrelated domains without provider calls."""

import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from api.config import settings
from api.models.execution_context import (
    DatasetSelection,
    ExecutionContext,
    current_identity,
    current_selection,
)
from api.platform.contracts import SemanticField, SemanticModel
from api.platform.planning import (
    clear_intent_cache,
    classify_request,
    simple_semantic_plan,
)
from api.rag.pipeline import RAGPipeline


class DynamicChatTests(unittest.TestCase):
    def test_named_dataset_retrieval_checks_access_before_search(self):
        from unittest.mock import Mock
        from api.services.vector_service import VectorService

        service = Mock()
        entry = dict(self.selection.entry)
        service._catalog.return_value = {"datasets": {"harvest": entry}}
        with patch("api.services.dataset_service.dataset_service", service):
            VectorService().search_similar_chunks(
                "show data inside Farm measurements", 4
            )
            service.search.assert_called_once_with(
                "show data inside Farm measurements", 4, dataset_id="harvest"
            )
            service.search.reset_mock()
            entry["workspaceId"] = "foreign"
            with self.assertRaises(HTTPException):
                VectorService().search_similar_chunks(
                    "show data inside Farm measurements", 4
                )
            service.search.assert_not_called()

    def setUp(self):
        clear_intent_cache()
        self.addCleanup(clear_intent_cache)
        self.model = SemanticModel(
            dataset_id="harvest",
            data_version=1,
            revision=1,
            status="approved",
            fields=[
                SemanticField(
                    name="HarvestKg",
                    semantic_name="Harvest weight",
                    aliases=["yield"],
                    type="decimal",
                    role="measure",
                    aggregations=["SUM", "AVG"],
                    unit="kg",
                ),
                SemanticField(
                    name="Zone",
                    semantic_name="Growing zone",
                    type="string",
                    role="dimension",
                ),
                SemanticField(
                    name="BatchID",
                    semantic_name="Batch identifier",
                    type="identifier",
                    role="identifier",
                ),
            ],
        )
        entry = dict(
            id="harvest",
            name="Farm measurements",
            workspaceId="default",
            ownerId="owner",
            currentVersion=1,
            versions=[{"version": 1}],
        )
        snapshot = {
            "rows": [
                {"HarvestKg": "0.10", "Zone": "001", "BatchID": "B01"},
                {"HarvestKg": "0.20", "Zone": "002", "BatchID": "B02"},
            ],
            "columns": [{"name": f.name, "type": f.type} for f in self.model.fields],
        }
        self.selection = DatasetSelection(
            ExecutionContext(
                workspace_id="default",
                user_id="owner",
                dataset_id="harvest",
                version=1,
                semantic_revision=1,
            ),
            entry,
            snapshot,
        )
        token = current_selection.set(self.selection)
        self.addCleanup(current_selection.reset, token)
        token = current_identity.set(
            dict(user_id="owner", workspace_id="default", request_channel="chat")
        )
        self.addCleanup(current_identity.reset, token)
        for item in (
            patch(
                "api.platform.semantic.semantic_registry.get", return_value=self.model
            ),
            patch(
                "api.platform.ai_settings.ai_settings",
                return_value={"llm_model": "provider"},
            ),
            patch.object(settings, "NVIDIA_API_KEY", "configured-for-test"),
        ):
            item.start()
            self.addCleanup(item.stop)

    def test_simple_totals_counts_and_grouping_use_exact_values_without_model(self):
        with (
            patch(
                "api.services.ai_core_service.ai_core_service.generate_nvidia_completion"
            ) as planner,
            patch("api.rag.pipeline.generator.generate") as generate,
            patch("api.rag.pipeline.generator.generate_stream") as stream,
            patch("api.rag.pipeline.retriever.retrieve") as retrieve,
            patch(
                "api.platform.join_service.join_service.get_workspace_join_graph"
            ) as joins,
        ):
            for question, expected in (
                ("total yield", "0.3"),
                ("average HarvestKg", "0.15"),
                ("count records", "2"),
            ):
                result = RAGPipeline().run(question)
                self.assertEqual(result["status"], "success", result)
                self.assertIn(expected, result["reply"])
                self.assertNotIn("$", result["reply"])
                self.assertEqual(result["model"], "Deterministic analytics")
            events = []
            grouped = RAGPipeline().run_stream(
                "sum of yield by Zone", event_callback=events.append
            )
            self.assertIn("| 001 | 0.1 |", grouped["reply"])
            self.assertIn("| 002 | 0.2 |", grouped["reply"])
            self.assertTrue(any(event["type"] == "token" for event in events))
            for provider in (planner, generate, stream, retrieve, joins):
                provider.assert_not_called()

    def test_unrelated_schema_and_aliases_resolve_without_sample_business_names(self):
        for metric, dimension, alias in (
            ("BatteryVoltageV", "DeviceSerial", "voltage"),
            ("DelayMinutes", "Station", "delay"),
            ("LoadPercent", "ServerID", "utilization"),
        ):
            model = SemanticModel(
                dataset_id="arbitrary",
                data_version=1,
                revision=1,
                fields=[
                    SemanticField(
                        name=metric,
                        semantic_name=metric,
                        aliases=[alias],
                        type="decimal",
                        role="measure",
                        aggregations=["AVG"],
                    ),
                    SemanticField(
                        name=dimension,
                        semantic_name=dimension,
                        type="string",
                        role="dimension",
                    ),
                ],
            )
            plan = simple_semantic_plan(f"average {alias} by {dimension}", model)
            self.assertEqual(plan["metric"], metric)
            self.assertEqual(plan["dimensions"], [dimension])
            self.assertEqual(plan["aggregation"], "AVG")

    def test_local_planner_does_not_drop_filters_periods_or_multiple_metrics(self):
        for question in (
            "total yield in 2025",
            "total yield where Zone is 001",
            "average yield and BatchID",
            "total unknown_metric",
        ):
            self.assertIsNone(simple_semantic_plan(question, self.model), question)
        with self.assertRaises(HTTPException):
            simple_semantic_plan("sum BatchID", self.model)
        ambiguous = self.model.model_copy(deep=True)
        ambiguous.fields[1].aliases = ["yield"]
        self.assertIsNone(simple_semantic_plan("total yield", ambiguous))

    def test_invalid_analytical_model_response_requests_clarification_without_rag(self):
        with (
            patch(
                "api.platform.join_service.join_service.get_workspace_join_graph",
                return_value=[],
            ),
            patch(
                "api.services.dataset_service.dataset_service._catalog",
                return_value={"datasets": {}},
            ),
            patch(
                "api.services.ai_core_service.ai_core_service.generate_nvidia_completion"
            ) as propose,
        ):
            for proposal in (
                {"intent": "chat"},
                {"metric": "HarvestKg", "aggregation": "BAD"},
                {
                    "metric": "HarvestKg",
                    "aggregation": "SUM",
                    "requires_structured_query": False,
                },
                {"metric": "HarvestKg", "aggregation": "SUM"},
            ):
                import json

                propose.return_value = json.dumps(proposal)
                with self.assertRaises(HTTPException) as raised:
                    classify_request("total yield in 2025")
                self.assertEqual(raised.exception.status_code, 422)

    def test_no_evidence_returns_honest_answer_without_calling_model(self):
        with (
            patch(
                "api.rag.pipeline.intent_engine.classify",
                return_value={"intent": "chat", "requires_structured_query": False},
            ),
            patch("api.rag.pipeline.retriever.retrieve", return_value=[]),
            patch("api.rag.pipeline.generator.generate") as generate,
            patch("api.rag.pipeline.generator.generate_stream") as stream,
        ):
            result = RAGPipeline().run_stream(
                "explain the missing batch", event_callback=lambda event: None
            )
            self.assertEqual(result["status"], "insufficient_evidence")
            self.assertIn("HarvestKg", result["reply"])
            self.assertEqual(result["sources"], [])
            generate.assert_not_called()
            stream.assert_not_called()

    def test_exact_record_values_keep_precision_identifiers_and_units(self):
        record = {
            "BatchID": "000123",
            "Voltage": Decimal("0.123456789123456789"),
            "CostINR": Decimal("17.05"),
            "Rate": 0.25,
            "_resolved_table": "internal",
        }
        answer = (
            "Here are the record details.\n\n"
            + RAGPipeline()._format_full_record_markdown("B123", record)
        )
        with (
            patch(
                "api.rag.pipeline.data_service.get_order_details", return_value=record
            ),
            patch(
                "api.rag.pipeline.generator.generate", return_value=answer
            ) as generate,
        ):
            result = RAGPipeline().run("show record B123")
            for expected in ("000123", "0.123456789123456789", "17.05", "0.25"):
                self.assertIn(expected, result["reply"])
                self.assertIn(
                    expected,
                    generate.call_args.kwargs["prompt"]
                    if "prompt" in generate.call_args.kwargs
                    else generate.call_args.args[0],
                )
            self.assertNotIn("$", result["reply"])
            self.assertNotIn("internal", result["reply"])
            generate.assert_called_once()
        self.assertFalse(RAGPipeline()._is_pure_order_lookup("sum HarvestKg for B123"))

    def test_simulation_requires_declared_unambiguous_financial_measures(self):
        record = {"HarvestKg": 100, "Zone": "East"}
        with (
            patch(
                "api.rag.pipeline.data_service.get_order_details", return_value=record
            ),
            patch("api.rag.pipeline.generator.generate_stream") as stream,
        ):
            result = RAGPipeline().run("what if quantity is 5 for B123")
            self.assertEqual(result["status"], "invalid_query")
            self.assertNotIn("$", result["reply"])
            stream.assert_not_called()
        financial = SemanticModel(
            dataset_id="harvest",
            data_version=1,
            revision=1,
            status="approved",
            fields=[
                SemanticField(
                    name="N",
                    semantic_name="Quantity",
                    type="decimal",
                    role="measure",
                    unit="items",
                    aggregations=["SUM"],
                ),
                SemanticField(
                    name="R",
                    semantic_name="Revenue",
                    type="decimal",
                    role="measure",
                    currency="INR",
                    aggregations=["SUM"],
                ),
                SemanticField(
                    name="C",
                    semantic_name="Cost",
                    type="decimal",
                    role="measure",
                    currency="INR",
                    aggregations=["SUM"],
                ),
            ],
        )
        record = {"N": 10, "R": Decimal("100.50"), "C": Decimal("40.25")}
        with (
            patch(
                "api.rag.pipeline.data_service.get_order_details", return_value=record
            ),
            patch(
                "api.platform.semantic.semantic_registry.get", return_value=financial
            ),
            patch("api.rag.pipeline.generator.generate_stream") as stream,
        ):
            result = RAGPipeline().run("what if quantity is 5 for B123")
            self.assertEqual(result["status"], "success")
            self.assertIn("Revenue (INR) | 100.50 | 50.250", result["reply"])
            self.assertIn("Cost (INR) | 40.25 | 20.125", result["reply"])
            self.assertIn("not a forecast", result["reply"])
            self.assertNotIn("$", result["reply"])
            stream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
