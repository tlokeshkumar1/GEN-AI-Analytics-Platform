"""Read-path concurrency checks, with no live database or provider calls."""

import json
from concurrent.futures import Future, ThreadPoolExecutor
from threading import Barrier, Event, Lock
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.models.execution_context import current_identity
from api.platform.storage import DatasetRepository
from api.routes import dashboard, semantic
from api.routes.datasets import dataset_agent_activity
from api.services.dataset_service import DatasetService


class ConcurrentDataReadsTests(TestCase):
    def repository(self, get=None):
        objects = MagicMock()
        payloads = {
            "manifest": {"data": "rows", "index": "vectors"},
            "rows": {"columns": [{"name": "amount"}], "rows": [{"amount": 12}]},
            "vectors": {"embeddings": [[0.1, 0.2]], "embeddingStatus": "Ready"},
        }
        objects.get.side_effect = get or (lambda key: json.dumps(payloads[key]).encode())
        return DatasetRepository(store=MagicMock(), objects=objects)

    def test_twelve_simultaneous_reads_share_one_download_and_return_isolated_results(self):
        repo = self.repository()
        start = Barrier(12)

        def read():
            start.wait(timeout=5)
            return repo.snapshot("manifest", include_index=False)

        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: read(), range(12)))
        self.assertEqual(repo.objects.get.call_count, 2)
        self.assertEqual([call.args[0] for call in repo.objects.get.call_args_list], ["manifest", "rows"])
        results[0]["rows"][0]["amount"] = 99
        self.assertTrue(all(result["rows"][0]["amount"] == 12 for result in results[1:]))
        self.assertEqual(repo.snapshot("manifest", include_index=False)["rows"][0]["amount"], 12)

    def test_slow_dataset_does_not_block_another_dataset(self):
        entered, release = Event(), Event()

        def get(key):
            if key == "slow":
                entered.set()
                if not release.wait(timeout=5):
                    raise RuntimeError("Test timed out")
            return json.dumps({"data": "rows", "index": "vectors"} if key != "rows" else {"rows": []}).encode()

        repo = self.repository(get)
        with ThreadPoolExecutor(max_workers=2) as pool:
            slow = pool.submit(repo.snapshot, "slow", include_index=False)
            try:
                self.assertTrue(entered.wait(timeout=2))
                fast = pool.submit(repo.snapshot, "fast", include_index=False)
                self.assertEqual(fast.result(timeout=2), {"rows": []})
            finally:
                release.set()
            slow.result(timeout=2)

    def test_index_load_stays_separate_and_failures_can_be_retried(self):
        repo = self.repository()
        repo.snapshot("manifest", include_index=False)
        full = repo.snapshot("manifest")
        self.assertEqual(full["embeddings"], [[0.1, 0.2]])
        self.assertNotIn("embeddings", repo.snapshot("manifest", include_index=False))
        other = self.repository()
        get = other.objects.get.side_effect
        other.objects.get.side_effect = RuntimeError("Connection lost")
        with self.assertRaises(RuntimeError):
            other.snapshot("manifest", include_index=False)
        self.assertFalse(other._snapshot_loads)
        other.objects.get.side_effect = get
        self.assertEqual(other.snapshot("manifest", include_index=False)["rows"][0]["amount"], 12)

    def test_snapshot_memory_budget_is_enforced(self):
        repo = self.repository()
        repo._snapshot_cache_max_bytes = 1
        repo.snapshot("manifest", include_index=False)
        self.assertFalse(repo._snapshot_cache)
        self.assertEqual(repo._snapshot_cache_bytes, 0)

    def test_warm_cache_does_not_bypass_another_users_dataset_permissions(self):
        repo = self.repository()
        service = DatasetService(repository=repo)
        entry = {"id": "private", "name": "Private", "workspaceId": "w", "ownerId": "alice", "readers": [],
                 "writers": [], "currentVersion": 1, "versions": [{"version": 1, "snapshotKey": "manifest"}]}
        with patch.object(service, "_catalog", return_value={"datasets": {"private": entry}}):
            alice = current_identity.set({"workspace_id": "w", "user_id": "alice"})
            try:
                source = service._entry(service._catalog(), "private")
                service._snapshot(source, include_index=False)
            finally:
                current_identity.reset(alice)
            bob = current_identity.set({"workspace_id": "w", "user_id": "bob"})
            try:
                with self.assertRaises(HTTPException) as error:
                    service.data("private")
                self.assertEqual(error.exception.status_code, 403)
            finally:
                current_identity.reset(bob)
        self.assertEqual(repo.objects.get.call_count, 2)

    def test_semantic_metadata_and_agent_activity_do_not_fetch_snapshots(self):
        entry = {"id": "d", "name": "Data", "currentVersion": 1, "tableName": "DATA",
                 "versions": [{"version": 1, "columns": [], "rowCount": 3650, "embeddingStatus": "Ready", "embeddingCount": 3650}]}
        with patch.object(semantic, "dataset_service") as service, patch.object(semantic, "semantic_registry") as registry:
            service._entry.return_value = entry
            registry.list.return_value = []
            self.assertEqual(semantic.semantics("d", 1), [])
            service._snapshot.assert_not_called()
            with self.assertRaises(HTTPException):
                semantic.semantics("d", 2)
        with (
            patch("api.routes.datasets.dataset_service") as service,
            patch("api.routes.datasets.require_dataset_access"),
            patch("api.platform.semantic.semantic_registry.list", return_value=[]),
            patch("api.platform.semantic.semantic_registry.items", return_value=[]),
        ):
            service._entry.return_value = entry
            service._version_meta.return_value = {"rowCount": 3650, "embeddingCount": 3650}
            result = dataset_agent_activity("d", version=1)
            service._snapshot.assert_not_called()
            self.assertEqual(result["result"]["rows_processed"], 3650)

    def test_concurrent_dashboard_requests_are_scoped_to_each_user(self):
        start = Barrier(8)
        seen = []

        def calculate(refresh):
            user = current_identity.get()["user_id"]
            seen.append(user)
            return {"user": user, "widgets": []}

        def read(user):
            token = current_identity.set({"workspace_id": "w", "tenant_id": "t", "user_id": user})
            try:
                start.wait(timeout=5)
                return dashboard.get_dashboard()
            finally:
                current_identity.reset(token)

        with patch.object(dashboard, "_get_dashboard", side_effect=calculate), ThreadPoolExecutor(max_workers=8) as pool:
            users = ["alice", "bob"] * 4
            results = list(pool.map(read, users))
        self.assertEqual([result["user"] for result in results], users)
        self.assertFalse(dashboard._DASHBOARD_IN_FLIGHT)

    def test_history_failure_releases_connection_pool_capacity(self):
        from api.services.history_service import ChatHistoryService
        with patch("api.services.history_service.db_manager") as manager:
            conn = manager.get_connection.return_value
            conn.cursor.return_value.execute.side_effect = RuntimeError("Network failed")
            with self.assertRaises(HTTPException):
                with ChatHistoryService()._cursor("read") as cursor:
                    cursor.execute("SELECT 1 FROM DUMMY")
            manager.discard_connection.assert_called_once_with(conn)
            manager.return_connection.assert_not_called()

    def test_four_matching_dashboard_requests_calculate_once(self):
        entered, release, waiting = Event(), Event(), Event()
        lock = Lock()
        count = [0]

        class ObservedFuture(Future):
            def result(self, timeout=None):
                with lock:
                    count[0] += 1
                    if count[0] == 3:
                        waiting.set()
                return super().result(timeout)

        def calculate(refresh):
            entered.set()
            if not release.wait(timeout=5):
                raise RuntimeError("Test timed out")
            return {"widgets": [{"value": 12}]}

        def read():
            token = current_identity.set({"workspace_id": "w", "tenant_id": "t", "user_id": "alice"})
            try:
                return dashboard.get_dashboard()
            finally:
                current_identity.reset(token)

        with patch.object(dashboard, "_get_dashboard", side_effect=calculate) as execute, patch.object(dashboard, "Future", ObservedFuture), ThreadPoolExecutor(max_workers=4) as pool:
            primary = pool.submit(read)
            try:
                self.assertTrue(entered.wait(timeout=2))
                followers = [pool.submit(read) for _ in range(3)]
                self.assertTrue(waiting.wait(timeout=2))
            finally:
                release.set()
            responses = [primary.result(timeout=2), *(f.result(timeout=2) for f in followers)]
        execute.assert_called_once()
        responses[0]["widgets"][0]["value"] = 99
        self.assertTrue(all(item["widgets"][0]["value"] == 12 for item in responses[1:]))
