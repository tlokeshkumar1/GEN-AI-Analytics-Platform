"""Regressions for exact generation, real calculations and transcript routing."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

from api.platform.widget_contract import requested_counts, widget_signature
from api.rag.catalog_chat import named_dataset_response
from api.services.genai_dashboard_service import GenAIDashboardService


class RequestedWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.service = GenAIDashboardService()
        self.frame = pd.DataFrame(
            {
                "Region": ["East", "East", "West"],
                "Revenue": [10, None, 30],
                "Cost": [2, 4, 6],
            }
        )

    def _project_schema(self):
        return [
            {
                "dataset_id": "projects",
                "table_name": "Projects",
                "columns": [
                    {"name": "Project_Start_Date", "type": "date", "role": "dimension"},
                    {
                        "name": "Overall_Percentage_Completion",
                        "type": "decimal",
                        "role": "measure",
                    },
                ],
            }
        ]

    def test_date_vs_completion_averages_percent_strings_in_date_order(self):
        frame = pd.DataFrame(
            {
                "Project_Start_Date": ["2026-02-01", "2026-01-01", "2026-02-01"],
                "Overall_Percentage_Completion": ["90%", "80%", "30%"],
            }
        )
        with patch(
            "api.services.genai_dashboard_service.ai_core_service.generate_structured_completion"
        ) as llm:
            plan = self.service._interpret_query_with_llm(
                "give me project start date vs Overall percentage completion",
                self._project_schema(),
            )
        llm.assert_not_called()
        self.assertEqual(plan["kpis"], [])
        result = self.service._execute_aggregations(frame, [], plan["charts"])
        self.assertEqual(
            [(p["label"], p["value"]) for p in result["charts"][0]["data"]],
            [("2026-01-01", 80), ("2026-02-01", 60)],
        )
        self.assertEqual(result["charts"][0]["aggregation"], "AVG")

    def test_missing_progress_markers_are_excluded_from_average(self):
        frame = pd.DataFrame(
            {
                "Start_Date": ["2026-01-01"] * 4,
                "Actual_Progress": ["40%", "Unassigned", "80%", None],
            }
        )
        result = self.service._execute_aggregations(
            frame,
            [{"metric": "Actual_Progress", "aggregation": "AVG"}],
            [
                {
                    "metric": "Actual_Progress",
                    "dimension": "Start_Date",
                    "aggregation": "AVG",
                }
            ],
        )
        self.assertEqual(result["kpis"][0]["value"], 60)
        self.assertEqual(result["charts"][0]["data"][0]["value"], 60)
        # Unexpected text is still an error; missing data is never zero completion.
        for values in [["Unassigned", None], ["40%", "delayed"]]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.service._execute_aggregations(
                    pd.DataFrame({"Progress": values}),
                    [{"metric": "Progress", "aggregation": "AVG"}],
                    [],
                )

    def test_requested_widget_is_returned_even_when_already_saved(self):
        from api.models.execution_context import current_selection

        plan = self.service._date_comparison_plan(
            "project start date vs Overall percentage completion",
            self._project_schema(),
        )
        frame = pd.DataFrame(
            {
                "Project_Start_Date": ["2026-01-01"],
                "Overall_Percentage_Completion": [50],
            }
        )
        selection = SimpleNamespace(
            entry={},
            context=SimpleNamespace(
                version=1, semantic_revision=1, model_dump=lambda: {}
            ),
        )
        token = current_selection.set(selection)
        try:
            with (
                patch.object(
                    self.service, "explore_schemas", return_value=self._project_schema()
                ),
                patch.object(
                    self.service, "_load_data_frame", return_value=(frame, 1, None)
                ),
                patch.object(self.service, "_synthesize_insights", return_value=[]),
                patch.object(
                    self.service,
                    "_generate_proactive_recommendations",
                    return_value=plan["charts"],
                ),
                patch(
                    "api.platform.semantic.semantic_registry.namespace",
                    return_value="test",
                ),
                patch(
                    "api.platform.semantic.semantic_registry.store.list",
                    return_value=[{"value": plan["charts"][0]}],
                ),
            ):
                result = self.service.generate_dashboard(
                    "project start date vs Overall percentage completion"
                )
        finally:
            current_selection.reset(token)
        self.assertEqual(len(result["charts"]), 1)
        self.assertEqual(result["charts"][0]["data"][0]["value"], 50)
        self.assertEqual(result["recommendations"], [])

    def test_missing_comparison_fields_do_not_fall_back_to_unrelated_widgets(self):
        with patch(
            "api.services.genai_dashboard_service.ai_core_service.generate_structured_completion",
            return_value=None,
        ):
            with self.assertRaisesRegex(
                ValueError, "does not contain the requested field"
            ):
                self.service._interpret_query_with_llm(
                    "project start date vs Overall percentage completion",
                    [
                        {
                            "dataset_id": "sales",
                            "table_name": "Sales",
                            "row_count": 1,
                            "columns": [
                                {
                                    "name": "Revenue",
                                    "type": "decimal",
                                    "role": "measure",
                                }
                            ],
                        }
                    ],
                )

    def test_date_chart_keeps_more_than_fifteen_dates(self):
        dates = pd.date_range("2026-01-01", periods=20).strftime("%Y-%m-%d").tolist()
        frame = pd.DataFrame(
            {
                "Project_Start_Date": dates[::-1],
                "Overall_Percentage_Completion": range(20),
            }
        )
        plan = self.service._date_comparison_plan(
            "project start date vs Overall percentage completion",
            self._project_schema(),
        )
        result = self.service._execute_aggregations(frame, [], plan["charts"])
        self.assertEqual([p["label"] for p in result["charts"][0]["data"]], dates)

    def test_empty_plan_cannot_report_success(self):
        with (
            patch.object(
                self.service, "explore_schemas", return_value=self._project_schema()
            ),
            patch.object(
                self.service,
                "_interpret_query_with_llm",
                return_value={
                    "kpis": [],
                    "charts": [],
                    "intent_summary": "Requested fields are missing.",
                },
            ),
        ):
            with self.assertRaisesRegex(ValueError, "Requested fields are missing"):
                self.service.generate_dashboard("compare project dates")

    def test_explicit_output_counts(self):
        cases = [
            ("one KPI", {"kpis": 1, "charts": 0}),
            ("two KPIs", {"kpis": 2, "charts": 0}),
            ("three KPIs", {"kpis": 3, "charts": 0}),
            ("a chart", {"charts": 1, "kpis": 0}),
            ("two charts", {"charts": 2, "kpis": 0}),
            ("two KPIs and three charts", {"kpis": 2, "charts": 3}),
            ("one Python chart", {"charts": 1, "kpis": 0}),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(requested_counts(text), expected)

    def test_count_metric_counts_nonnull_values_not_rows(self):
        result = self.service._execute_aggregations(
            self.frame,
            [],
            [
                {
                    "kind": "bar",
                    "metric": "Revenue",
                    "dimension": "Region",
                    "aggregation": "COUNT",
                }
            ],
        )
        self.assertEqual(
            {v["label"]: v["value"] for v in result["charts"][0]["data"]},
            {"East": 1, "West": 1},
        )

    def test_sum_of_dimension_itself_is_not_replaced_by_frequency(self):
        with self.assertRaisesRegex(ValueError, "numeric"):
            self.service._execute_aggregations(
                self.frame,
                [],
                [{"metric": "Region", "dimension": "Region", "aggregation": "SUM"}],
            )

    def test_invalid_fields_never_return_fabricated_values(self):
        for spec in [
            {"metric": "Missing", "aggregation": "SUM"},
            {"metric": "*", "aggregation": "SUM"},
            {"metric": "Revenue", "aggregation": "MEDIAN_UNKNOWN"},
        ]:
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                self.service._execute_aggregations(self.frame, [spec], [])
        with self.assertRaises(ValueError):
            self.service._execute_aggregations(
                self.frame, [], [{"metric": "Revenue", "dimension": "Missing"}]
            )

    def test_actual_complete_data_aggregation(self):
        result = self.service._execute_aggregations(
            self.frame, [{"metric": "Revenue", "aggregation": "SUM"}], []
        )
        self.assertEqual(result["kpis"][0]["value"], 40)
        self.assertEqual(result["records_matched"], 3)

    def test_duplicate_identity_ignores_titles_and_ids_and_normalizes_plans(self):
        a = {
            "id": "new",
            "title": "Revenue",
            "kind": "kpi",
            "metric": "Revenue",
            "aggregation": "SUM",
        }
        b = {
            "id": "old",
            "title": "Sales",
            "kind": "kpi",
            "query_plan": {"measures": [{"field": "Revenue", "aggregation": "SUM"}]},
        }
        self.assertEqual(widget_signature(a), widget_signature(b))
        self.assertNotEqual(
            widget_signature(a), widget_signature({**a, "aggregation": "AVG"})
        )

    def test_digit_bearing_dataset_name_is_overview_not_record_id(self):
        name = "COPY_OF_PORTFOLIO_5_FINAL_PROJECTS"
        entry = {"id": "projects", "name": name, "currentVersion": 1}
        snapshot = {
            "columns": [{"name": "Revenue", "type": "decimal"}],
            "rows": [{"Revenue": n} for n in range(20)],
        }
        with (
            patch("api.rag.catalog_chat.require_dataset_access"),
            patch(
                "api.services.dataset_service.dataset_service._snapshot",
                return_value=snapshot,
            ),
        ):
            response = named_dataset_response(
                "give me data about " + name, {"datasets": {"projects": entry}}
            )
        self.assertEqual(response["intent"], "dataset_overview")
        self.assertIn("**20 rows**", response["reply"])
        self.assertNotIn("Record Not Found", response["reply"])

    def test_named_dataset_lookup_does_not_intercept_calculation(self):
        self.assertIsNone(named_dataset_response("sum Revenue", {"datasets": {}}))
        self.assertIsNone(
            named_dataset_response(
                "sum Revenue in data Sales_5",
                {"datasets": {"sales": {"name": "Sales_5"}}},
            )
        )

    def test_filters_are_applied_and_preserved_for_preview_and_publication(self):
        result = self.service._execute_aggregations(
            self.frame,
            [{"metric": "Revenue", "aggregation": "SUM"}],
            [],
            [{"column": "Region", "operator": "==", "value": "West"}],
        )
        widget = result["kpis"][0]
        self.assertEqual(widget["value"], 30)
        self.assertEqual(widget["query_plan"]["filters"][0]["operator"], "=")
        self.assertEqual(result["records_matched"], 1)
        with self.assertRaises(ValueError):
            self.service._execute_aggregations(
                self.frame,
                [],
                [],
                [{"column": "Region", "operator": "BAD", "value": "West"}],
            )

    def test_general_question_uses_llm_and_history_without_workspace_retrieval(self):
        from api.rag.pipeline import rag_pipeline

        with (
            patch(
                "api.services.dataset_service.dataset_service.active",
                return_value=(None, None),
            ),
            patch(
                "api.services.dataset_service.dataset_service._catalog",
                return_value={"datasets": {}},
            ),
            patch(
                "api.platform.ai_settings.ai_settings",
                return_value={"llm_model": "test", "max_tokens": 600},
            ),
            patch(
                "api.rag.pipeline.intent_engine.classify",
                return_value={
                    "intent": "chat",
                    "requires_structured_query": False,
                    "requires_vector_search": False,
                },
            ),
            patch(
                "api.rag.pipeline.generator.generate",
                return_value="A neural network learns patterns from examples.",
            ) as generate,
            patch("api.rag.pipeline.retriever.retrieve") as retrieve,
        ):
            result = rag_pipeline._run_scoped(
                "What is a neural network?",
                5,
                history=[{"role": "user", "content": "Explain simply"}],
            )
        self.assertEqual(result["intent"], "general_chat")
        self.assertEqual(result["sources"], [])
        retrieve.assert_not_called()
        self.assertIn("Explain simply", generate.call_args.args[0])
