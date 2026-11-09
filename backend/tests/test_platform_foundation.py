"""Accuracy, immutable snapshots, request isolation and backend authorization."""
import copy
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pandas as pd
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.models.execution_context import current_identity, current_selection
from api.services.analytics_engine import AnalyticsEngine
from api.services.dataset_service import DatasetService
from api.utils.context_middleware import DatasetContextMiddleware


class ExactAnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.engine = AnalyticsEngine()
        self.df = pd.DataFrame({"EmployeeID": ["00123", "00456", "00789"],
                                "Salary": [Decimal("0.10"), Decimal("0.20"), None],
                                "Department": ["Engineering", "Engineering", None]})

    def execute(self, **changes):
        return self.engine.execute({"metric": "Salary", "aggregation": "SUM", **changes}, self.df)

    def test_decimal_sum_preserves_precision_and_missing_is_not_zero(self):
        self.assertEqual(self.execute().summary["value"], "0.30")
        result = self.execute(filters=[{"column": "Salary", "operator": "IS_NULL"}])
        self.assertIsNone(result.summary["value"])

    def test_missing_metric_and_invalid_filters_never_return_unfiltered_totals(self):
        self.assertFalse(self.engine.execute({}, self.df).success)
        for condition in [dict(column="Unknown", operator="=", value="X"),
                          dict(column="Salary", operator=">", value="bad"),
                          dict(column="Salary", operator="UNSUPPORTED", value=1)]:
            result = self.execute(filters=[condition])
            self.assertFalse(result.success)
            self.assertEqual(result.data, [])

    def test_identifiers_counts_and_empty_results(self):
        result = self.execute(metric="EmployeeID", aggregation="COUNT_DISTINCT")
        self.assertEqual(result.summary["value"], 3)
        result = self.execute(filters=[dict(column="EmployeeID", operator="=", value="123")])
        self.assertEqual(result.status, "empty")

    def test_aggregation_permissions_and_literal_contains(self):
        result = self.engine.execute(dict(metric="EmployeeID", aggregation="SUM"), self.df,
                                     {"EmployeeID": ["COUNT", "COUNT_DISTINCT"]})
        self.assertFalse(result.success)
        result = self.execute(filters=[dict(column="Department", operator="CONTAINS", value=".*")])
        self.assertEqual(result.status, "empty")


class ContextIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = DatasetService(self.temp.name, default_async_index=False)
        self.addCleanup(self.service.wait_for_idle)
        for name, value in [("_index", ([], "Error")), ("_sync_hana", "Error")]:
            mock = patch.object(self.service, name, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)
        identity = current_identity.set(dict(user_id="owner", workspace_id="default", roles=["Member"]))
        try:
            self.a = self.service.upload(b"ID,Amount\n001,10\n", "A.csv")["dataset"]
            self.b = self.service.upload(b"ID,Amount\n002,20\n", "B.csv")["dataset"]
        finally:
            current_identity.reset(identity)
        app = FastAPI()
        app.add_middleware(DatasetContextMiddleware)
        @app.post("/api/analytics")
        def inspect_context():
            entry, snapshot = self.service.active()
            return {"dataset": entry["id"], "version": current_selection.get().context.version,
                    "rows": snapshot["rows"]}
        self.client = TestClient(app)
        from api.services import dataset_service as module
        mock = patch.object(module, "dataset_service", self.service)
        mock.start()
        self.addCleanup(mock.stop)
        mock = patch("api.xsuaa.authenticated_profile", return_value={"user_id": "owner", "roles": ["Member"]})
        self.profile = mock.start()
        self.addCleanup(mock.stop)
        mock = patch("api.platform.semantic.semantic_registry.get", return_value=Mock())
        mock.start(); self.addCleanup(mock.stop)
        mock = patch("api.platform.ai_settings.ai_settings", return_value=dict(llm_model="test", embedding_model="test", max_tokens=1500, temperature=0.2))
        mock.start(); self.addCleanup(mock.stop)

    def headers(self, item, version=1):
        return {"X-Dataset-Id": item["id"], "X-Dataset-Version": str(version)}

    def test_explicit_context_overrides_shared_active_selection(self):
        result = self.client.post("/api/analytics", headers=self.headers(self.a))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["dataset"], self.a["id"])
        self.assertEqual(result.json()["rows"][0]["Amount"], 10)
        self.assertIsNone(current_selection.get())

    def test_missing_context_wrong_workspace_and_other_user_are_denied(self):
        self.assertEqual(self.client.post("/api/analytics").status_code, 409)
        headers = {**self.headers(self.a), "X-Workspace-Id": "untrusted"}
        self.assertEqual(self.client.post("/api/analytics", headers=headers).status_code, 403)
        self.profile.return_value = {"user_id": "other-user", "roles": ["Member"]}
        self.assertEqual(self.client.post("/api/analytics", headers=self.headers(self.a)).status_code, 403)

    def test_parallel_requests_remain_isolated(self):
        def request(item):
            return self.client.post("/api/analytics", headers=self.headers(item)).json()["dataset"]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(request, [self.a, self.b] * 5))
        self.assertEqual(results, [item["id"] for item in [self.a, self.b] * 5])

    def test_failed_mutation_does_not_change_prior_cached_snapshot(self):
        entry = self.service._entry(self.service._catalog(), self.a["id"])
        before = copy.deepcopy(self.service._snapshot(entry))
        with self.assertRaises(Exception):
            self.service.mutate(self.a["id"], "append", [{"ID": "valid", "Amount": 30}, {"Wrong": 1}])
        self.assertEqual(self.service._snapshot(entry), before)


if __name__ == "__main__":
    unittest.main()
