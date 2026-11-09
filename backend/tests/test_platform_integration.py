"""Real HTTP workflow: ingest, review semantics, approve definitions, publish, execute."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.platform.store import metadata_store
from api.services.dataset_service import DatasetService
from api.utils.context_middleware import DatasetContextMiddleware
from api.routes import datasets, semantic, dashboard, system, upload
from api.services import upload_service
from api.services import dataset_service as dataset_module


class ApprovedAnalyticsWorkflow(unittest.TestCase):
    def test_numerical_chat_uses_exact_executor_and_never_chunk_totals(self):
        path, model, headers = self.prepare()
        self.client.post(f"{path}/{model['revision']}/review", json={"decision": "approved"}).raise_for_status()
        from api.models.execution_context import current_selection, DatasetSelection, ExecutionContext
        from api.rag.pipeline import RAGPipeline
        entry = self.service._catalog()["datasets"][model["dataset_id"]]
        selection = DatasetSelection(ExecutionContext(workspace_id="default", user_id="owner", dataset_id=entry["id"], version=1, semantic_revision=model["revision"]), entry, self.service._snapshot(entry, 1))
        token = current_selection.set(selection)
        try:
            with patch("api.rag.pipeline.intent_engine.classify", return_value={"metric": "Salary", "aggregation": "SUM", "intent": "analytical"}), patch("api.rag.pipeline.retriever.retrieve") as retrieve, patch("api.rag.pipeline.generator.generate") as generate:
                events = []
                result = RAGPipeline()._run_scoped("Total salary", 5, callback=events.append)
                self.assertIn("0.30", result["reply"])
                self.assertEqual(result["context"]["dataset_id"], entry["id"])
                self.assertEqual(result["data"]["records_matched"], 2)
                retrieve.assert_not_called(); generate.assert_not_called()
                self.assertTrue(any(event["type"] == "token" for event in events))
        finally:
            current_selection.reset(token)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {"PLATFORM_METADATA_BACKEND": "sqlite", "PLATFORM_METADATA_PATH": str(Path(self.temp.name) / "metadata.db")})
        env.start(); self.addCleanup(env.stop)
        metadata_store.cache_clear(); self.addCleanup(metadata_store.cache_clear)
        self.service = DatasetService(Path(self.temp.name) / "datasets", default_async_index=False)
        self.addCleanup(self.service.wait_for_idle)
        for name, value in [("_index", ([], "Error")), ("_submit_indexing", None)]:
            p = patch.object(self.service, name, return_value=value); p.start(); self.addCleanup(p.stop)
        for module in (datasets, semantic, system, upload_service, dataset_module):
            p = patch.object(module, "dataset_service", self.service); p.start(); self.addCleanup(p.stop)
        p = patch("api.xsuaa.authenticated_profile", return_value={"user_id": "owner", "roles": ["Admin"], "role": "Admin"})
        self.profile = p.start(); self.addCleanup(p.stop)
        from api.config import settings
        p = patch.object(settings, "NVIDIA_API_KEY", ""); p.start(); self.addCleanup(p.stop)
        app = FastAPI()
        app.add_middleware(DatasetContextMiddleware)
        for router in (datasets.router, semantic.router, dashboard.router, system.router, upload.router):
            app.include_router(router)
        self.client = TestClient(app)

    def prepare(self):
        response = self.client.post("/api/upload", files={"file": ("HR.csv", b"EmployeeID,Salary,Department\n001,0.10,IT\n002,0.20,HR\n")})
        self.assertEqual(response.status_code, 200, response.text)
        dataset_id = response.json()["dataset"]["id"]
        path = f"/api/datasets/{dataset_id}/versions/1/semantics"
        proposal = self.client.post(path + "/propose").json()
        proposal["grain"] = "One employee record"
        next(f for f in proposal["fields"] if f["name"] == "Salary")["default_aggregation"] = "SUM"
        response = self.client.post(path, json=proposal)
        self.assertEqual(response.status_code, 200, response.text)
        model = response.json()
        headers = {"X-Dataset-Id": dataset_id, "X-Dataset-Version": "1", "X-Semantic-Revision": str(model["revision"])}
        return path, model, headers

    def test_approval_is_enforced_through_real_http_paths(self):
        path, model, headers = self.prepare()
        query = {"metric": "Salary", "aggregation": "SUM"}
        self.assertEqual(self.client.post("/api/insights/execute", json=query, headers=headers).status_code, 409)
        response = self.client.post(f"{path}/{model['revision']}/review", json={"decision": "approved"})
        self.assertEqual(response.status_code, 200, response.text)
        result = self.client.post("/api/insights/execute", json=query, headers=headers)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["summary"]["value"], "0.30")
        proposals = self.client.post("/api/insights/recommendations", headers=headers)
        self.assertEqual(proposals.status_code, 200, proposals.text)
        item = proposals.json()["items"][0]
        publication = {"title": "HR Overview", "items": [{"id": item["id"], "revision": item["revision"]}]}
        self.assertEqual(self.client.post("/api/insights/dashboard", json=publication, headers=headers).status_code, 409)
        response = self.client.post(f"/api/insights/definitions/{item['id']}/{item['revision']}/review", json={"decision": "approved"}, headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.post("/api/insights/dashboard", json=publication, headers=headers).status_code, 200)
        response = self.client.get("/api/dashboard", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["widgets"][0]["result"]["summary"]["value"], 2)

    def test_backend_denies_other_accounts_even_if_client_supplies_owner_identity(self):
        path, model, headers = self.prepare()
        dataset_id = model["dataset_id"]
        self.profile.return_value = {"user_id": "other-user", "roles": ["Member"], "role": "Member"}
        response = self.client.put(f"/api/datasets/{dataset_id}/rows", json={"rows": [{"id": "invented", "Salary": 100}], "user_id": "owner"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get("/api/system/connections").status_code, 403)
        self.assertEqual(self.client.get("/api/datasets").json(), [])


if __name__ == "__main__":
    unittest.main()
