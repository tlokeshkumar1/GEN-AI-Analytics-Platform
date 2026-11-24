import unittest
import sys
import sqlite3
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from starlette.testclient import TestClient
from api.app import app
from api.database.hana_table_service import hana_table_service


class CatalogCursor:
    """DB-API boundary: SQLite executes SQL against a small HANA catalog fixture."""

    def __init__(self, connection):
        self.connection = connection
        self.cursor = connection.database.cursor()

    def execute(self, sql, params=()):
        self.connection.statements.append((sql, params))
        if sql.strip().upper().startswith("SET SCHEMA"):
            return self
        sql = sql.replace("CURRENT_SCHEMA", "'TEST_SCHEMA'").replace(
            '"TEST_SCHEMA".', ""
        )
        self.cursor.execute(sql, params)
        return self

    def __getattr__(self, name):
        return getattr(self.cursor, name)


class CatalogConnection:
    def __init__(self):
        self.database = sqlite3.connect(":memory:", check_same_thread=False)
        self.statements = []
        self.database.executescript("""
            ATTACH DATABASE ':memory:' AS SYS;
            CREATE TABLE SALES_ANALYTICS (ORDERID TEXT, REGION TEXT, REVENUE INTEGER);
            INSERT INTO SALES_ANALYTICS VALUES ('001', 'East', 10), ('002', 'West', 20), ('003', 'East', 30);
            CREATE TABLE VECTOR_TABLE (ID TEXT);
            CREATE TABLE SYS.TABLES (SCHEMA_NAME TEXT, TABLE_NAME TEXT, TABLE_TYPE TEXT);
            INSERT INTO SYS.TABLES VALUES ('TEST_SCHEMA', 'SALES_ANALYTICS', 'COLUMN'), ('TEST_SCHEMA', 'VECTOR_TABLE', 'COLUMN');
            CREATE TABLE SYS.M_TABLES (SCHEMA_NAME TEXT, TABLE_NAME TEXT, RECORD_COUNT INTEGER);
            INSERT INTO SYS.M_TABLES VALUES ('TEST_SCHEMA', 'SALES_ANALYTICS', 3), ('TEST_SCHEMA', 'VECTOR_TABLE', 0);
            CREATE TABLE SYS.M_DATABASE (VERSION TEXT);
            INSERT INTO SYS.M_DATABASE VALUES ('offline-driver-fixture');
            CREATE TABLE SYS.TABLE_COLUMNS (
                SCHEMA_NAME TEXT, TABLE_NAME TEXT, COLUMN_NAME TEXT, DATA_TYPE_NAME TEXT,
                LENGTH INTEGER, SCALE INTEGER, IS_NULLABLE TEXT, POSITION INTEGER, DEFAULT_VALUE TEXT, COMMENTS TEXT);
            INSERT INTO SYS.TABLE_COLUMNS VALUES
                ('TEST_SCHEMA', 'SALES_ANALYTICS', 'ORDERID', 'NVARCHAR', 50, 0, 'TRUE', 1, NULL, NULL),
                ('TEST_SCHEMA', 'SALES_ANALYTICS', 'REGION', 'NVARCHAR', 50, 0, 'TRUE', 2, NULL, NULL),
                ('TEST_SCHEMA', 'SALES_ANALYTICS', 'REVENUE', 'INTEGER', 10, 0, 'TRUE', 3, NULL, NULL),
                ('TEST_SCHEMA', 'VECTOR_TABLE', 'ID', 'NVARCHAR', 50, 0, 'TRUE', 1, NULL, NULL);
        """)

    def cursor(self):
        return CatalogCursor(self)

    def setautocommit(self, enabled):
        self.database.isolation_level = None if enabled else ""

    def __getattr__(self, name):
        return getattr(self.database, name)


