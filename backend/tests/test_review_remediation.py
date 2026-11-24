"""Regression coverage for the code-review findings, with no live providers."""

import copy
import os
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pandas as pd
from fastapi import HTTPException
from api.models.execution_context import (
    DatasetSelection,
    ExecutionContext,
    current_identity,
    current_selection,
    require_dataset_access,
)
from api.platform.contracts import ParseOptions, SemanticField, SemanticModel
from api.platform.data_resolution import current_table
from api.services.analytics_engine import AnalyticsEngine, AnalyticsResult


def selected(version=1, latest=1):
    entry = dict(
        id="sales",
        name="Sales",
        workspaceId="default",
        ownerId="owner",
        readers=[],
        writers=[],
        currentVersion=latest,
        tableName="SALES_CURRENT",
        versions=[{"version": v} for v in range(1, latest + 1)],
    )
    snapshot = {
        "rows": [
            {"ID": "001", "Amount": "0.10", "Date": "2026-01-02"},
            {"ID": "002", "Amount": "0.20", "Date": "2026-02-02"},
        ],
        "columns": [
            {"name": "ID", "type": "identifier"},
            {"name": "Amount", "type": "decimal"},
            {"name": "Date", "type": "date"},
        ],
    }
    return DatasetSelection(
        ExecutionContext(
            workspace_id="default",
            user_id="owner",
            dataset_id="sales",
            version=version,
            semantic_revision=1,
        ),
        entry,
        snapshot,
    )


def semantic():
    return SemanticModel(
        dataset_id="sales",
        data_version=1,
        revision=1,
        status="approved",
        grain="One transaction",
        fields=[
            SemanticField(
                name="ID", semantic_name="ID", type="identifier", role="identifier"
            ),
            SemanticField(
                name="Amount",
                semantic_name="Amount",
                type="decimal",
                role="measure",
                aggregations=["SUM", "AVG"],
            ),
            SemanticField(name="Date", semantic_name="Date", type="date", role="time"),
        ],
    )


