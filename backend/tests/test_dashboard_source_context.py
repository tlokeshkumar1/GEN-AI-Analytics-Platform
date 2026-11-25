"""Dashboard widgets retain their own dataset version when saved to My Files."""

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _isolated_packages as _isolated_packages
from api.models.execution_context import (
    DatasetSelection,
    ExecutionContext,
    current_selection,
)
from api.routes import dashboard


class DashboardSourceContextTests(unittest.TestCase):
    def test_publication_status_retains_dataset_context_for_repeated_widget_ids(self):
        from api.routes import semantic

        with (
            patch.object(semantic, "dataset_service") as datasets,
            patch.object(semantic, "semantic_registry") as registry,
            patch.object(semantic, "require_dataset_access"),
            patch.object(semantic, "_resolve_semantic_rev", return_value=3),
        ):
            datasets._catalog.return_value = {"datasets": self.entries}
            registry.store.get.return_value = {
                "value": {"items": [{"id": "metric", "revision": 1}]}
            }
            response = semantic.get_dashboard_publication(all=True)
        self.assertEqual(
            response["items"],
            [
                {
                    "id": "metric",
                    "revision": 1,
                    "dataset_id": "alpha",
                    "version": 2,
                    "semantic_revision": 3,
                },
                {
                    "id": "metric",
                    "revision": 1,
                    "dataset_id": "beta",
                    "version": 7,
                    "semantic_revision": 3,
                },
            ],
        )

    def setUp(self):
        dashboard.clear_dashboard_cache()
        self.addCleanup(dashboard.clear_dashboard_cache)
        self.entries = {
            "alpha": {"id": "alpha", "currentVersion": 2, "workspaceId": "default"},
            "beta": {"id": "beta", "currentVersion": 7, "workspaceId": "default"},
        }
        context = ExecutionContext(
            workspace_id="default",
            dataset_id="alpha",
            version=2,
            semantic_revision=3,
            user_id="alice",
        )
        token = current_selection.set(
            DatasetSelection(context, self.entries["alpha"], {})
        )
        self.addCleanup(current_selection.reset, token)

    def test_published_widgets_keep_each_datasets_version(self):
        registry = Mock()
        registry.list.return_value = [{"revision": 3, "status": "approved"}]
        registry.namespace.side_effect = lambda entry, version, suffix: (
            f"{entry['id']}:{version}:{suffix}"
        )
        registry.store.get.return_value = {
            "revision": 1,
            "value": {"items": [{"id": "metric", "revision": 1}]},
        }
        item = Mock(id="metric", revision=1)
        item.model_dump.side_effect = lambda **kwargs: {
            "id": "metric",
            "revision": 1,
            "semantic_revision": 3,
        }
        registry.items.return_value = [item]
        with (
            patch.object(dashboard, "semantic_registry", registry),
            patch.object(dashboard, "dataset_service") as datasets,
            patch.object(dashboard, "analytics_engine") as engine,
        ):
            datasets._catalog.return_value = {"datasets": self.entries}
            datasets._snapshot.return_value = {}
            engine.execute.return_value.to_dict.return_value = {"success": True}
            response = dashboard.get_dashboard(refresh=True)
        definitions = [widget["definition"] for widget in response["widgets"]]
        self.assertEqual(
            {d["dataset_id"]: d["version"] for d in definitions},
            {"alpha": 2, "beta": 7},
        )
        self.assertTrue(all(d["semantic_revision"] == 3 for d in definitions))

    def test_recommended_widgets_include_selected_dataset_version(self):
        registry = Mock()
        registry.list.return_value = [{"revision": 3, "status": "approved"}]
        registry.store.get.return_value = None
        recommendation = {
            "id": "auto-metric",
            "title": "Metric",
            "kind": "kpi",
            "query_plan": {},
            "explanation": "",
            "selected_by_default": True,
        }
        with (
            patch.object(dashboard, "semantic_registry", registry),
            patch.object(dashboard, "dataset_service") as datasets,
            patch.object(dashboard, "analytics_engine") as engine,
            patch.object(
                dashboard.chart_recommender_agent,
                "recommend",
                return_value=[recommendation],
            ),
        ):
            datasets._catalog.return_value = {
                "datasets": {"alpha": self.entries["alpha"]}
            }
            datasets._snapshot.return_value = {"rows": [], "columns": []}
            engine.execute.return_value.to_dict.return_value = {"success": True}
            response = dashboard.get_dashboard(refresh=True)
        definition = response["widgets"][0]["definition"]
        self.assertEqual(
            (
                definition["dataset_id"],
                definition["version"],
                definition["semantic_revision"],
            ),
            ("alpha", 2, 3),
        )
