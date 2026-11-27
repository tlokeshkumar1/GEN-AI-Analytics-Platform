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
        self.client.post(
            f"{path}/{model['revision']}/review", json={"decision": "approved"}
        ).raise_for_status()
        from api.models.execution_context import (
            current_selection,
            DatasetSelection,
            ExecutionContext,
        )
        from api.rag.pipeline import RAGPipeline

        entry = self.service._catalog()["datasets"][model["dataset_id"]]
        selection = DatasetSelection(
            ExecutionContext(
                workspace_id="default",
                user_id="owner",
                dataset_id=entry["id"],
                version=1,
                semantic_revision=model["revision"],
            ),
            entry,
            self.service._snapshot(entry, 1),
        )
        token = current_selection.set(selection)
        try:
            with (
                patch(
                    "api.rag.pipeline.intent_engine.classify",
                    return_value={
                        "metric": "Salary",
                        "aggregation": "SUM",
                        "intent": "analytical",
                    },
                ),
                patch("api.rag.pipeline.retriever.retrieve") as retrieve,
                patch(
                    "api.rag.pipeline.generator.generate_stream",
                    return_value=iter(["Calculated total: ", "0.30"]),
                ) as generate,
            ):
                events = []
                result = RAGPipeline()._run_scoped(
                    "Total salary", 5, callback=events.append, stream=True
                )
                self.assertIn("0.3", result["reply"])
                self.assertEqual(result["context"]["dataset_id"], entry["id"])
                self.assertEqual(result["data"]["records_matched"], 2)
                retrieve.assert_not_called()
                generate.assert_not_called()
                self.assertEqual(result["model"], "Deterministic analytics")
                self.assertTrue(any(event["type"] == "token" for event in events))
        finally:
            current_selection.reset(token)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "PLATFORM_METADATA_BACKEND": "sqlite",
                "PLATFORM_METADATA_PATH": str(Path(self.temp.name) / "metadata.db"),
                "PLATFORM_AUTO_APPROVE_SEMANTICS": "false",
            },
        )
        env.start()
        self.addCleanup(env.stop)
        metadata_store.cache_clear()
        self.addCleanup(metadata_store.cache_clear)
        self.service = DatasetService(
            Path(self.temp.name) / "datasets", default_async_index=False
        )
        self.addCleanup(self.service.wait_for_idle)
        # These workflows exercise local snapshots and real HTTP approval routes,
        # without reaching configured cloud AI or HANA services.
        for target in (
            "api.services.ai_core_service.ai_core_service.generate_structured_completion",
            "api.services.analytics_engine.analytics_engine._execute_on_hana",
        ):
            offline = patch(target, return_value=None)
            offline.start()
            self.addCleanup(offline.stop)
        for name, value in [("_index", ([], "Error")), ("_submit_indexing", None)]:
            p = patch.object(self.service, name, return_value=value)
            p.start()
            self.addCleanup(p.stop)
        for module in (
            datasets,
            semantic,
            dashboard,
            system,
            upload_service,
            dataset_module,
        ):
            p = patch.object(module, "dataset_service", self.service)
            p.start()
            self.addCleanup(p.stop)
        p = patch(
            "api.xsuaa.authenticated_profile",
            return_value={"user_id": "owner", "roles": ["Admin"], "role": "Admin"},
        )
        self.profile = p.start()
        self.addCleanup(p.stop)
        p = patch(
            "api.services.upload_service.hana_table_service.persist_dataframe",
            side_effect=lambda df, table_name, action: {
                "success": True,
                "table_name": table_name,
            },
        )
        p.start()
        self.addCleanup(p.stop)
        from api.config import settings

        p = patch.object(settings, "NVIDIA_API_KEY", "")
        p.start()
        self.addCleanup(p.stop)
        app = FastAPI()
        app.add_middleware(DatasetContextMiddleware)
        for router in (
            datasets.router,
            semantic.router,
            dashboard.router,
            system.router,
            upload.router,
        ):
            app.include_router(router)
        self.client = TestClient(app)

    def prepare(self):
        response = self.client.post(
            "/api/upload",
            files={
                "file": (
                    "HR.csv",
                    b"EmployeeID,Salary,Department\n001,0.10,IT\n002,0.20,HR\n",
                )
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        dataset_id = response.json()["dataset"]["id"]
        # This scenario tests an explicitly restricted dataset. Uploads remain
        # workspace-shared by default in the normal self-service workflow.
        grants = self.client.put(
            f"/api/datasets/{dataset_id}/access", json={"readers": [], "writers": []}
        )
        self.assertEqual(grants.status_code, 200, grants.text)
        path = f"/api/datasets/{dataset_id}/versions/1/semantics"
        proposal = self.client.post(path + "/propose").json()
        proposal["grain"] = "One employee record"
        next(f for f in proposal["fields"] if f["name"] == "Salary")[
            "default_aggregation"
        ] = "SUM"
        response = self.client.post(path, json=proposal)
        self.assertEqual(response.status_code, 200, response.text)
        model = response.json()
        headers = {
            "X-Dataset-Id": dataset_id,
            "X-Dataset-Version": "1",
            "X-Semantic-Revision": str(model["revision"]),
        }
        return path, model, headers

    def test_approval_is_enforced_through_real_http_paths(self):
        path, model, headers = self.prepare()
        query = {"metric": "Salary", "aggregation": "SUM"}
        self.assertEqual(
            self.client.post(
                "/api/insights/execute", json=query, headers=headers
            ).status_code,
            409,
        )
        response = self.client.post(
            f"{path}/{model['revision']}/review", json={"decision": "approved"}
        )
        self.assertEqual(response.status_code, 200, response.text)
        result = self.client.post("/api/insights/execute", json=query, headers=headers)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["summary"]["value"], 0.30)
        proposals = self.client.post("/api/insights/recommendations", headers=headers)
        self.assertEqual(proposals.status_code, 200, proposals.text)
        item = proposals.json()["items"][0]
        publication = {
            "title": "HR Overview",
            "items": [{"id": item["id"], "revision": item["revision"]}],
        }
        self.assertEqual(
            self.client.post(
                "/api/insights/dashboard", json=publication, headers=headers
            ).status_code,
            409,
        )
        response = self.client.post(
            f"/api/insights/definitions/{item['id']}/{item['revision']}/review",
            json={"decision": "approved"},
            headers=headers,
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            self.client.post(
                "/api/insights/dashboard", json=publication, headers=headers
            ).status_code,
            200,
        )
        response = self.client.get("/api/dashboard", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["widgets"][0]["result"]["summary"]["value"], 2)

    def test_generated_definitions_can_be_saved_approved_or_rejected_then_published(self):
        path, model, headers = self.prepare()
        self.client.post(f"{path}/{model['revision']}/review", json={"decision": "approved"}).raise_for_status()
        for decision in ("approved", "rejected"):
            response = self.client.post("/api/insights/definitions", headers=headers, json={
                "id": "generated-" + decision, "revision": 1, "title": "Generated Salary",
                "kind": "kpi", "semantic_revision": model["revision"], "status": "proposed",
                "query_plan": {"metric": "Salary", "aggregation": "SUM"},
                "dependencies": ["Salary"], "explanation": "Generated preview",
            })
            self.assertEqual(response.status_code, 200, response.text)
            saved = response.json()
            self.assertEqual(saved["status"], "proposed")
            response = self.client.post(
                f"/api/insights/definitions/{saved['id']}/{saved['revision']}/review",
                headers=headers, json={"decision": decision},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], decision)
            self.assertEqual(response.json()["reviewer"], "owner")
            response = self.client.post("/api/insights/dashboard", headers=headers, json={
                "title": "Generated dashboard", "items": [{"id": saved["id"], "revision": saved["revision"]}],
            })
            self.assertEqual(response.status_code, 200 if decision == "approved" else 409, response.text)

    def test_parallel_mixed_reviews_preserve_independent_decisions(self):
        from concurrent.futures import ThreadPoolExecutor
        path, model, headers = self.prepare()
        self.client.post(f"{path}/{model['revision']}/review", json={"decision": "approved"}).raise_for_status()
        saved = []
        for index in range(6):
            response = self.client.post("/api/insights/definitions", headers=headers, json={
                "id": f"parallel-{index}", "revision": 1, "title": f"Salary {index}", "kind": "kpi",
                "semantic_revision": model["revision"], "status": "proposed",
                "query_plan": {"metric": "Salary", "aggregation": "SUM"}, "dependencies": ["Salary"], "explanation": "Review test",
            })
            self.assertEqual(response.status_code, 200, response.text)
            saved.append(response.json())
        def review(pair):
            index, item = pair
            decision = "approved" if index % 2 == 0 else "rejected"
            response = self.client.post(f"/api/insights/definitions/{item['id']}/{item['revision']}/review", headers=headers, json={"decision": decision})
            return decision, response
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(review, enumerate(saved)))
        for decision, response in outcomes:
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["status"], decision)

    def test_backend_denies_other_accounts_even_if_client_supplies_owner_identity(self):
        path, model, headers = self.prepare()
        dataset_id = model["dataset_id"]
        self.profile.return_value = {
            "user_id": "other-user",
            "roles": ["Member"],
            "role": "Member",
        }
        response = self.client.put(
            f"/api/datasets/{dataset_id}/rows",
            json={"rows": [{"id": "invented", "Salary": 100}], "user_id": "owner"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get("/api/system/connections").status_code, 403)
        self.assertEqual(self.client.get("/api/datasets").json(), [])

    def test_unknown_definition_cannot_be_published_through_selected_dataset_fallback(
        self,
    ):
        path, model, headers = self.prepare()
        self.client.post(
            f"{path}/{model['revision']}/review", json={"decision": "approved"}
        ).raise_for_status()
        response = self.client.post(
            "/api/insights/dashboard",
            headers=headers,
            json={
                "title": "Invalid reference",
                "items": [{"id": "does-not-exist", "revision": 1}],
            },
        )
        self.assertEqual(response.status_code, 404, response.text)
        dashboard = self.client.get("/api/insights/dashboard", headers=headers)
        self.assertEqual(dashboard.status_code, 200, dashboard.text)
        self.assertEqual(dashboard.json()["items"], [])


if __name__ == "__main__":
    unittest.main()