class QueryCorrectness(unittest.TestCase):
    def setUp(self):
        self.selection = selected()
        token = current_selection.set(self.selection)
        self.addCleanup(current_selection.reset, token)
        token = current_identity.set(
            dict(user_id="owner", workspace_id="default", roles=["Member"])
        )
        self.addCleanup(current_identity.reset, token)
        self.model = semantic()
        mock = patch(
            "api.platform.semantic.semantic_registry.get", return_value=self.model
        )
        mock.start()
        self.addCleanup(mock.stop)
        mock = patch(
            "api.platform.datasets_metadata_repository.datasets_metadata_repo.load_schema_from_hana",
            return_value=self.selection.snapshot["columns"],
        )
        mock.start()
        self.addCleanup(mock.stop)
        mock = patch("api.database.hana_client.hana_client.execute_query")
        self.query = mock.start()
        self.addCleanup(mock.stop)
        self.engine = AnalyticsEngine()

    def test_date_range_and_filtered_counts_are_in_hana_sql(self):
        self.query.side_effect = [
            [{"Amount": Decimal("0.10")}],
            [{"CNT": 1}],
            [{"CNT": 2}],
        ]
        result = self.engine.execute(
            dict(
                metric="Amount",
                aggregation="SUM",
                date_filter={
                    "column": "Date",
                    "from": "2026-01-01",
                    "to": "2026-01-31",
                },
            )
        )
        self.assertTrue(result.success, result.error)
        sql, params = self.query.call_args_list[0].args
        self.assertIn('"Date" >= ?', sql)
        self.assertIn('"Date" <= ?', sql)
        self.assertEqual(params, ("2026-01-01", "2026-01-31"))
        self.assertEqual((result.records_matched, result.records_total), (1, 2))
        self.assertEqual(result.to_dict()["execution_backend"], "hana")
        self.assertEqual(result.to_dict()["context"]["version"], 1)

    def test_unapproved_aggregation_and_unknown_filters_do_not_reach_sql(self):
        for changes in [
            dict(metric="ID", aggregation="SUM"),
            dict(filters=[dict(column="Other", operator="=", value=1)]),
        ]:
            result = self.engine.execute(
                {"metric": "Amount", "aggregation": "SUM", **changes}
            )
            self.assertFalse(result.success)
            self.query.assert_not_called()

    def test_physical_table_override_is_denied(self):
        result = self.engine.execute(
            dict(metric="Amount", aggregation="SUM", table_name="OTHER_WORKSPACE")
        )
        self.assertFalse(result.success)
        self.query.assert_not_called()

    def test_historical_version_never_reads_mutable_current_table(self):
        selection = selected(version=1, latest=2)
        token = current_selection.set(selection)
        try:
            result = self.engine.execute(dict(metric="Amount", aggregation="SUM"))
            self.assertTrue(result.success, result.error)
            self.assertEqual(result.summary["value"], 0.3)
            self.assertEqual(result.execution_backend, "pandas")
            self.query.assert_not_called()
            self.assertIsNone(current_table(selection.entry, 1))
        finally:
            current_selection.reset(token)

    def test_sql_failure_uses_complete_snapshot_and_exposes_fallback(self):
        self.query.side_effect = RuntimeError("provider unavailable")
        result = self.engine.execute(dict(metric="Amount", aggregation="SUM"))
        self.assertTrue(result.success, result.error)
        self.assertEqual(result.summary["value"], 0.3)
        self.assertTrue(result.warnings)
        self.assertEqual(result.records_matched, 2)

    def test_contains_treats_percent_and_underscore_as_literals(self):
        self.query.side_effect = [[{"ID": 1}], [{"CNT": 1}], [{"CNT": 2}]]
        result = self.engine.execute(
            dict(
                metric="ID",
                aggregation="COUNT",
                filters=[dict(column="ID", operator="CONTAINS", value="A%_!")],
            )
        )
        self.assertTrue(result.success, result.error)
        self.assertIn("ESCAPE '!'", self.query.call_args_list[0].args[0])
        self.assertEqual(self.query.call_args_list[0].args[1], ("%a!%!_!!%",))

    def test_identifiers_are_quoted_without_changing_labels(self):
        alias = 'total"value'
        self.query.side_effect = [[{alias: Decimal("0.3")}], [{"CNT": 2}]]
        result = self.engine.execute(
            dict(measures=[dict(field="Amount", aggregation="SUM", alias=alias)])
        )
        self.assertTrue(result.success, result.error)
        self.assertIn('AS "total""value"', self.query.call_args_list[0].args[0])

    def test_unknown_table_never_falls_back_to_largest_table(self):
        from api.platform.datasets_metadata_repository import DatasetsMetadataRepository

        repository = DatasetsMetadataRepository()
        with patch.object(
            repository, "_list_hana_tables", return_value={"UNRELATED": 9999}
        ):
            with self.assertRaises(ValueError):
                repository._resolve_physical_table("MISSING")


