"""Offline checks for transaction reuse and vector publication boundaries."""

import json
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch

from api.models.execution_context import current_identity
from api.platform.content import ContentWorkspace
from api.platform.content_store import PersonalStore
from api.routes import content
from api.services import dataset_service as dataset_module


class PipelineCostTests(TestCase):
    def test_bulk_metadata_reads_return_only_requested_records(self):
        pool = MagicMock()
        conn = pool.get_connection.return_value
        conn.getautocommit.return_value = True
        cursor = conn.cursor.return_value
        cursor.fetchall.return_value = [
            ("first:1", 1, '{"title":"First"}'),
            ("second:1", 2, '{"title":"Second"}'),
        ]
        store = PersonalStore(pool)
        result = store.get_many("definitions", ["first:1", "second:1", "first:1"])
        self.assertEqual(result["second:1"]["value"]["title"], "Second")
        self.assertEqual(
            cursor.execute.call_args.args[1], ("definitions", "first:1", "second:1")
        )
        self.assertIn("DOCUMENT_ID IN (?,?)", cursor.execute.call_args.args[0])
        conn.commit.assert_called_once()

    def test_file_tree_reuses_one_metadata_transaction(self):
        pool = MagicMock()
        conn = pool.get_connection.return_value
        conn.getautocommit.return_value = True
        cursor = conn.cursor.return_value
        cursor.fetchone.side_effect = [(1, '{"user_id":"alice"}'), (1, "{}")]
        cursor.fetchall.return_value = []
        token = current_identity.set(
            dict(tenant_id="t", workspace_id="w", user_id="alice")
        )
        try:
            workspace = ContentWorkspace(PersonalStore(pool))
            with patch.object(content, "ContentWorkspace", return_value=workspace):
                self.assertEqual(content.tree(), [])
        finally:
            current_identity.reset(token)
        pool.get_connection.assert_called_once()
        conn.commit.assert_called_once()
        pool.return_connection.assert_called_once_with(conn)

    def test_local_catalog_syncs_hana_only_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            service = dataset_module.DatasetService(directory, repository=False)
            catalog = {"datasets": {}, "activeDatasetId": None}
            with (
                patch.object(dataset_module, "OUTPUT_DIR", directory),
                patch(
                    "api.platform.datasets_metadata_repository.datasets_metadata_repo.save_catalog",
                    return_value=True,
                ) as save,
            ):
                service._write_json(service.catalog_path, catalog)
            save.assert_called_once_with(catalog)
            self.assertEqual(
                json.loads(service.catalog_path.read_text(encoding="utf-8")), catalog
            )

    def test_vector_batches_commit_once_and_failed_commit_releases_capacity(self):
        from api.database.vector_client import HANAVectorClient

        pool = MagicMock()
        conn = pool.get_connection.return_value
        client = HANAVectorClient()
        with patch("api.database.connection.db_manager", pool):
            client.replace_dataset_version(
                "ds", 1, ["row"] * 257, [[1.0]] * 257, "test"
            )
        self.assertEqual(conn.cursor.return_value.executemany.call_count, 2)
        conn.commit.assert_called_once()
        pool.return_connection.assert_called_once_with(conn)
        pool.reset_mock()
        conn.commit.side_effect = RuntimeError("commit failed")
        with patch("api.database.connection.db_manager", pool):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                client.replace_dataset_version("ds", 1, ["row"], [[1.0]], "test")
        conn.rollback.assert_called_once()
        pool.discard_connection.assert_called_once_with(conn)
        pool.return_connection.assert_not_called()
