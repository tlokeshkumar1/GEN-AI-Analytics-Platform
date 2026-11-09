"""Dataset persistence, version isolation, rollback and API regression tests."""
import io
import json
import sys
import types
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Import the routers under test without eagerly initializing unrelated chat/graph services.
routes_package = types.ModuleType("api.routes")
routes_package.__path__ = [str(Path(__file__).resolve().parents[1] / "api" / "routes")]
sys.modules.setdefault("api.routes", routes_package)

import pandas as pd
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.services import dataset_service as datasets
from api.services.embedding_service import embedding_service
from api.services import upload_service as uploads
from api.routes import datasets as routes
from api.routes.upload import router as upload_router


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = datasets.DatasetService(self.temp.name, default_async_index=False)
        self.addCleanup(self.service.wait_for_idle)
        # Dataset cleanup must never contact the configured live database during unit tests.
        p = patch("api.database.hana_client.hana_client.execute_query", return_value=[])
        p.start()
        self.addCleanup(p.stop)
        from api.services.excel_dataset_service import excel_dataset_service
        p = patch.object(excel_dataset_service, "_resolve_dataset_path", side_effect=lambda: self.service.active_path() or Path(self.temp.name) / "missing")
        p.start()
        self.addCleanup(p.stop)
        excel_dataset_service._df = None
        for target, attribute in [(datasets, "dataset_service"), (routes, "dataset_service"), (uploads, "dataset_service")]:
            p = patch.object(target, attribute, self.service)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(embedding_service, "batch_embeddings", side_effect=lambda texts: [[1.0, 0.0] for _ in texts])
        self.batch = p.start()
        self.addCleanup(p.stop)
        p = patch.object(embedding_service, "get_embedding", return_value=[1.0, 0.0])
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(self.service, "_sync_hana", return_value="Error")
        self.sync = p.start()
        self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(routes.router)
        app.include_router(upload_router)
        self.client = TestClient(app)

    def upload(self, name="Sales.csv", content=b"OrderNumber,NetRevenueUSD,Region\nA,10,East\nB,20,West\n"):
        response = self.client.post("/api/upload", files={"file": (name, content)})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "success")
        return response.json()["dataset"]

    def rows(self, dataset_id, **params):
        response = self.client.get(f"/api/datasets/{dataset_id}/data", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def context(self):
        from api.services.vector_service import vector_service
        return vector_service.search_similar_chunks("NetRevenueUSD", 10)

    def test_empty_list_and_real_data_routes(self):
        self.assertEqual(self.client.get("/api/datasets").json(), [])
        item = self.upload()
        listing = self.client.get("/api/datasets").json()
        self.assertEqual([d["id"] for d in listing], [item["id"]])
        page = self.rows(item["id"], page=1, pageSize=1, sortField="NetRevenueUSD", sortDir="desc")
        self.assertEqual(page["rows"][0]["OrderNumber"], "B")
        self.assertEqual(page["totalRows"], 2)
        self.assertEqual(page["totalPages"], 2)
        filtered = self.rows(item["id"], search="East")
        self.assertEqual(filtered["totalRows"], 1)
        self.assertEqual(self.client.get("/api/datasets/ds-101/data").status_code, 404)

    def test_file_versions_and_roll_back_data_embeddings_and_restart(self):
        item = self.upload()
        dataset_id = item["id"]
        folder = Path(self.temp.name) / "Sales"
        original = (folder / "Sales.csv").read_bytes()
        self.assertEqual(item["embeddingCount"], 2)
        self.assertTrue(all(json.loads(c["METADATA"])["version"] == 1 for c in self.context()))
        response = self.client.post(f"/api/datasets/{dataset_id}/append", data={"rows": json.dumps([
            {"OrderNumber": "C", "NetRevenueUSD": 900, "Region": "North"}])})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue((folder / "Sales_V2.csv").exists())
        self.assertEqual((folder / "Sales.csv").read_bytes(), original)
        self.assertEqual(self.rows(dataset_id)["totalRows"], 3)
        self.assertIn('900', " ".join(c["TEXT_CHUNK"] for c in self.context()))
        row = self.rows(dataset_id)["rows"][0]
        row["NetRevenueUSD"] = 777
        response = self.client.put(f"/api/datasets/{dataset_id}/rows", json={"rows": [row]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue((folder / "Sales_V3.csv").exists())
        response = self.client.post(f"/api/datasets/{dataset_id}/rollback", json={"version": 1})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.rows(dataset_id)["totalRows"], 2)
        text = " ".join(c["TEXT_CHUNK"] for c in self.context())
        self.assertNotIn('900', text)
        self.assertNotIn('777', text)
        self.assertTrue(all(json.loads(c["METADATA"])["version"] == 1 for c in self.context()))
        reloaded = datasets.DatasetService(self.temp.name)
        self.assertEqual(reloaded.active()[0]["currentVersion"], 1)
        self.assertEqual(len(reloaded.active()[1]["rows"]), 2)
        self.assertEqual(reloaded.active()[1]["embeddingCount"], 2)
        self.assertEqual(len(reloaded.search("revenue", 10)), 2)
        self.upload("Sales_V2.csv", b"OrderNumber,NetRevenueUSD,Region\nD,30,South\n")
        self.assertTrue((folder / "Sales_V4.csv").exists())
        self.assertEqual(self.rows(dataset_id)["totalRows"], 1)

    def test_analytics_and_schema_refresh_after_rollback(self):
        from api.services.excel_dataset_service import excel_dataset_service
        from api.services.data_service import data_service
        from api.services.schema_service import schema_service
        item = self.upload()
        self.assertEqual(data_service.get_dataframe()["NetRevenueUSD"].sum(), 30)
        self.upload(content=b"OrderNumber,NetRevenueUSD,NewColumn\nA,123,Foo\n")
        self.assertEqual(data_service.get_dataframe()["NetRevenueUSD"].sum(), 123)
        self.assertIn("NewColumn", schema_service.get_column_names())
        self.service.restore(item["id"], 1)
        self.assertEqual(data_service.get_dataframe()["NetRevenueUSD"].sum(), 30)
        self.assertNotIn("NewColumn", schema_service.get_column_names())
        self.assertEqual(excel_dataset_service.get_dataset_path().name, "Sales.csv")

    def test_append_excel_and_quoted_csv_parsed_once_with_actual_preview(self):
        item = self.upload()
        content = b'OrderNumber,NetRevenueUSD,Region\n"C, quoted",45,"East, coast"\n'
        url = f"/api/datasets/{item['id']}/append"
        preview = self.client.post(url + "/preview", files={"file": ("new.csv", content)})
        self.assertEqual(preview.json()["validRows"][0]["Region"], "East, coast")
        response = self.client.post(url, files={"file": ("new.csv", content)}, data={"rows": '[{"ignored":true}]'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["rowsAppended"], 1)
        buf = io.BytesIO()
        pd.DataFrame([{"OrderNumber": "D", "NetRevenueUSD": 55, "Region": "North"}]).to_excel(buf, index=False)
        response = self.client.post(url, files={"file": ("new.xlsx", buf.getvalue())})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.rows(item["id"])["totalRows"], 4)

    def test_mutations_reject_bad_schema_and_values_without_changing_version(self):
        item = self.upload()
        url = f"/api/datasets/{item['id']}/append"
        for rows in [[{"unexpected": 1}], [{"OrderNumber": "X", "Region": "East", "NetRevenueUSD": "invalid"}]]:
            self.assertEqual(self.client.post(url, data={"rows": json.dumps(rows)}).status_code, 400)
        self.assertEqual(self.client.post(url, data={"rows": "{}"}).status_code, 400)
        self.assertEqual(self.client.post(url, data={"rows": "invalid"}).status_code, 400)
        self.assertEqual(self.rows(item["id"])["dataset"]["currentVersion"], 1)
        self.assertEqual(self.client.post(f"/api/datasets/{item['id']}/rollback", json={"version": 999}).status_code, 404)

    def test_embedding_failure_persists_file_and_never_returns_old_context(self):
        item = self.upload()
        self.batch.side_effect = RuntimeError("provider unavailable")
        with self.assertLogs("datasets", level="ERROR"):
            updated = self.upload(content=b"OrderNumber,NetRevenueUSD,Region\nNEW,9999,North\n")
        self.assertEqual(updated["embeddingStatus"], "Error")
        self.assertEqual(updated["embeddingCount"], 0)
        self.assertEqual(updated["currentVersion"], 2)
        results = self.context()
        self.assertIn("9999", " ".join(c["TEXT_CHUNK"] for c in results))
        self.assertTrue(all(json.loads(c["METADATA"])["version"] == 2 for c in results))
        with self.assertLogs("datasets", level="ERROR"):
            self.assertEqual(self.client.post(f"/api/datasets/{item['id']}/reindex").status_code, 503)
        self.batch.side_effect = lambda texts: [[1.0, 0.0] for _ in texts]
        response = self.client.post(f"/api/datasets/{item['id']}/reindex")
        self.assertEqual(response.json()["dataset"]["embeddingStatus"], "Ready")
        self.assertEqual(response.json()["dataset"]["currentVersion"], 2)

    def test_row_and_dataset_deletion_remove_stale_context_but_restore_is_available(self):
        item = self.upload()
        row_id = self.rows(item["id"])["rows"][0]["__rowId"]
        response = self.client.request("DELETE", f"/api/datasets/{item['id']}/rows", json={"rowIds": [row_id]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.rows(item["id"])["totalRows"], 1)
        self.service.restore(item["id"], 1)
        self.assertEqual(self.rows(item["id"])["totalRows"], 2)
        self.assertEqual(self.client.delete(f"/api/datasets/{item['id']}").status_code, 200)
        self.assertEqual(self.client.get("/api/datasets").json(), [])
        self.assertEqual(self.context(), [])
        from api.services.data_service import data_service
        self.assertTrue(data_service.get_dataframe().empty)

    def test_legacy_file_imported_once_and_deletion_does_not_resurrect_it(self):
        path = Path(self.temp.name) / "Legacy.csv"
        path.write_bytes(b"Name,Value\nOld,5\n")
        items = self.client.get("/api/datasets").json()
        self.assertEqual(len(items), 1)
        self.assertTrue((Path(self.temp.name) / "Legacy" / "Legacy.csv").exists())
        self.assertEqual(items[0]["embeddingStatus"], "Pending")
        self.client.delete(f"/api/datasets/{items[0]['id']}")
        self.assertEqual(self.client.get("/api/datasets").json(), [])

    def test_parallel_appends_allocate_unique_monotonic_versions(self):
        item = self.upload()
        def append(i):
            return self.service.mutate(item["id"], "append", [{"OrderNumber": str(i), "NetRevenueUSD": i, "Region": "East"}])
        with ThreadPoolExecutor(max_workers=3) as pool:
            versions = sorted(r["version"] for r in pool.map(append, range(3)))
        self.assertEqual(versions, [2, 3, 4])
        self.assertEqual(self.rows(item["id"])["totalRows"], 5)

    def test_invalid_upload_is_400_and_cannot_escape_output_folder(self):
        response = self.client.post("/api/upload", files={"file": ("bad.csv", b"")})
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/upload", files={"file": ("bad.txt", b"abc")})
        self.assertEqual(response.status_code, 400)
        item = self.upload("../../Safe.csv")
        self.assertEqual(item["name"], "Safe.csv")
        self.assertTrue((Path(self.temp.name) / "Safe" / "Safe.csv").exists())

    def test_changing_upload_extension_retains_readable_versions(self):
        item = self.upload()
        buf = io.BytesIO()
        pd.DataFrame([{"Name": "Excel", "Value": 42}]).to_excel(buf, index=False)
        self.upload("Sales.xlsx", buf.getvalue())
        self.assertEqual(self.service.active_path().suffix, ".xlsx")
        self.assertEqual(self.rows(item["id"])["rows"][0]["Value"], 42)
        self.service.restore(item["id"], 1)
        self.assertEqual(self.service.active_path().suffix, ".csv")

    def test_unchanged_chunks_reuse_embeddings_and_rollback_needs_no_regeneration(self):
        content = ("OrderNumber,NetRevenueUSD,Region\n" + "\n".join(f"ORDER-{i},10,East" for i in range(1000))).encode()
        item = self.upload(content=content)
        original_count = item["embeddingCount"]
        self.assertGreater(original_count, 2)
        self.batch.reset_mock()
        result = self.service.mutate(item["id"], "append", [{"OrderNumber": "NEW", "NetRevenueUSD": 123, "Region": "West"}])
        self.assertLess(len(self.batch.call_args.args[0]), original_count)
        self.assertEqual(result["dataset"]["embeddingCount"], original_count + 1)
        self.batch.reset_mock()
        self.service.restore(item["id"], 1)
        self.batch.assert_not_called()

    def test_async_upload_returns_pending_and_completes_in_background(self):
        self.service.default_async_index = True
        res = self.client.post("/api/upload", files={"file": ("AsyncSales.csv", b"OrderNumber,NetRevenueUSD,Region\nA,10,East\nB,20,West\n")})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        dataset_id = data["dataset"]["id"]
        self.assertEqual(data["dataset"]["embeddingStatus"], "Pending")
        self.service.wait_for_idle(timeout=5)
        status_res = self.client.get(f"/api/datasets/{dataset_id}/status")
        self.assertEqual(status_res.status_code, 200)
        self.assertEqual(status_res.json()["embeddingStatus"], "Ready")
        self.assertEqual(status_res.json()["embeddingCount"], 2)

    def test_upload_with_cloud_table_destination(self):
        from api.database.hana_table_service import hana_table_service
        with patch.object(hana_table_service, "persist_dataframe", return_value={"success": True, "table_name": "CUSTOM_SALES", "rows_inserted": 2, "action": "create"}) as mock_persist:
            res = self.client.post(
                "/api/upload",
                files={"file": ("CloudSales.csv", b"OrderNumber,NetRevenueUSD,Region\nA,10,East\nB,20,West\n")},
                data={"target_table_name": "CUSTOM_SALES", "target_table_action": "create"}
            )
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data["cloud_table"]["success"])
            self.assertEqual(data["cloud_table"]["table_name"], "CUSTOM_SALES")
            self.assertEqual(data["cloud_table"]["rows_inserted"], 2)
            mock_persist.assert_called_once()
            self.assertEqual(data["rows_processed"], 2)
            self.assertEqual(data["version"], 1)

    @patch.dict("os.environ", {"MAX_VERSIONS_PER_DATASET": "5"})
    def test_version_pruning_limits_stored_versions(self):
        item = self.upload()
        dataset_id = item["id"]
        for i in range(1, 7):
            self.service.mutate(dataset_id, "append", [{"OrderNumber": f"ORD-{i}", "NetRevenueUSD": i * 10, "Region": "East"}], async_index=False)
        entry = self.service._entry(self.service._catalog(), dataset_id)
        self.assertLessEqual(len(entry["versions"]), 5)
        self.assertEqual(entry["currentVersion"], 7)
        version_numbers = [v["version"] for v in entry["versions"]]
        self.assertNotIn(1, version_numbers)
        self.assertIn(7, version_numbers)


class HANAVersionTests(unittest.TestCase):
    def setUp(self):
        from api.database.hana_client import hana_client
        with patch.object(hana_client, "execute_query", return_value=[]):
            from api.database.vector_client import HANAVectorClient
        self.client = HANAVectorClient.__new__(HANAVectorClient)

    def test_version_sync_rolls_back_failed_insert_and_does_not_claim_success(self):
        from api.database import connection
        manager = Mock()
        conn = manager.get_connection.return_value
        cursor = conn.cursor.return_value
        cursor.executemany.side_effect = RuntimeError("insert failed")
        with patch.object(connection, "db_manager", manager):
            with self.assertRaises(RuntimeError):
                self.client.replace_dataset_version("ds-real", 2, ["new text"], [[1.0]], "Sales.csv")
        conn.rollback.assert_called_once()
        conn.commit.assert_not_called()
        manager.return_connection.assert_not_called()
        self.assertEqual(cursor.execute.call_args_list[0].args[1], ("ds-real:v2:%",))

    def test_hana_search_is_scoped_to_selected_version(self):
        from api.database.vector_client import hana_client
        with patch.object(hana_client, "execute_query", return_value=[]) as query:
            self.client.search_dataset_version("ds-real", 1, [1.0], 5)
        self.assertIn("WHERE ID LIKE ?", query.call_args.args[0])
        self.assertEqual(query.call_args.args[1], ("[1.0]", "ds-real:v1:%"))


class EmbeddingBatchTests(unittest.TestCase):
    def test_provider_batch_preserves_input_order_and_hana_dimensions(self):
        from api.services.ai_core_service import ai_core_service, settings
        response = Mock()
        response.json.return_value = {"data": [{"index": 1, "embedding": [2.0] * 2048}, {"index": 0, "embedding": [1.0] * 2048}]}
        with patch.object(settings, "NVIDIA_API_KEY", "test-key"), patch.object(ai_core_service, "_request_with_retry", return_value=response) as request:
            vectors = ai_core_service.generate_embeddings(["first", "second"])
        self.assertEqual([v[0] for v in vectors], [1.0, 2.0])
        self.assertEqual([len(v) for v in vectors], [1536, 1536])
        self.assertEqual(request.call_args.args[2]["input"], ["first", "second"])


if __name__ == "__main__":
    unittest.main()