class AccessPolicies(unittest.TestCase):
    def setUp(self):
        token = current_identity.set(
            dict(user_id="member", workspace_id="default", roles=["Member"])
        )
        self.addCleanup(current_identity.reset, token)

    def test_existing_workspace_chat_policy_and_optional_strict_grants(self):
        entry = selected().entry
        with patch.dict(os.environ, {"PLATFORM_CHAT_WORKSPACE_ACCESS": "true"}):
            require_dataset_access(entry, for_chat=True)
        with patch.dict(os.environ, {"PLATFORM_CHAT_WORKSPACE_ACCESS": "false"}):
            with self.assertRaises(HTTPException) as error:
                require_dataset_access(entry, for_chat=True)
            self.assertEqual(error.exception.status_code, 403)
            entry["readers"] = ["member"]
            require_dataset_access(entry, for_chat=True)

    def test_workspace_access_never_grants_cross_workspace_chat(self):
        entry = {**selected().entry, "workspaceId": "other"}
        with self.assertRaises(HTTPException):
            require_dataset_access(entry, for_chat=True)

    def test_nonchat_requests_cannot_borrow_workspace_chat_permissions(self):
        identity = {**current_identity.get(), "request_channel": "dataset"}
        token = current_identity.set(identity)
        try:
            with patch.dict(os.environ, {"PLATFORM_CHAT_WORKSPACE_ACCESS": "true"}):
                with self.assertRaises(HTTPException):
                    require_dataset_access(selected().entry, for_chat=True)
        finally:
            current_identity.reset(token)

    def test_body_selected_graph_dataset_is_authorized(self):
        from api.routes.graph import (
            generate_python_graph_agent,
            PythonGraphAgentRequest,
        )
        from api.services.dataset_service import dataset_service

        token = current_selection.set(selected())
        self.addCleanup(current_selection.reset, token)
        entry = {**selected().entry, "id": "restricted"}
        with (
            patch.object(
                dataset_service,
                "_catalog",
                return_value={"datasets": {"restricted": entry}},
            ),
            patch(
                "api.services.python_graph_agent.python_graph_agent.generate_custom_graph"
            ) as generate,
        ):
            with self.assertRaises(HTTPException):
                generate_python_graph_agent(
                    PythonGraphAgentRequest(
                        prompt="Chart amount", dataset_id="restricted"
                    )
                )
            generate.assert_not_called()
            self.assertEqual(current_selection.get().context.user_id, "owner")

    def test_standard_graph_route_checks_body_dataset_too(self):
        from api.routes.graph import generate_graph, GraphRequest
        from api.services.dataset_service import dataset_service

        token = current_selection.set(selected())
        self.addCleanup(current_selection.reset, token)
        entry = {**selected().entry, "id": "restricted"}
        with (
            patch.object(
                dataset_service,
                "_catalog",
                return_value={"datasets": {"restricted": entry}},
            ),
            patch("api.routes.graph.analytics_engine.execute") as execute,
        ):
            with self.assertRaises(HTTPException):
                generate_graph(
                    GraphRequest(prompt="Chart amount", dataset_id="restricted")
                )
            execute.assert_not_called()

    def test_all_tables_selection_preserves_authenticated_context(self):
        from api.platform.data_resolution import dataset_scope

        selection = selected()
        token = current_selection.set(selection)
        self.addCleanup(current_selection.reset, token)
        with dataset_scope("all"):
            self.assertIs(current_selection.get(), selection)
        self.assertIs(current_selection.get(), selection)

    def test_explicit_vector_scope_never_falls_back_to_all_datasets(self):
        from api.database.vector_client import HANAVectorClient

        with patch(
            "api.database.vector_client.hana_client.execute_query", return_value=[]
        ) as query:
            result = HANAVectorClient().search_dataset_version("sales", 3, [0.1], 5)
            self.assertEqual(result, [])
            self.assertEqual(query.call_count, 1)
            self.assertIn("v3", query.call_args.args[1][1])
            self.assertIn("WHERE", query.call_args.args[0])