class TestHanaAdmin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.auth_headers = {
            "Authorization": "Bearer dev-token-local:admin@sap.com:Admin:12345678"
        }

    def setUp(self):
        # Exercise real services/routes and SQL without assuming an external HANA
        # instance or a developer's XSUAA binding exists on the test machine.
        self.connection = CatalogConnection()
        self.addCleanup(self.connection.close)
        self.manager = Mock()
        self.manager.get_connection.return_value = self.connection
        dependencies = [
            patch("api.database.hana_table_service.db_manager", self.manager),
            patch(
                "api.database.hana_table_service.settings.HANA_SCHEMA", "TEST_SCHEMA"
            ),
            patch(
                "api.database.hana_table_service.settings.HANA_ADDRESS",
                "offline-test.local",
            ),
            patch(
                "api.xsuaa.authenticated_profile",
                return_value={
                    "user_id": "test-admin",
                    "role": "Admin",
                    "roles": ["Admin"],
                },
            ),
        ]
        for dependency in dependencies:
            dependency.start()
            self.addCleanup(dependency.stop)
        hana_table_service.clear_overview_cache()
        self.addCleanup(hana_table_service.clear_overview_cache)

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
            search="",
        )
        self.assertEqual(data["tableName"], "SALES_ANALYTICS")
        self.assertGreaterEqual(data["totalRows"], 0)
        self.assertGreaterEqual(len(data["rows"]), 0)
        self.assertEqual(data["page"], 1)
        self.assertGreaterEqual(data["totalPages"], 0)
        self.assertEqual(data["totalRows"], 3)
        self.assertEqual(
            [row["ORDERID"] for row in data["rows"]], ["001", "002", "003"]
        )

    def test_search_and_descending_pagination_use_actual_rows(self):
        data = hana_table_service.get_table_data(
            "SALES_ANALYTICS",
            page=1,
            page_size=1,
            sort_col="ORDERID",
            sort_dir="DESC",
            search="east",
        )
        self.assertEqual(data["filteredRows"], 2)
        self.assertEqual(data["rows"][0]["ORDERID"], "003")
        self.assertEqual(data["totalPages"], 2)

    def test_disconnected_database_is_reported_offline(self):
        self.manager.get_connection.return_value = None
        self.assertFalse(hana_table_service.get_database_stats()["connected"])

    def test_members_cannot_access_admin_routes(self):
        with patch(
            "api.xsuaa.authenticated_profile",
            return_value={"user_id": "member", "role": "Member", "roles": ["Member"]},
        ):
            response = self.client.get("/api/hanaadmin", headers=self.auth_headers)
        self.assertEqual(response.status_code, 403)
        self.manager.get_connection.assert_not_called()

    def test_read_only_query_security(self):
        # Valid read-only query
        res = hana_table_service.execute_read_only_query(
            'SELECT COUNT(*) AS CNT FROM "SALES_ANALYTICS"'
        )
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
        res = self.client.get(
            "/api/hanaadmin/tables/SALES_ANALYTICS/data?pageSize=3",
            headers=self.auth_headers,
        )
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
            json={"mode": "row_range", "fromRow": 50, "toRow": 10},
        )
        self.assertEqual(res.status_code, 400)

        # Non-existent table must fail with 400
        res = self.client.post(
            "/api/hanaadmin/tables/NON_EXISTENT_XYZ/delete-range",
            headers=self.auth_headers,
            json={"mode": "row_range", "fromRow": 1, "toRow": 5},
        )
        self.assertEqual(res.status_code, 400)

    def test_delete_table_protected_system_table_prohibited(self):
        """Dropping protected system tables like DATASETS_METADATA or VECTOR_TABLE must be rejected with 400."""
        for tbl in [
            "DATASETS_METADATA",
            "VECTOR_TABLE",
            "PLATFORM_METADATA",
            "CHAT_MESSAGES",
        ]:
            res = self.client.delete(
                f"/api/hanaadmin/tables/{tbl}", headers=self.auth_headers
            )
            self.assertEqual(res.status_code, 400)
            self.assertIn("strictly prohibited", res.json().get("detail", ""))

    def test_delete_table_nonexistent_returns_404(self):
        """Dropping a non-existent table must return 404."""
        from unittest.mock import patch

        with patch.object(hana_table_service, "table_exists", return_value=False):
            res = self.client.delete(
                "/api/hanaadmin/tables/NON_EXISTENT_CUSTOM_TABLE",
                headers=self.auth_headers,
            )
            self.assertEqual(res.status_code, 404)

    def test_delete_table_success(self):
        """Dropping a valid user table must successfully call drop_table and return 200."""
        from unittest.mock import patch

        with (
            patch.object(hana_table_service, "table_exists", return_value=True),
            patch.object(
                hana_table_service,
                "drop_table",
                return_value={
                    "success": True,
                    "dropped": True,
                    "table_name": "DS_CUSTOM_V1",
                },
            ),
        ):
            res = self.client.delete(
                "/api/hanaadmin/tables/DS_CUSTOM_V1?cascade_dataset=false",
                headers=self.auth_headers,
            )
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data.get("success"))
            self.assertTrue(data.get("dropped"))
            self.assertEqual(data.get("tableName"), "DS_CUSTOM_V1")


if __name__ == "__main__":
    unittest.main()
