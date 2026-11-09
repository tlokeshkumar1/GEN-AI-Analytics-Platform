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
        self.assertEqual(sales_table["rowCount"], 20000)
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
        self.assertEqual(data["totalRows"], 20000)
        self.assertEqual(len(data["rows"]), 5)
        self.assertEqual(data["page"], 1)
        self.assertGreater(data["totalPages"], 1)

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
        self.assertEqual(len(payload["rows"]), 3)
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


if __name__ == "__main__":
    unittest.main()