class SourcePreservation(unittest.TestCase):
    def test_reviewed_identifiers_decimals_dates_and_nulls_survive_cleaning(self):
        from api.platform.ingestion import IngestionService
        from api.platform.agent_preprocessing import PreprocessingAgent
        from api.services.dataset_service import DatasetService

        frame, _ = IngestionService().prepare(
            b"Employee ID,Amount,Stamp\n001,1234.567890123456789,2026-01-02T12:34:56+05:30\n002,,\n",
            "source.csv",
        )
        clean, _ = PreprocessingAgent().clean(frame)
        self.assertEqual(clean["Employee_ID"].iloc[0], "001")
        self.assertEqual(clean["Amount"].iloc[0], Decimal("1234.567890123456789"))
        self.assertEqual(clean["Stamp"].iloc[0], "2026-01-02T12:34:56+05:30")
        self.assertTrue(pd.isna(clean["Amount"].iloc[1]))
        rows = DatasetService._rows(clean)
        restored = DatasetService._frame(rows, DatasetService._columns(clean))
        self.assertEqual(restored["Amount"].iloc[0], clean["Amount"].iloc[0])
        self.assertEqual(DatasetService._columns(clean)[0]["name"], "Employee_ID")

    def test_explicit_duplicate_policy_is_honored(self):
        from api.platform.agent_preprocessing import PreprocessingAgent

        frame = pd.DataFrame({"Amount": [1, 1]})
        self.assertEqual(
            len(PreprocessingAgent().clean(frame)[0]), 1
        )  # Existing automatic cleaning default.
        self.assertEqual(
            len(
                PreprocessingAgent().clean(
                    frame, ParseOptions(duplicate_policy="keep")
                )[0]
            ),
            2,
        )

    def test_ambiguous_locale_strings_and_leading_zeros_are_preserved(self):
        from api.platform.agent_preprocessing import PreprocessingAgent

        frame = pd.DataFrame({"ID": ["001", "002"], "Amount": ["12,34", "56,78"]})
        clean, _ = PreprocessingAgent().clean(frame)
        self.assertEqual(clean["ID"].tolist(), ["001", "002"])
        self.assertEqual(clean["Amount"].tolist(), ["12,34", "56,78"])

    def test_empty_snapshot_is_not_replaced_by_live_data(self):
        from api.services.excel_dataset_service import ExcelDatasetService

        selection = selected()
        selection.snapshot["rows"] = []
        token = current_selection.set(selection)
        try:
            with patch("api.database.hana_client.hana_client.execute_query") as query:
                self.assertTrue(ExcelDatasetService().get_df().empty)
                query.assert_not_called()
        finally:
            current_selection.reset(token)

    def test_automatic_currency_cleaning_preserves_decimal_precision(self):
        from api.platform.agent_preprocessing import PreprocessingAgent

        frame = pd.DataFrame({"Amount": ["$1,234.567890123456789", "$2.10"]})
        clean, _ = PreprocessingAgent().clean(frame)
        self.assertEqual(clean["Amount"].iloc[0], Decimal("1234.567890123456789"))

    def test_source_count_uses_selected_snapshot_instead_of_other_cached_table(self):
        from api.services.excel_dataset_service import ExcelDatasetService

        service = ExcelDatasetService()
        service._records_count = 9999
        token = current_selection.set(selected())
        try:
            self.assertEqual(service.get_records_in_source(), 2)
        finally:
            current_selection.reset(token)

    def test_hana_dataframe_calculations_load_more_than_2000_rows(self):
        from api.services.excel_dataset_service import ExcelDatasetService

        service = ExcelDatasetService()
        rows = [{"Amount": i} for i in range(2001)]
        with patch(
            "api.database.hana_client.hana_client.execute_query",
            side_effect=[[{"CNT": 2001}], rows],
        ) as query:
            frame = service._load_dataset("SALES", "sales")
        self.assertEqual(len(frame), 2001)
        self.assertNotIn("LIMIT 2000", query.call_args.args[0])


class ChatFailureBehavior(unittest.TestCase):
    def test_numerical_errors_and_empty_results_do_not_use_vector_generation(self):
        from api.rag.pipeline import RAGPipeline

        selection = selected()
        token = current_selection.set(selection)
        self.addCleanup(current_selection.reset, token)
        for empty in (True, False):
            result = AnalyticsResult()
            result.success = empty
            result.status = "empty" if empty else "invalid_query"
            result.error = None if empty else "Unknown metric"
            with (
                patch(
                    "api.rag.pipeline.intent_engine.classify",
                    return_value=dict(
                        intent="analytical", requires_structured_query=True
                    ),
                ),
                patch("api.rag.pipeline.analytics_engine.execute", return_value=result),
                patch("api.rag.pipeline.retriever.retrieve") as retrieve,
                patch("api.rag.pipeline.generator.generate") as generate,
                patch(
                    "api.platform.ai_settings.ai_settings",
                    return_value={"llm_model": "test"},
                ),
            ):
                events = []
                response = RAGPipeline()._run_scoped(
                    "Total amount", 5, callback=events.append, stream=True
                )
                self.assertEqual(
                    response["status"], "no_data" if empty else "invalid_query"
                )
                retrieve.assert_not_called()
                generate.assert_not_called()
                self.assertTrue(any(e["type"] == "token" for e in events))


