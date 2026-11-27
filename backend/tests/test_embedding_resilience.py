"""Offline provider failures, resumable snapshots and exact HANA numeric types."""

import copy
import json
import os
import tempfile
from decimal import Decimal
from pathlib import Path
from threading import Event
from unittest import TestCase
from unittest.mock import patch

import pandas as pd
import requests
from fastapi import HTTPException

from api.database.hana_table_service import HANATableService
from api.models.execution_context import current_selection, DatasetSelection, ExecutionContext
from api.models.query_plan import QueryPlan
from api.platform.storage import ArtifactStore, DatasetRepository
from api.platform.store import MetadataStore
from api.services.ai_core_service import ai_core_service, EmbeddingProviderError, settings
from api.services.dataset_service import DatasetService
from api.services.embedding_service import embedding_service, EmbeddingBatchError
from api.services.analytics_engine import AnalyticsEngine


def response(status, body, request_id=None):
    result = requests.Response()
    result.status_code = status
    result.url = "https://provider.example/embeddings"
    result._content = json.dumps(body).encode()
    if request_id:
        result.headers["x-request-id"] = request_id
    return result


class ProviderRetryTests(TestCase):
    def test_transient_500_retries_then_succeeds(self):
        success = response(200, {"data": [{"index": 0, "embedding": [1.0] * 1536}]})
        with (
            patch.object(settings, "NVIDIA_API_KEY", "test-key"),
            patch.object(ai_core_service.session, "post", side_effect=[response(500, {}), response(500, {}), success]) as post,
            patch("api.services.ai_core_service.time.sleep") as sleep,
        ):
            vectors = ai_core_service.generate_embeddings(["row"])
        self.assertEqual(len(vectors[0]), 1536)
        self.assertEqual(post.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_permanent_errors_do_not_retry_and_logs_redact_credentials(self):
        with (
            patch.object(settings, "NVIDIA_API_KEY", "test-key"),
            patch.object(ai_core_service.session, "post", return_value=response(401, {"error": {"message": "api_key=test-key Bearer secret-value"}}, "req-123")) as post,
            patch("api.services.ai_core_service.logger.error") as log,
            patch("api.services.ai_core_service.time.sleep") as sleep,
        ):
            with self.assertRaises(EmbeddingProviderError) as caught:
                ai_core_service.generate_embeddings(["private source row"])
        self.assertEqual(post.call_count, 1)
        sleep.assert_not_called()
        self.assertEqual(caught.exception.status_code, 401)
        self.assertIn("req-123", str(caught.exception))
        messages = str(log.call_args_list)
        self.assertNotIn("test-key", messages)
        self.assertNotIn("secret-value", messages)
        self.assertNotIn("private source row", messages)
        self.assertIn("[redacted]", messages)

    def test_persistent_500_has_a_bounded_attempt_count_and_request_id(self):
        with (
            patch.object(settings, "NVIDIA_API_KEY", "test-key"),
            patch.object(ai_core_service.session, "post", return_value=response(500, {"detail": "model server failed"}, "req-500")) as post,
            patch("api.services.ai_core_service.time.sleep"),
        ):
            with self.assertRaises(EmbeddingProviderError) as caught:
                ai_core_service.generate_embeddings(["row"])
        self.assertEqual(post.call_count, 3)
        self.assertEqual(caught.exception.status_code, 500)
        self.assertIn("req-500", str(caught.exception))
        self.assertNotIn("model server failed", str(caught.exception))


class BatchRecoveryTests(TestCase):
    def test_failed_batch_is_split_once_and_preserves_input_order(self):
        calls = []
        def generate(texts, **kwargs):
            calls.append((list(texts), kwargs))
            if len(texts) > 2:
                raise EmbeddingProviderError("HTTP 500", status_code=500)
            return [[float(text)] for text in texts]
        with (
            patch.dict(os.environ, {"EMBEDDING_BATCH_SIZE": "4", "EMBEDDING_MAX_WORKERS": "1"}),
            patch.object(ai_core_service, "generate_embeddings", side_effect=generate),
        ):
            vectors = embedding_service.batch_embeddings(["1", "2", "3", "4"])
        self.assertEqual(vectors, [[1.0], [2.0], [3.0], [4.0]])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1][1], {"max_retries": 0})

    def test_permanent_failure_stops_new_batches_and_collects_inflight_successes(self):
        observed_failure = Event()
        calls = []
        def generate(texts):
            calls.append(list(texts))
            if texts[0] == "a":
                raise EmbeddingProviderError("HTTP 401", status_code=401)
            self.assertTrue(observed_failure.wait(2))
            return [[2.0] for _ in texts]
        def progress(message, *args):
            if message.startswith("Embedding progress"):
                observed_failure.set()
        with (
            patch.dict(os.environ, {"EMBEDDING_BATCH_SIZE": "2", "EMBEDDING_MAX_WORKERS": "2"}),
            patch.object(ai_core_service, "generate_embeddings", side_effect=generate),
            patch("api.services.embedding_service.logger.info", side_effect=progress),
        ):
            with self.assertRaises(EmbeddingBatchError) as caught:
                embedding_service.batch_embeddings(["a", "b", "c", "d", "e", "f"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(caught.exception.completed, {"c": [2.0], "d": [2.0]})

    def test_smaller_batch_success_survives_failure_of_its_sibling(self):
        def generate(texts, **kwargs):
            if len(texts) > 2 or texts[0] == "c":
                raise EmbeddingProviderError("HTTP 500", status_code=500)
            return [[1.0] for _ in texts]
        with (
            patch.dict(os.environ, {"EMBEDDING_BATCH_SIZE": "4", "EMBEDDING_MAX_WORKERS": "1"}),
            patch.object(ai_core_service, "generate_embeddings", side_effect=generate),
        ):
            with self.assertRaises(EmbeddingBatchError) as caught:
                embedding_service.batch_embeddings(["a", "b", "c", "d"])
        self.assertEqual(caught.exception.completed, {"a": [1.0], "b": [1.0]})


class CheckpointTests(TestCase):
    def test_failed_reindex_commits_checkpoint_and_next_attempt_only_embeds_missing_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            store = MetadataStore(Path(folder) / "metadata.sqlite3", "sqlite")
            objects = ArtifactStore("local", Path(folder) / "objects")
            repository = DatasetRepository(store, objects, "default")
            service = DatasetService(Path(folder) / "cache", repository=repository)
            rows = [{"Name": "Alpha", "Units": 1}, {"Name": "Beta", "Units": 2}]
            frame = pd.DataFrame(rows)
            chunks = service._chunks(frame, "Numbers", rows)
            snapshot = {"rows": rows, "columns": service._columns(frame), "chunks": chunks,
                        "embeddings": [], "embeddingStatus": "Pending", "hanaSyncStatus": "Pending"}
            key = repository.save_snapshot(snapshot)
            entry = {"id": "test", "name": "Numbers", "folder": "Numbers", "currentVersion": 1, "updatedAt": "2026-11-26",
                     "versions": [{"version": 1, "filename": "Numbers.csv", "snapshotKey": key, "rowCount": 2, "columns": snapshot["columns"], "embeddingStatus": "Pending"}]}
            with service._writer():
                service._write_json(service.catalog_path, {"datasets": {"test": entry}, "activeDatasetId": "test"})
            error = EmbeddingBatchError(EmbeddingProviderError("HTTP 500; Request ID: req-test", status_code=500), {chunks[0]: [1.0, 0.0]})
            with patch.object(embedding_service, "batch_embeddings", side_effect=error):
                with self.assertRaises(HTTPException) as caught:
                    service.reindex("test")
            self.assertEqual(caught.exception.status_code, 503)
            saved_entry = service._catalog()["datasets"]["test"]
            failed = service._snapshot(saved_entry)
            self.assertEqual(failed["rows"], rows)
            self.assertEqual(failed["embeddingCount"], 1)
            self.assertEqual(failed["embeddingStatus"], "Error")
            self.assertEqual(failed["hanaSyncStatus"], "Blocked")
            self.assertIn("HTTP 500", failed["embeddingError"])
            self.assertEqual(len(failed["embeddingCheckpoint"]), 1)
            from api.routes import datasets as dataset_routes
            with (
                patch.object(dataset_routes, "dataset_service", service),
                patch.object(service, "_snapshot", side_effect=AssertionError("Status must use metadata")),
            ):
                status = dataset_routes.dataset_status("test", 1)
            self.assertEqual(status["embeddingCount"], 1)
            self.assertEqual(status["rowCount"], 2)
            self.assertEqual(status["hanaSyncStatus"], "Blocked")
            self.assertIn("HTTP 500", status["embeddingError"])
            # A new service instance must resume the persisted checkpoint.
            resumed = DatasetService(Path(folder) / "cache", repository=repository)
            with (
                patch.object(embedding_service, "batch_embeddings", return_value=[[0.0, 1.0]]) as batch,
                patch.object(resumed, "_sync_hana", return_value="Ready"),
            ):
                result = resumed.reindex("test")
            batch.assert_called_once_with([chunks[1]])
            ready = resumed._snapshot(resumed._catalog()["datasets"]["test"])
            self.assertEqual(ready["embeddings"], [[1.0, 0.0], [0.0, 1.0]])
            self.assertEqual(ready["rows"], rows)
            self.assertEqual(ready["embeddingCheckpoint"], {})
            self.assertIsNone(ready["embeddingError"])
            self.assertEqual(result["dataset"]["embeddingStatus"], "Ready")
            # A late failure from another attempt cannot replace a successful index.
            resumed._store_index_result(saved_entry, 1, failed)
            preserved = resumed._snapshot(resumed._catalog()["datasets"]["test"])
            self.assertEqual(preserved["embeddingStatus"], "Ready")
            self.assertEqual(preserved["embeddings"], ready["embeddings"])

    def test_checkpoint_is_not_reused_after_embedding_model_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            service = DatasetService(folder, repository=False)
            old = {"embeddingConfiguration": {"model": "old"}, "embeddingCheckpoint": {"unused": [1.0]}}
            with patch.object(embedding_service, "batch_embeddings", return_value=[[1.0]]) as batch:
                vectors, status = service._index(["row"], resume=old, progress={})
            batch.assert_called_once_with(["row"])
            self.assertEqual(status, "Ready")


class NumericTypeTests(TestCase):
    def test_decimal_objects_nullable_integers_and_identifiers_keep_their_types(self):
        frame = pd.DataFrame({
            "Amount": pd.Series([Decimal("123.456789"), Decimal("-0.000001")], dtype=object),
            "Count": pd.Series([12, None], dtype=object),
            "Code": ["00123", "00456"],
            "Ratio": [0.123456789, 0.2],
        })
        types = dict(HANATableService().infer_column_types(frame))
        self.assertEqual(types["AMOUNT"], "DECIMAL(9, 6)")
        self.assertEqual(types["COUNT"], "BIGINT")
        self.assertEqual(types["CODE"], "NVARCHAR(255)")
        self.assertEqual(types["RATIO"], "DOUBLE")

    def test_excess_decimal_precision_is_reported_without_rounding(self):
        with self.assertRaisesRegex(ValueError, "38 digits"):
            HANATableService().infer_column_types(pd.DataFrame({"Amount": [Decimal("1E+38")]}))

    def test_legacy_text_measure_uses_snapshot_without_executing_invalid_sql(self):
        entry = {"id": "ds", "tableName": "OLD_TABLE", "currentVersion": 1, "versions": [{"version": 1}]}
        selection = DatasetSelection(ExecutionContext(workspace_id="w", dataset_id="ds", version=1, semantic_revision=1, user_id="alice"), entry, {})
        token = current_selection.set(selection)
        try:
            with (
                patch("api.platform.datasets_metadata_repository.datasets_metadata_repo.load_schema_from_hana", return_value=[{"name": "Amount", "type": "string"}]),
                patch("api.database.hana_client.hana_client.execute_query") as execute,
            ):
                result = AnalyticsEngine()._execute_on_hana(QueryPlan.model_validate({"metric": "Amount", "aggregation": "SUM"}), 0)
            self.assertIsNone(result)
            execute.assert_not_called()
        finally:
            current_selection.reset(token)
