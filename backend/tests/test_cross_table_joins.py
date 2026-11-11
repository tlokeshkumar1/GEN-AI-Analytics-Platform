"""Comprehensive unit tests for dynamic zero-hardcoding cross-table joins.

Tests:
1. Dynamic key normalization and scoring heuristics.
2. Live value overlap verification and cardinality determination.
3. Rejection of unrelated non-joinable tables.
4. AnalyticsEngine execution of cross-table joined query plans.
5. RAG Chat / planning integration with join graph.
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.models.query_plan import QueryPlan, Join, Measure
from api.platform.join_service import CrossTableJoinService, join_service
from api.services.analytics_engine import analytics_engine


class CrossTableJoinTests(unittest.TestCase):
    def setUp(self):
        from api.platform.planning import clear_intent_cache
        clear_intent_cache()
        self.svc = CrossTableJoinService()
        self.svc.invalidate_cache()

    def test_score_key_pair_heuristics(self):
        """Verify dynamic scoring handles normalized matching without any hardcoding."""
        # Exact match after punctuation/case normalization
        self.assertGreaterEqual(self.svc._score_key_pair("Project ID", "PROJECT_ID"), 90)
        self.assertGreaterEqual(self.svc._score_key_pair("customer_id", "CustomerID"), 90)
        self.assertGreaterEqual(self.svc._score_key_pair("ORDER_NUM", "order num"), 90)

        # Suffix match
        self.assertGreaterEqual(self.svc._score_key_pair("id", "department_id"), 75)
        self.assertGreaterEqual(self.svc._score_key_pair("supplier_key", "key"), 75)

        # Identifier role / keyword bonus
        self.assertGreaterEqual(self.svc._score_key_pair("cust_code", "client_code"), 60)

        # Unrelated columns score 0
        self.assertEqual(self.svc._score_key_pair("Revenue", "Status"), 0)
        self.assertEqual(self.svc._score_key_pair("Delay_Days", "Project_Name"), 0)

    def test_pandas_overlap_and_cardinality(self):
        """Verify value overlap and cardinality calculation on synthetic tables."""
        # Table A: Parent table (unique keys)
        df_parent = pd.DataFrame({
            "Entity_ID": ["E-001", "E-002", "E-003", "E-004"],
            "Name": ["Alpha", "Beta", "Gamma", "Delta"],
            "Budget": [1000, 2000, 1500, 3000]
        })

        # Table B: Child table (multiple rows per entity)
        df_child = pd.DataFrame({
            "Entity_ID": ["E-001", "E-001", "E-002", "E-003", "E-003", "E-003"],
            "Sub_Item": ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5", "Task 6"],
            "Duration": [5, 10, 2, 8, 4, 7]
        })

        # Table C: Unrelated table (completely disjoint keys)
        df_unrelated = pd.DataFrame({
            "Location_Code": ["LOC-X", "LOC-Y", "LOC-Z"],
            "Capacity": [500, 800, 1200]
        })

        # 1. Child -> Parent join (Many-to-One): safe for all aggregations
        overlap, tl, ul, tr, ur = self.svc._verify_overlap_in_pandas(df_child, df_parent, "Entity_ID", "Entity_ID")
        self.assertEqual(overlap, 3)  # E-001, E-002, E-003 overlap
        cardinality, agg_safe, warning = self.svc._determine_cardinality(tl, ul, tr, ur)
        self.assertEqual(cardinality, "many_to_one")
        self.assertTrue(agg_safe)
        self.assertIsNone(warning)

        # 2. Parent -> Child join (One-to-Many): additive metrics on parent risk inflation
        overlap, tl, ul, tr, ur = self.svc._verify_overlap_in_pandas(df_parent, df_child, "Entity_ID", "Entity_ID")
        self.assertEqual(overlap, 3)
        cardinality, agg_safe, warning = self.svc._determine_cardinality(tl, ul, tr, ur)
        self.assertEqual(cardinality, "one_to_many")
        self.assertFalse(agg_safe)
        self.assertIn("Notice", warning)

        # 3. Parent -> Unrelated join: 0 overlap
        overlap, tl, ul, tr, ur = self.svc._verify_overlap_in_pandas(df_parent, df_unrelated, "Entity_ID", "Location_Code")
        self.assertEqual(overlap, 0)

    def test_load_joined_dataframe_merging(self):
        """Verify loading and merging joined DataFrames avoids namespace collisions."""
        df_left = pd.DataFrame({
            "UID": ["U1", "U2", "U3"],
            "Status": ["Active", "Active", "Pending"],
            "Score": [88, 92, 79]
        })
        df_right = pd.DataFrame({
            "UID": ["U1", "U2", "U3"],
            "Status": ["Verified", "Unverified", "Verified"],
            "Department": ["Sales", "Engineering", "Marketing"]
        })

        with patch.object(self.svc, "_get_dataset_entry_and_snapshot") as mock_snap:
            mock_snap.side_effect = [
                ({"id": "ds_left", "name": "LeftTable"}, {"rows": df_left.to_dict(orient="records"), "columns": [{"name": c, "type": "string"} for c in df_left.columns]}),
                ({"id": "ds_right", "name": "RightTable"}, {"rows": df_right.to_dict(orient="records"), "columns": [{"name": c, "type": "string"} for c in df_right.columns]})
            ]

            merged = self.svc.load_joined_dataframe("ds_left", "ds_right", "UID", "UID", how="left")
            self.assertEqual(len(merged), 3)
            self.assertIn("Score", merged.columns)
            self.assertIn("Department", merged.columns)
            # Overlapping Status column in right table should be renamed cleanly
            self.assertTrue(any(c.startswith("Status_") for c in merged.columns))

    def test_analytics_engine_execute_with_dynamic_join(self):
        """Verify AnalyticsEngine executes query plans containing dynamic joins."""
        df_milestones = pd.DataFrame({
            "Project_ID": ["P1", "P1", "P2", "P3"],
            "Milestone": ["M1", "M2", "M3", "M4"],
            "Delay_Days": [10, 20, 5, 15]
        })
        df_projects = pd.DataFrame({
            "Project_ID": ["P1", "P2", "P3"],
            "Project_Manager": ["Alice", "Bob", "Alice"]
        })

        plan = QueryPlan(
            left_dataset_id="ds_milestones",
            metric="Delay_Days",
            aggregation="AVG",
            dimension="Project_Manager",
            joins=[
                Join(
                    right_dataset_id="ds_projects",
                    left_key="Project_ID",
                    right_key="Project_ID",
                    how="left"
                )
            ]
        )

        with patch("api.platform.join_service.join_service.load_joined_dataframe") as mock_join_df, \
             patch.object(analytics_engine, "_execute_on_hana", return_value=None):

            merged = df_milestones.merge(df_projects, on="Project_ID", how="left")
            mock_join_df.return_value = merged

            res = analytics_engine.execute(plan.model_dump(), dataframe=df_milestones)
            self.assertTrue(res.success)
            self.assertEqual(len(res.data), 2)  # Alice and Bob

            # Alice has P1 (10, 20) and P3 (15) -> avg = 15.0
            alice_row = next(r for r in res.data if r.get("Project_Manager") == "Alice")
            self.assertAlmostEqual(alice_row["Delay_Days"], 15.0)

            # Bob has P2 (5) -> avg = 5.0
            bob_row = next(r for r in res.data if r.get("Project_Manager") == "Bob")
            self.assertAlmostEqual(bob_row["Delay_Days"], 5.0)

    def test_planning_cross_table_intent_resolution(self):
        """Verify classify_request identifies cross-table dimension and attaches Join."""
        from api.platform.planning import classify_request
        from api.models.execution_context import current_selection, ExecutionContext, DatasetSelection
        from api.platform.contracts import SemanticModel, SemanticField

        entry = {"id": "ds_milestones", "name": "Milestones", "currentVersion": 1}
        ctx = ExecutionContext(workspace_id="default", dataset_id="ds_milestones", version=1, semantic_revision=1, user_id="u1")
        sel = DatasetSelection(entry=entry, context=ctx, snapshot={"rows": [], "columns": []})

        model = SemanticModel(
            dataset_id="ds_milestones",
            data_version=1,
            revision=1,
            domain="projects",
            fields=[
                SemanticField(name="Delay_Days", semantic_name="Delay Days", type="decimal", role="measure", aggregations=["AVG", "SUM", "MIN", "MAX"], default_aggregation="AVG"),
                SemanticField(name="Milestone_ID", semantic_name="Milestone ID", type="string", role="identifier", aggregations=["COUNT"]),
                SemanticField(name="Project_ID", semantic_name="Project ID", type="string", role="identifier", aggregations=["COUNT"])
            ]
        )

        token = current_selection.set(sel)
        try:
            from api.services.dataset_service import dataset_service
            with patch("api.platform.semantic.semantic_registry.get", return_value=model), \
                 patch("api.config.settings.NVIDIA_API_KEY", ""), \
                 patch.object(dataset_service, "_catalog", return_value={
                     "datasets": {
                         "ds_milestones": {"id": "ds_milestones", "name": "Milestones"},
                         "ds_projects": {"id": "ds_projects", "name": "Projects"}
                     }
                 }), \
                 patch.object(join_service, "get_workspace_join_graph") as mock_graph, \
                 patch.object(join_service, "get_dataset_columns") as mock_cols:

                mock_graph.return_value = [{
                    "joinable": True,
                    "left_dataset_id": "ds_milestones",
                    "right_dataset_id": "ds_projects",
                    "left_key": "Project_ID",
                    "right_key": "Project_ID"
                }]

                mock_cols.return_value = [
                    {"name": "Project_ID", "type": "string", "role": "identifier"},
                    {"name": "Project_Manager", "type": "string", "role": "dimension"}
                ]

                plan_dict = classify_request("Average delay days by project manager")
                self.assertEqual(plan_dict["metric"], "Delay_Days")
                self.assertEqual(plan_dict["aggregation"], "AVG")
                self.assertIn("Project_Manager", plan_dict["dimensions"])
                self.assertEqual(len(plan_dict.get("joins", [])), 1)
                self.assertEqual(plan_dict["joins"][0]["right_dataset_id"], "ds_projects")
        finally:
            current_selection.reset(token)

    def test_planning_rejects_unjoinable_table_fields(self):
        """Verify classify_request rejects combining fields when tables cannot be joined."""
        from api.platform.planning import classify_request
        from api.models.execution_context import current_selection, ExecutionContext, DatasetSelection
        from api.platform.contracts import SemanticModel, SemanticField
        from fastapi import HTTPException

        entry = {"id": "ds_projects", "name": "Projects", "currentVersion": 1}
        ctx = ExecutionContext(workspace_id="default", dataset_id="ds_projects", version=1, semantic_revision=1, user_id="u1")
        sel = DatasetSelection(entry=entry, context=ctx, snapshot={"rows": [], "columns": []})

        model = SemanticModel(
            dataset_id="ds_projects",
            data_version=1,
            revision=1,
            domain="projects",
            fields=[
                SemanticField(name="Budget", semantic_name="Budget", type="decimal", role="measure", aggregations=["SUM", "AVG"], default_aggregation="SUM"),
                SemanticField(name="Project_ID", semantic_name="Project ID", type="string", role="identifier", aggregations=["COUNT"])
            ]
        )

        token = current_selection.set(sel)
        try:
            from api.services.dataset_service import dataset_service
            with patch("api.platform.semantic.semantic_registry.get", return_value=model), \
                 patch("api.config.settings.NVIDIA_API_KEY", ""), \
                 patch.object(join_service, "get_workspace_join_graph", return_value=[]), \
                 patch.object(dataset_service, "_catalog", return_value={
                     "datasets": {
                         "ds_projects": {"id": "ds_projects", "name": "Projects"},
                         "ds_inventory": {"id": "ds_inventory", "name": "Inventory"}
                     }
                 }), \
                 patch.object(join_service, "get_dataset_columns", return_value=[
                     {"name": "Warehouse_Location", "type": "string", "role": "dimension"}
                 ]):

                with self.assertRaises(HTTPException) as cm:
                    classify_request("Total budget by warehouse location")
                self.assertEqual(cm.exception.status_code, 422)
                self.assertIn("cannot be joined", str(cm.exception.detail))
        finally:
            current_selection.reset(token)

    def test_save_item_with_dynamic_join_without_relationship(self):
        """Verify saving an AnalyticsItem with dynamic join (relationship=None) records dependencies cleanly."""
        from api.platform.semantic import semantic_registry
        from api.platform.contracts import SemanticModel, SemanticField
        from api.models.query_plan import QueryPlan, Measure, Join

        entry = {"id": "ds_milestones", "name": "Milestones", "currentVersion": 1, "workspaceId": "default", "ownerId": "u1", "readers": ["*"], "writers": []}
        model = SemanticModel(
            dataset_id="ds_milestones",
            data_version=1,
            revision=1,
            domain="projects",
            fields=[
                SemanticField(name="PROJECT_ID", semantic_name="Project Id", type="string", role="identifier", aggregations=["COUNT"]),
            ]
        )
        proposed = {
            "id": "kpi-projects-delayed",
            "title": "Projects Delayed",
            "kind": "kpi",
            "explanation": "Count of projects grouped by delayed days across joined project and milestone tables.",
            "dependencies": [],
            "query_plan": QueryPlan(
                measures=[Measure(field="PROJECT_ID", aggregation="COUNT")],
                dimensions=["DELAYED_DAYS"],
                joins=[Join(relationship=None, right_dataset_id="ds_projects", left_key="PROJECT_ID", right_key="PROJECT_ID", how="left")],
            ).model_dump(mode="json"),
        }
        with patch.object(semantic_registry, "get", return_value=model), \
             patch.object(semantic_registry, "items", return_value=[]), \
             patch.object(semantic_registry.store, "put") as mock_put:
            saved = semantic_registry.save_item(entry, 1, 1, proposed)
            self.assertIn("join:ds_projects:PROJECT_ID:PROJECT_ID", saved.dependencies)
            mock_put.assert_called_once()


if __name__ == "__main__":
    unittest.main()
