"""Unit tests for comprehensive cascade dataset deletion across all storage layers."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.database.hana_table_service import HANATableService
from api.database.vector_client import HANAVectorClient
from api.models.execution_context import current_identity
from api.platform.datasets_metadata_repository import DatasetsMetadataRepository
from api.platform.store import MetadataStore
from api.services.dataset_service import DatasetService


class CascadeDatasetDeletionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.identity_token = current_identity.set({
            "user_id": "test-admin",
            "workspace_id": "default",
            "roles": ["Admin"],
            "role": "Admin",
        })
        self.addCleanup(lambda: current_identity.reset(self.identity_token))

    def test_hana_table_drop_safeguards_system_tables(self):
        service = HANATableService()
        system_tables = [
            "DATASETS_METADATA",
            "PLATFORM_METADATA",
            "PLATFORM_DOCUMENTS",
            "VECTOR_TABLE",
            "CHAT_MESSAGES",
            "CHAT_SESSIONS",
        ]
        for tbl in system_tables:
            with self.assertRaises(ValueError) as ctx:
                service.drop_table(tbl)
            self.assertIn("strictly prohibited", str(ctx.exception))

    def test_hana_table_drop_handles_nonexistent_table(self):
        service = HANATableService()
        with patch("api.database.hana_table_service.db_manager") as mock_db:
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchone.return_value = None  # table does not exist
            mock_conn.cursor.return_value = mock_cursor
            mock_db.get_connection.return_value = mock_conn

            result = service.drop_table("NON_EXISTENT_DATASET_TABLE")
            self.assertTrue(result["success"])
            self.assertFalse(result["dropped"])
            self.assertEqual(result["reason"], "not_found")
            mock_conn.commit.assert_not_called()

    def test_hana_table_drop_executes_for_user_table(self):
        service = HANATableService()
        with patch("api.database.hana_table_service.db_manager") as mock_db:
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchone.return_value = (1,)  # table exists
            mock_conn.cursor.return_value = mock_cursor
            mock_db.get_connection.return_value = mock_conn

            result = service.drop_table("DS_SALES_RECORDS_V1")
            self.assertTrue(result["success"])
            self.assertTrue(result["dropped"])
            self.assertEqual(result["table_name"], "DS_SALES_RECORDS_V1")
            mock_cursor.execute.assert_any_call('DROP TABLE "DS_SALES_RECORDS_V1"')
            mock_conn.commit.assert_called_once()

    def test_platform_metadata_purge_removes_matching_namespaces(self):
        db_path = Path(self.temp_dir.name) / "test_meta.sqlite"
        store = MetadataStore(path=str(db_path), backend="sqlite")

        # Put items for dataset A
        store.put("default:semantic:ds-aaa:v1", "1", {"model": "A1"})
        store.put("default:analytics:1:ds-aaa:v1", "item1", {"plan": "A1"})

        # Put items for dataset B
        store.put("default:semantic:ds-bbb:v1", "1", {"model": "B1"})

        # Verify dataset A exists before purge
        self.assertIsNotNone(store.get("default:semantic:ds-aaa:v1", "1"))
        self.assertIsNotNone(store.get("default:semantic:ds-bbb:v1", "1"))

        # Purge dataset A
        purged = store.delete_dataset_metadata("default", "ds-aaa")
        self.assertGreaterEqual(purged, 2)

        # Dataset A is gone
        self.assertIsNone(store.get("default:semantic:ds-aaa:v1", "1"))
        self.assertIsNone(store.get("default:analytics:1:ds-aaa:v1", "item1"))

        # Dataset B is preserved
        self.assertIsNotNone(store.get("default:semantic:ds-bbb:v1", "1"))

    def test_datasets_metadata_delete_executes_delete_sql(self):
        repo = DatasetsMetadataRepository(workspace_id="test-workspace")
        mock_client = Mock()
        with patch.object(repo, "_client", return_value=mock_client):
            success = repo.delete_dataset("ds-xyz")
            self.assertTrue(success)
            mock_client.execute_query.assert_called_once_with(
                "DELETE FROM DATASETS_METADATA WHERE WORKSPACE_ID = ? AND DATASET_ID = ?",
                ("test-workspace", "ds-xyz"),
            )

    def test_vector_client_delete_purges_all_namespace_variants(self):
        client = HANAVectorClient()
        with patch("api.database.vector_client.hana_client") as mock_hana:
            client.delete_dataset("ds-target")
            mock_hana.execute_query.assert_called_once()
            args = mock_hana.execute_query.call_args[0]
            sql = args[0]
            params = args[1]

            self.assertIn("DELETE FROM VECTOR_TABLE", sql)
            self.assertIn("ds-target:%", params)
            self.assertIn("%:ds-target:%", params)
            self.assertIn('%"dataset_id": "ds-target"%', params)

    @patch("api.platform.ai_settings.ai_settings", return_value={"llm_model": "test", "embedding_model": "test", "max_tokens": 1500, "temperature": 0.2})
    def test_dataset_service_delete_coordinates_full_cascade(self, mock_ai):
        service = DatasetService(self.temp_dir.name, default_async_index=False)
        self.addCleanup(service.wait_for_idle)

        with patch.object(service, "_prune_old_versions", return_value=None), \
             patch.object(service, "_index", return_value=([], None)):
            # Upload a dataset
            csv_bytes = b"ID,Product,Amount\n1,Alpha,100\n2,Beta,200\n"
            upload_res = service.upload(csv_bytes, "TestPurge.csv")
            dataset_id = upload_res["dataset"]["id"]
            entry = service._catalog()["datasets"][dataset_id]
            folder = entry["folder"]

            folder_path = service.output_dir / folder
            self.assertTrue(folder_path.exists())

            # Mock HANA services and metadata store
            mock_store = MagicMock()
            with patch("api.platform.store.metadata_store", return_value=mock_store), \
                 patch("api.database.hana_table_service.hana_table_service.table_exists", return_value=True), \
                 patch("api.database.hana_table_service.hana_table_service.drop_table", return_value={"success": True, "dropped": True, "table_name": f"DS_{folder[:18].upper()}_V1"}), \
                 patch("api.platform.datasets_metadata_repository.datasets_metadata_repo.delete_dataset", return_value=True) as mock_ds_meta, \
                 patch("api.database.vector_client.vector_client.delete_dataset") as mock_vec:

                res = service.delete(dataset_id)

                self.assertTrue(res["success"])
                self.assertEqual(res["deleted"]["dataset_id"], dataset_id)
                self.assertTrue(res["deleted"]["datasets_metadata_deleted"])
            self.assertTrue(res["deleted"]["vector_rows_deleted"])
            self.assertTrue(res["deleted"]["local_files_removed"])

            # Verify local storage was removed
            self.assertFalse(folder_path.exists())

            # Verify dataset was removed from catalog
            catalog = service._catalog()
            self.assertNotIn(dataset_id, catalog["datasets"])

            # Verify vector client was called
            mock_vec.assert_called_once_with(dataset_id)
            mock_ds_meta.assert_called_once_with(dataset_id)


if __name__ == "__main__":
    unittest.main()
