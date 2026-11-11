import unittest
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from starlette.testclient import TestClient
from api.app import app
from api.database.hana_table_service import hana_table_service


class TestHanaAdmin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.auth_headers = {"Authorization": "Bearer dev-token-local:admin@sap.com:Admin:12345678"}

    def test_database_stats(self):
        stats = hana_table_service.get_database_stats()
        self.assertTrue(stats.get("connected"))
        self.assertIn("host", stats)
        self.assertIn("schema", stats)
        self.assertGreaterEqual(stats.get("totalTables", 0), 1)

    def test_list_tables_service(self):
        tables_all = hana_table_service.list_user_tables(include_internal=True)
        self.assertGreaterEqual(len(tables_all), 1)
        table_names = [t["name"] for t in tables_all]
        self.assertIn("SALES_ANALYTICS", table_names)

        # Sales analytics columns
        sales_table = next(t for t in tables_all if t["name"] == "SALES_ANALYTICS")
        self.assertGreaterEqual(sales_table["rowCount"], 0)
        self.assertFalse(sales_table["isInternal"])

    def test_get_table_data_service(self):
        data = hana_table_service.get_table_data(
            "SALES_ANALYTICS",
            page=1,
            page_size=5,
            sort_col="ORDERID",
            sort_dir="ASC",
            search=""
        )
        self.assertEqual(data["tableName"], "SALES_ANALYTICS")
        self.assertGreaterEqual(data["totalRows"], 0)
        self.assertGreaterEqual(len(data["rows"]), 0)
        self.assertEqual(data["page"], 1)
        self.assertGreaterEqual(data["totalPages"], 0)

    def test_read_only_query_security(self):
        # Valid read-only query
        res = hana_table_service.execute_read_only_query('SELECT COUNT(*) AS CNT FROM "SALES_ANALYTICS"')
        self.assertTrue(res["success"])
        self.assertEqual(res["rowCount"], 1)

        # Prohibited queries must raise ValueError
        with self.assertRaises(ValueError):
            hana_table_service.execute_read_only_query('DROP TABLE "SALES_ANALYTICS"')

        with self.assertRaises(ValueError):
            hana_table_service.execute_read_only_query('DELETE FROM "SALES_ANALYTICS"')

        with self.assertRaises(ValueError):
            hana_table_service.execute_read_only_query('INSERT INTO "FOO" VALUES (1)')

    def test_api_overview_endpoint(self):
        res = self.client.get("/api/hanaadmin", headers=self.auth_headers)
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertTrue(payload.get("success"))
        self.assertEqual(payload.get("status"), "online")
        self.assertIn("tables", payload)

    def test_api_table_data_endpoint(self):
        res = self.client.get("/api/hanaadmin/tables/SALES_ANALYTICS/data?pageSize=3", headers=self.auth_headers)
        self.assertEqual(res.status_code, 200)
        payload = res.json()
        self.assertTrue(payload.get("success"))
        self.assertGreaterEqual(len(payload["rows"]), 0)
        self.assertEqual(payload["tableName"], "SALES_ANALYTICS")

    def test_delete_range_validation(self):
        # Invalid row range (toRow < fromRow) must fail with 400
        res = self.client.post(
            "/api/hanaadmin/tables/SALES_ANALYTICS/delete-range",
            headers=self.auth_headers,
            json={"mode": "row_range", "fromRow": 50, "toRow": 10}
        )
        self.assertEqual(res.status_code, 400)

        # Non-existent table must fail with 400
        res = self.client.post(
            "/api/hanaadmin/tables/NON_EXISTENT_XYZ/delete-range",
            headers=self.auth_headers,
            json={"mode": "row_range", "fromRow": 1, "toRow": 5}
        )
        self.assertEqual(res.status_code, 400)

    def test_delete_table_protected_system_table_prohibited(self):
        """Dropping protected system tables like DATASETS_METADATA or VECTOR_TABLE must be rejected with 400."""
        for tbl in ["DATASETS_METADATA", "VECTOR_TABLE", "PLATFORM_METADATA", "CHAT_MESSAGES"]:
            res = self.client.delete(f"/api/hanaadmin/tables/{tbl}", headers=self.auth_headers)
            self.assertEqual(res.status_code, 400)
            self.assertIn("strictly prohibited", res.json().get("detail", ""))

    def test_delete_table_nonexistent_returns_404(self):
        """Dropping a non-existent table must return 404."""
        from unittest.mock import patch
        with patch.object(hana_table_service, "table_exists", return_value=False):
            res = self.client.delete("/api/hanaadmin/tables/NON_EXISTENT_CUSTOM_TABLE", headers=self.auth_headers)
            self.assertEqual(res.status_code, 404)

    def test_delete_table_success(self):
        """Dropping a valid user table must successfully call drop_table and return 200."""
        from unittest.mock import patch
        with patch.object(hana_table_service, "table_exists", return_value=True), \
             patch.object(hana_table_service, "drop_table", return_value={"success": True, "dropped": True, "table_name": "DS_CUSTOM_V1"}):
            res = self.client.delete("/api/hanaadmin/tables/DS_CUSTOM_V1?cascade_dataset=false", headers=self.auth_headers)
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data.get("success"))
            self.assertTrue(data.get("dropped"))
            self.assertEqual(data.get("tableName"), "DS_CUSTOM_V1")


if __name__ == "__main__":
    unittest.main()