class GraphIsolation(unittest.TestCase):
    def test_dashboard_template_keeps_prompt_text_out_of_executable_code(self):
        # Matplotlib discovers system fonts on its first import (fc-list on Linux).
        # Complete library initialization before spying on chart execution.
        from matplotlib import font_manager

        font_manager.findfont("DejaVu Sans")
        from api.services.genai_dashboard_service import GenAIDashboardService

        prompt = "Volume'); __import__('os').system('unexpected') #"
        frame = pd.DataFrame({"Region": ["East", "West"], "Amount": [10, 20]})
        with patch("subprocess.run") as host_run:
            result = GenAIDashboardService()._generate_python_visualization(
                {"chart_type": "bar", "prompt": prompt}, prompt, frame
            )
        self.assertIsNotNone(result)
        self.assertTrue(result["image_base64"].startswith("data:image/png;base64,"))
        self.assertEqual(result["prompt"], prompt)
        host_run.assert_not_called()

    def test_python_chart_renders_without_docker_or_generated_code(self):
        from api.services.python_graph_agent import PythonGraphAgent

        frame = pd.DataFrame({"Region": ["East", "West"], "Amount": [10, 20]})
        agent = PythonGraphAgent()
        with (
            patch.dict(os.environ, {"PLATFORM_CHART_IMAGE": ""}),
            patch.object(agent, "_generate_python_code") as code,
            patch("subprocess.Popen") as process,
        ):
            result = agent.generate_custom_graph(
                "Chart amount by region",
                dict(metric="Amount", dimension="Region", chart_type="bar"),
                prepared_frame=frame,
            )
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["image_base64"].startswith("data:image/png;base64,"))
        code.assert_not_called()
        process.assert_not_called()

    def test_template_chart_preserves_empty_filters(self):
        from api.services.python_graph_agent import PythonGraphAgent

        frame = pd.DataFrame({"Region": ["East"], "Amount": [10]})
        with self.assertRaises(HTTPException) as error:
            PythonGraphAgent().generate_custom_graph(
                "Amount by Region",
                dict(
                    metric="Amount",
                    dimension="Region",
                    chart_type="bar",
                    filters=[dict(column="Region", operator="=", value="missing")],
                ),
                prepared_frame=frame,
            )
        self.assertEqual(error.exception.status_code, 422)

    def test_seaborn_categorical_heatmap_and_numeric_distribution(self):
        from api.platform.chart_templates import render_frame

        frame = pd.DataFrame(
            {
                "PROJECT_MANAGER": ["A", "A", "B"],
                "PROJECT_ID": ["P1", "P2", "P2"],
                "Amount": [1, 2, 3],
            }
        )
        for kind, plan in [
            (
                "heatmap",
                dict(
                    dimensions=["PROJECT_MANAGER", "PROJECT_ID"],
                    metric="*",
                    aggregation="COUNT",
                ),
            ),
            ("box", dict(dimension="PROJECT_MANAGER", metric="Amount")),
            ("violin", dict(dimension="PROJECT_MANAGER", metric="Amount")),
        ]:
            image = render_frame(frame, kind, plan, "User title'); __import__('os') #")
            import base64

            self.assertTrue(
                base64.b64decode(image.split(",", 1)[1]).startswith(
                    b"\x89PNG\r\n\x1a\n"
                )
            )

    def test_templates_reject_unknown_fields_and_large_matrices(self):
        from api.platform.chart_templates import render_frame

        with self.assertRaises(HTTPException):
            render_frame(
                pd.DataFrame({"x": [1]}), "bar", dict(dimension="missing", metric="x")
            )
        frame = pd.DataFrame({"x": range(51), "y": ["A"] * 51})
        with self.assertRaises(HTTPException):
            render_frame(
                frame,
                "heatmap",
                dict(dimensions=["x", "y"], metric="*", aggregation="COUNT"),
            )


