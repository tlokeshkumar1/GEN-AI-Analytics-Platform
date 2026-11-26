"""Offline checks for shared preparation, cache isolation and progressive execution."""

from contextlib import ExitStack
from threading import Barrier, Event
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

import pandas as pd
from fastapi import HTTPException
from api.models.execution_context import current_identity
from api.platform.content_dashboard import refresh_events
from api.platform.content_publication import CalculationBatch, calculate, clear_calculation_cache
from api.platform.semantic import semantic_registry
from api.services.analytics_engine import analytics_engine
from api.services.dataset_service import DatasetService
from test_content_workspace import DocumentFixture


class CalculationPerformanceTests(TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        clear_calculation_cache()
        self.addCleanup(clear_calculation_cache)
        token = current_identity.set({"tenant_id": "t", "workspace_id": "w", "user_id": "alice"})
        self.addCleanup(current_identity.reset, token)
        self.workspace = SimpleNamespace(scope={"tenant_id": "t", "workspace_id": "w", "user_id": "alice"})
        self.store = DocumentFixture()
        self.service = MagicMock()
        self.service.repository.store = self.store
        self.service.repository.objects.backend = "hana"
        self.entry = {"id": "ds", "workspaceId": "w", "ownerId": "alice", "currentVersion": 1,
                      "versions": [{"version": 1, "snapshotKey": "immutable-v1"}]}
        self.service._catalog.return_value = {"datasets": {"ds": self.entry}}
        self.service._entry.side_effect = DatasetService._entry
        self.service._snapshot.return_value = {"rows": [{"units": 2}, {"units": 3}], "columns": [{"name": "units", "type": "number"}]}
        self.ns = semantic_registry.namespace(self.entry, 1)
        self.model = {"dataset_id": "ds", "data_version": 1, "revision": 1, "status": "approved", "grain": "row",
                      "fields": [{"name": "units", "semantic_name": "Units", "type": "integer", "role": "measure", "aggregations": ["SUM"]}]}
        self.store.put(self.ns, "1", self.model)
        self.items_ns = semantic_registry.namespace(self.entry, 1, "analytics:1")
        for name in ("one", "two"):
            self.store.put(self.items_ns, name + ":1", {
                "id": name, "revision": 1, "title": "Units", "kind": "kpi", "semantic_revision": 1,
                "status": "approved", "reviewer": "alice", "query_plan": {"metric": "units", "aggregation": "SUM"},
                "dependencies": ["units"], "explanation": "Reviewed",
            })
        self.ref = {"id": "one", "revision": 1, "dataset_id": "ds", "version": 1, "semantic_revision": 1}
        self.stack.enter_context(patch("api.platform.content_publication.dataset_service", self.service))
        self.frame = self.stack.enter_context(patch("api.platform.content_publication.dataset_frame", return_value=pd.DataFrame({"units": [2, 3]})))
        self.execute = self.stack.enter_context(patch.object(analytics_engine, "execute", wraps=analytics_engine.execute))

    def test_one_catalog_snapshot_and_frame_per_dataset_in_refresh(self):
        batch = CalculationBatch()
        for name in ("one", "two"):
            result = calculate(self.workspace, dict(self.ref, id=name), batch=batch)
            self.assertEqual(result["result"]["summary"]["value"], 5)
        self.service._catalog.assert_called_once()
        self.service._entry.assert_called_once()
        self.service._snapshot.assert_called_once()
        self.frame.assert_called_once()
        self.assertEqual(self.execute.call_count, 2)

    def test_cached_results_are_isolated_by_filters_and_user_and_force_refresh(self):
        first = calculate(self.workspace, self.ref, cache_results=True)
        first["result"]["summary"]["value"] = 999
        second = calculate(self.workspace, self.ref, cache_results=True)
        self.assertEqual(second["result"]["summary"]["value"], 5)
        self.assertEqual(self.execute.call_count, 1)
        calculate(self.workspace, self.ref, cache_results=True, filters=[{"column": "units", "operator": ">", "value": 2}])
        self.assertEqual(self.execute.call_count, 2)
        other_scope = SimpleNamespace(scope=dict(self.workspace.scope, user_id="bob"))
        calculate(other_scope, self.ref, cache_results=True)
        self.assertEqual(self.execute.call_count, 3)
        calculate(self.workspace, self.ref, cache_results=True, force=True)
        self.assertEqual(self.execute.call_count, 4)

    def test_cache_hit_still_checks_ownership_approval_and_digest(self):
        result = calculate(self.workspace, self.ref, cache_results=True)
        self.entry["ownerId"] = "other"
        with self.assertRaises(HTTPException):
            calculate(self.workspace, self.ref, cache_results=True)
        self.entry["ownerId"] = "alice"
        with self.assertRaises(HTTPException):
            calculate(self.workspace, self.ref, cache_results=True, expected_digest="wrong")
        self.store.put(self.ns, "1", dict(self.model, status="rejected"), 1)
        with self.assertRaises(HTTPException):
            calculate(self.workspace, self.ref, cache_results=True, expected_digest=result["digest"])
        self.assertEqual(self.execute.call_count, 1)


class ProgressiveRefreshTests(TestCase):
    def setUp(self):
        token = current_identity.set({"user_id": "alice"})
        self.addCleanup(current_identity.reset, token)

    def widgets(self, count):
        return [{"id": str(i), "digest": "pinned", "source": {"id": str(i), "dataset_id": "ds", "version": 1, "semantic_revision": 1}} for i in range(count)]

    def test_four_widgets_run_concurrently_with_request_identity(self):
        barrier = Barrier(4)
        identities = []

        def compute(workspace, ref, **kwargs):
            identities.append(current_identity.get()["user_id"])
            if int(ref["id"]) < 4:
                barrier.wait(timeout=3)
            return {"result": {"success": True}}

        with patch("api.platform.content_dashboard.calculate", side_effect=compute):
            events = list(refresh_events(None, {"id": "d", "revision": 1}, {"widgets": self.widgets(5)}))
        self.assertEqual(len([e for e in events if e["type"] == "widget"]), 5)
        self.assertTrue(all("error" not in e["value"] for e in events if e["type"] == "widget"))
        self.assertEqual(identities, ["alice"] * 5)

    def test_fast_widget_is_yielded_while_slow_widget_is_still_running(self):
        release = Event()

        def compute(workspace, ref, **kwargs):
            if ref["id"] == "0":
                release.wait(timeout=3)
            return {"result": {"success": True}}

        with patch("api.platform.content_dashboard.calculate", side_effect=compute):
            events = refresh_events(None, {"id": "d", "revision": 1}, {"widgets": self.widgets(2)})
            self.assertEqual(next(events)["type"], "start")
            try:
                first = next(events)
                self.assertEqual(first["id"], "1")
                self.assertFalse(release.is_set())
            finally:
                release.set()
                remaining = list(events)
            self.assertEqual(remaining[-1]["type"], "complete")

    def test_stream_endpoint_authorizes_before_headers_and_returns_ndjson(self):
        import json
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.routes.content import router

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        resource_id, page_id = "a" * 32, "b" * 32
        with patch("api.platform.content_dashboard.prepare_refresh", side_effect=HTTPException(403, "Access revoked")):
            response = client.post(f"/api/content/files/{resource_id}/refresh?page_id={page_id}&stream=true")
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["detail"], "Access revoked")
        with (
            patch("api.platform.content_dashboard.prepare_refresh", return_value=(None, {"id": resource_id, "revision": 1}, {"widgets": self.widgets(2)})),
            patch("api.platform.content_dashboard.calculate", return_value={"result": {"success": True}}) as execute,
        ):
            response = client.post(f"/api/content/files/{resource_id}/refresh?page_id={page_id}&stream=true&force=true")
            self.assertEqual(response.status_code, 200)
            self.assertIn("application/x-ndjson", response.headers["content-type"])
            self.assertEqual(response.headers["cache-control"], "private, no-store")
            events = [json.loads(line) for line in response.text.splitlines()]
            self.assertEqual(events[0]["type"], "start")
            self.assertEqual(events[-1]["type"], "complete")
            self.assertEqual(len(events), 4)
            self.assertTrue(all(call.kwargs["force"] for call in execute.call_args_list))
