"""Tests for sequential 3-agent upload progress streaming and first-upload dashboard publishing."""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
routes_package = types.ModuleType("api.routes")
routes_package.__path__ = [str(Path(__file__).resolve().parents[1] / "api" / "routes")]
sys.modules.setdefault("api.routes", routes_package)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.platform import semantic as semantic_mod
from api.platform.semantic import SemanticRegistry
from api.platform.storage import ArtifactStore, DatasetRepository
from api.platform.store import MetadataStore
from api.routes import dashboard as dashboard_routes
from api.routes import upload as upload_routes
from api.services import dataset_service as dataset_service_mod
from api.services import upload_service as upload_service_mod
from api.services.embedding_service import embedding_service
from api.utils.context_middleware import DatasetContextMiddleware


class UploadSequentialAndPublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

        store = MetadataStore(Path(self.temp.name) / "metadata.db", "sqlite")
        objects = ArtifactStore("local", Path(self.temp.name) / "objects")
        repo = DatasetRepository(store, objects, "default")
        self.dataset_svc = dataset_service_mod.DatasetService(
            Path(self.temp.name) / "cache",
            default_async_index=False,
            repository=repo,
        )
        self.addCleanup(self.dataset_svc.wait_for_idle)
        self.semantic_reg = SemanticRegistry(store)

        for target, attr in [
            (dataset_service_mod, "dataset_service"),
            (upload_service_mod, "dataset_service"),
            (dashboard_routes, "dataset_service"),
        ]:
            p = patch.object(target, attr, self.dataset_svc)
            p.start()
            self.addCleanup(p.stop)

        for target, attr in [
            (semantic_mod, "semantic_registry"),
            (upload_service_mod, "semantic_registry"),
            (dashboard_routes, "semantic_registry"),
        ]:
            p = patch.object(target, attr, self.semantic_reg)
            p.start()
            self.addCleanup(p.stop)

        p = patch.object(
            embedding_service,
            "batch_embeddings",
            side_effect=lambda texts: [[1.0, 0.0] for _ in texts],
        )
        p.start()
        self.addCleanup(p.stop)

        p = patch.object(self.dataset_svc, "_sync_hana", return_value="Ready")
        p.start()
        self.addCleanup(p.stop)

        p = patch(
            "api.database.hana_table_service.hana_table_service.persist_dataframe",
            return_value={"success": True, "table_name": "DS_PROJECTS_V1", "rows_inserted": 2},
        )
        p.start()
        self.addCleanup(p.stop)

        p = patch(
            "api.platform.agent_domain_classifier.domain_classifier_agent._query_open_domain_llm",
            return_value=None,
        )
        p.start()
        self.addCleanup(p.stop)

        p = patch("api.xsuaa.authenticated_profile", return_value={"user_id": "tester", "roles": ["Admin"]})
        p.start()
        self.addCleanup(p.stop)

        app = FastAPI()
        app.add_middleware(DatasetContextMiddleware)
        app.include_router(upload_routes.router)
        app.include_router(dashboard_routes.router)
        self.client = TestClient(app)

    def test_first_upload_publishes_recommended_charts_without_409(self):
        csv_bytes = b"ProjectID,ProjectName,OpenIssues\nP1,Alpha,3\nP2,Beta,5\n"
        upload_res = self.client.post("/api/upload", files={"file": ("Projects.csv", csv_bytes)})
        self.assertEqual(upload_res.status_code, 200, upload_res.text)
        payload = upload_res.json()
        dataset_id = payload["dataset"]["id"]
        version = payload["version"]
        recs = payload["recommendations"]
        self.assertTrue(len(recs) > 0)

        # Even without explicit X-Dataset-Id headers, activeDatasetId from first upload works
        pub_no_headers = self.client.post(
            "/api/dashboard/publish-recommended",
            json={"title": "First Upload Dashboard", "items": recs[:2]},
        )
        self.assertEqual(pub_no_headers.status_code, 200, pub_no_headers.text)
        self.assertEqual(pub_no_headers.json()["published_count"], len(recs[:2]))

        # And with explicit headers, publish-recommended also succeeds
        pub_with_headers = self.client.post(
            "/api/dashboard/publish-recommended",
            headers={
                "X-Dataset-Id": dataset_id,
                "X-Dataset-Version": str(version),
                "X-Semantic-Revision": "1",
            },
            json={"title": "Header Selected Dashboard", "items": recs[:1]},
        )
        self.assertEqual(pub_with_headers.status_code, 200, pub_with_headers.text)
        self.assertEqual(pub_with_headers.json()["published_count"], 1)

    def test_upload_stream_emits_stages_strictly_one_by_one(self):
        csv_bytes = b"ProjectID,ProjectName,OpenIssues\nP1,Alpha,3\nP2,Beta,5\n"
        with self.client.stream("POST", "/api/upload/stream", files={"file": ("Projects.csv", csv_bytes)}) as resp:
            if resp.status_code != 200:
                resp.read()
                self.fail(f"Expected 200, got {resp.status_code}: {resp.text}")
            events = []
            for raw_line in resp.iter_lines():
                if raw_line.startswith("data: "):
                    events.append(json.loads(raw_line[6:]))

        stage_sequence = [(e["stage"], e["status"]) for e in events if e.get("type") == "stage"]
        self.assertEqual(
            stage_sequence,
            [
                (1, "running"),
                (1, "completed"),
                (2, "running"),
                (2, "completed"),
                (3, "running"),
                (3, "completed"),
                (4, "running"),
                (4, "completed"),
            ],
        )

        result_events = [e for e in events if e.get("type") == "result"]
        self.assertEqual(len(result_events), 1)
        final_data = result_events[0]["data"]
        self.assertEqual(final_data["status"], "success")
        self.assertEqual(final_data["rows_processed"], 2)
        self.assertTrue(len(final_data["recommendations"]) > 0)