class UploadLifecycle(unittest.TestCase):
    def setUp(self):
        from api.services.dataset_service import DatasetService
        from api.platform.semantic import SemanticRegistry
        from api.platform.store import MetadataStore

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = DatasetService(
            Path(self.temp.name) / "datasets", False, repository=False
        )
        self.addCleanup(self.service.wait_for_idle)
        self.registry = SemanticRegistry(
            MetadataStore(Path(self.temp.name) / "metadata.db", "sqlite")
        )
        token = current_identity.set(
            dict(user_id="owner", workspace_id="default", roles=["Admin"])
        )
        self.addCleanup(current_identity.reset, token)
        patches = [
            patch("api.services.upload_service.dataset_service", self.service),
            patch("api.services.dataset_service.dataset_service", self.service),
            patch("api.routes.datasets.dataset_service", self.service),
            patch("api.services.upload_service.semantic_registry", self.registry),
            patch("api.platform.semantic.semantic_registry", self.registry),
            patch.object(self.service, "_index", return_value=([], "Ready")),
            patch.object(self.service, "_sync_hana", return_value="Ready"),
            patch.object(self.service, "_prune_old_versions"),
            patch(
                "api.services.upload_service.domain_classifier_agent.analyze",
                return_value=semantic(),
            ),
            patch(
                "api.services.upload_service.chart_recommender_agent.recommend",
                return_value=[],
            ),
        ]
        for mocked in patches:
            mocked.start()
            self.addCleanup(mocked.stop)

    def upload(self, action="create"):
        from api.services.upload_service import UploadService

        self.events = []
        return UploadService().process_file(
            b"ID,Amount,Date\n001,0.10,2026-01-02\n",
            "Sales.csv",
            False,
            target_table_name="SALES",
            target_table_action=action,
            progress_callback=self.events.append,
        )

    def test_storage_failure_is_partial_and_retry_reuses_saved_version(self):
        from api.routes.datasets import retry_ingestion
        from api.platform.agent_chart_recommender import ChartRecommenderAgent

        with patch(
            "api.services.upload_service.hana_table_service.persist_dataframe",
            return_value={"success": False},
        ):
            result = self.upload()
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["ready_for_publication"])
        self.assertEqual(result["recommendations"], [])
        self.assertNotIn(
            (4, "running"), [(e["stage"], e["status"]) for e in self.events]
        )
        self.assertIn((3, "failed"), [(e["stage"], e["status"]) for e in self.events])
        entry = self.service._catalog()["datasets"][result["dataset"]["id"]]
        before = copy.deepcopy(self.service._snapshot(entry, 1))
        with (
            patch(
                "api.database.hana_table_service.hana_table_service.persist_dataframe",
                return_value={"success": True},
            ) as persist,
            patch(
                "api.platform.agent_chart_recommender.chart_recommender_agent.recommend",
                wraps=ChartRecommenderAgent().recommend,
            ) as recommend,
        ):
            retry = retry_ingestion(entry["id"], 1)
            self.assertEqual(persist.call_args.kwargs["action"], "create")
            recommend.assert_called_once()
        self.assertEqual(retry["status"], "success")
        self.assertGreater(len(retry["recommendations"]), 0)
        updated = self.service._catalog()["datasets"][entry["id"]]
        self.assertEqual(updated["ingestionStatus"], "ready")
        self.assertEqual(len(updated["versions"]), 1)
        self.assertEqual(self.service._snapshot(updated, 1), before)

    def test_append_retry_is_not_replayed_without_reconciliation(self):
        from api.routes.datasets import retry_ingestion

        with patch(
            "api.services.upload_service.hana_table_service.persist_dataframe",
            return_value={"success": False},
        ):
            result = self.upload("append")
        with self.assertRaises(HTTPException) as error:
            retry_ingestion(result["dataset"]["id"], 1)
        self.assertEqual(error.exception.status_code, 409)

    def test_default_auto_approval_and_explicit_review_option(self):
        with (
            patch.dict(os.environ, {"PLATFORM_AUTO_APPROVE_SEMANTICS": "true"}),
            patch(
                "api.services.upload_service.hana_table_service.persist_dataframe",
                return_value={"success": True},
            ),
        ):
            result = self.upload()
        self.assertEqual(result["semantic_model"]["status"], "approved")
        with (
            patch.dict(os.environ, {"PLATFORM_AUTO_APPROVE_SEMANTICS": "false"}),
            patch(
                "api.services.upload_service.hana_table_service.persist_dataframe",
                return_value={"success": True},
            ),
        ):
            result = self.upload()
        self.assertEqual(result["semantic_model"]["status"], "proposed")
        entry = self.service._catalog()["datasets"][result["dataset"]["id"]]
        with patch.dict(os.environ, {"PLATFORM_AUTO_APPROVE_SEMANTICS": "false"}):
            with self.assertRaises(HTTPException):
                self.registry.get(
                    entry,
                    result["version"],
                    result["semantic_model"]["revision"],
                    approved=True,
                )

    def test_partial_ingestion_cannot_be_published(self):
        from api.routes.dashboard import (
            publish_recommended_charts,
            PublishRecommendedRequest,
        )

        selection = selected()
        selection.entry["ingestionStatus"] = "partial"
        token = current_selection.set(selection)
        try:
            with self.assertRaises(HTTPException) as error:
                publish_recommended_charts(PublishRecommendedRequest(items=[]))
            self.assertEqual(error.exception.status_code, 409)
        finally:
            current_selection.reset(token)

    def test_reupload_after_successful_auto_table_creation_keeps_dataset_identity(self):
        from api.services.upload_service import UploadService

        with patch(
            "api.services.upload_service.hana_table_service.persist_dataframe",
            return_value={"success": True},
        ):
            service = UploadService()
            first = service.process_file(
                b"ID,Amount,Date\n001,0.10,2026-01-02\n", "Auto.csv", False
            )
            second = service.process_file(
                b"ID,Amount,Date\n002,0.20,2026-01-02\n", "Auto.csv", False
            )
        self.assertEqual(first["status"], "success")
        self.assertEqual(second["status"], "success")
        self.assertEqual(first["dataset"]["id"], second["dataset"]["id"])
        self.assertEqual(second["version"], 2)

    def test_automatic_table_names_do_not_collide_between_datasets(self):
        from api.services.upload_service import UploadService

        with patch(
            "api.services.upload_service.hana_table_service.persist_dataframe",
            return_value={"success": True},
        ):
            service = UploadService()
            first = service.process_file(
                b"ID,Amount,Date\n001,0.10,2026-01-02\n",
                "SamePrefixForALongNameA.csv",
                False,
            )
            second = service.process_file(
                b"ID,Amount,Date\n002,0.20,2026-01-02\n",
                "SamePrefixForALongNameB.csv",
                False,
            )
        self.assertNotEqual(
            first["cloud_table"]["table_name"], second["cloud_table"]["table_name"]
        )


class WorkerMonitoring(unittest.TestCase):
    def test_worker_health_expires_when_heartbeats_stop(self):
        from api.platform.jobs import JobService
        from api.platform.store import MetadataStore

        with tempfile.TemporaryDirectory() as folder:
            service = JobService(
                store=MetadataStore(Path(folder) / "jobs.db", "sqlite")
            )
            self.assertEqual(service.worker_health("default")["status"], "unavailable")
            service.heartbeat("one", "default")
            self.assertEqual(service.worker_health("default")["active_workers"], 1)
            with patch("api.platform.jobs.time.time", return_value=10**12):
                self.assertEqual(
                    service.worker_health("default")["status"], "unavailable"
                )


class NativeDatabaseValues(unittest.TestCase):
    def test_calculation_reads_keep_decimal_and_timestamp_precision(self):
        from datetime import datetime
        from api.database.hana_client import HANAClient

        amount = Decimal("1234.567890123456789")
        stamp = datetime(2026, 1, 2, 12, 34, 56)
        manager = Mock()
        cursor = manager.get_connection.return_value.cursor.return_value
        cursor.description = [("Amount",), ("Stamp",)]
        cursor.fetchall.return_value = [(amount, stamp)]
        with patch("api.database.hana_client.db_manager", manager):
            native = HANAClient().execute_query(
                "SELECT Amount, Stamp FROM SALES", native_types=True
            )
            public = HANAClient().execute_query("SELECT Amount, Stamp FROM SALES")
        self.assertEqual(native, [{"Amount": amount, "Stamp": stamp}])
        self.assertIsInstance(public[0]["Amount"], float)
        self.assertIsInstance(public[0]["Stamp"], str)


if __name__ == "__main__":
    unittest.main()
