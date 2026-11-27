"""Large logical row counts must not cause whole-dataset downloads."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from api.models.execution_context import (
    DatasetSelection,
    ExecutionContext,
    current_identity,
    current_selection,
)
from api.services.dataset_service import DatasetService
from api.services.excel_dataset_service import ExcelDatasetService


class LargeDatasetReadsTests(TestCase):
    def test_shared_page_schema_cache_copies_metadata_and_invalidates_after_ddl(self):
        from api.database.hana_table_service import HANATableService

        service = HANATableService()
        cursor = MagicMock()
        cursor.fetchone.return_value = (1,)
        with patch.object(
            service,
            "_fetch_columns_on_cursor",
            return_value=[{"name": "amount", "type": "DOUBLE"}],
        ) as reflect:
            first = service._page_columns(cursor, "ANY_TABLE", "SCHEMA")
            first[0]["name"] = "changed-by-caller"
            self.assertEqual(
                service._page_columns(cursor, "ANY_TABLE", "SCHEMA")[0]["name"],
                "amount",
            )
            reflect.assert_called_once()
            service.clear_overview_cache()
            service._page_columns(cursor, "ANY_TABLE", "SCHEMA")
            self.assertEqual(reflect.call_count, 2)

    def setUp(self):
        self.entry = {
            "id": "large",
            "name": "Large",
            "folder": "large",
            "updatedAt": "2026-11-27",
            "workspaceId": "w",
            "ownerId": "owner",
            "readers": ["*"],
            "writers": [],
            "tableName": "ANY_REGISTERED_TABLE",
            "currentVersion": 2,
            "versions": [
                {"version": 1, "snapshotKey": "old"},
                {
                    "version": 2,
                    "snapshotKey": "current",
                    "rowCount": 10_000_000,
                    "columns": [
                        {"name": "record_id", "type": "number"},
                        {"name": "amount", "type": "number"},
                    ],
                    "embeddingStatus": "Ready",
                },
            ],
        }
        self.service = DatasetService(repository=SimpleNamespace(store=None))
        self.catalog = patch.object(
            self.service,
            "_catalog",
            return_value={
                "datasets": {"large": self.entry},
                "activeDatasetId": "large",
            },
        )
        self.catalog.start()
        self.addCleanup(self.catalog.stop)

    def test_one_hundred_concurrent_users_fetch_only_pages_from_ten_million_row_metadata(
        self,
    ):
        start = Barrier(100)

        def page(table, **options):
            self.assertEqual(table, "ANY_REGISTERED_TABLE")
            self.assertEqual(options["page_size"], 50)
            offset = (options["page"] - 1) * 50
            return {
                "rows": [{"RECORD_ID": offset + i, "AMOUNT": 1} for i in range(50)],
                "page": options["page"],
                "pageSize": 50,
                "totalRows": 10_000_000,
                "filteredRows": 10_000_000,
                "totalPages": 200_000,
                "columns": [],
            }

        def read(user):
            identity = current_identity.set(
                {"workspace_id": "w", "user_id": f"user-{user}"}
            )
            try:
                start.wait(timeout=10)
                return self.service.preview(
                    "large", page=user + 1, page_size=50, sort_field="record_id"
                )
            finally:
                current_identity.reset(identity)

        with (
            patch.object(
                self.service,
                "_snapshot",
                side_effect=AssertionError("No snapshot download allowed"),
            ),
            patch(
                "api.database.hana_table_service.hana_table_service.get_table_data",
                side_effect=page,
            ) as query,
            ThreadPoolExecutor(max_workers=100) as pool,
        ):
            results = list(pool.map(read, range(100)))
        self.assertEqual(query.call_count, 100)
        self.assertTrue(all(len(result["rows"]) == 50 for result in results))
        self.assertTrue(
            all(
                result["totalRows"] == 10_000_000 and result["readOnly"]
                for result in results
            )
        )
        self.assertEqual(results[-1]["rows"][0]["record_id"], 4950)

    def test_historical_version_never_reads_the_current_mutable_table(self):
        with (
            patch.object(
                self.service, "data", return_value={"historical": True}
            ) as historical,
            patch(
                "api.database.hana_table_service.hana_table_service.get_table_data"
            ) as live,
        ):
            self.assertEqual(
                self.service.preview("large", version=1), {"historical": True}
            )
        live.assert_not_called()
        historical.assert_called_once_with("large", 1, 10, None, "asc", "", 1)

    def test_native_preview_checks_account_permissions_and_sort_fields(self):
        identity = current_identity.set(
            {"workspace_id": "other", "user_id": "intruder"}
        )
        try:
            with patch(
                "api.database.hana_table_service.hana_table_service.get_table_data"
            ) as query:
                with self.assertRaises(HTTPException):
                    self.service.preview("large")
                query.assert_not_called()
        finally:
            current_identity.reset(identity)
        with patch(
            "api.database.hana_table_service.hana_table_service.get_table_data"
        ) as query:
            with self.assertRaises(HTTPException) as error:
                self.service.preview("large", sort_field='amount"; DROP TABLE X;--')
            self.assertEqual(error.exception.status_code, 400)
            query.assert_not_called()

    def test_large_sql_context_needs_metadata_only_and_preserves_version_checks(self):
        with patch.object(
            self.service,
            "_snapshot",
            side_effect=AssertionError("No row download allowed"),
        ):
            snapshot = self.service.query_snapshot(self.entry, 2)
            self.assertTrue(snapshot["lazy_snapshot"])
            self.assertEqual(snapshot["rowCount"], 10_000_000)
            self.assertEqual(snapshot["rows"], [])
            with self.assertRaises(HTTPException):
                self.service.query_snapshot(self.entry, 99)

    def test_large_unsupported_calculation_cannot_fall_back_to_downloading_all_rows(
        self,
    ):
        selection = DatasetSelection(
            ExecutionContext(
                workspace_id="w",
                user_id="owner",
                dataset_id="large",
                version=2,
                semantic_revision=1,
            ),
            self.entry,
            self.service.query_snapshot(self.entry, 2),
        )
        token = current_selection.set(selection)
        try:
            with patch(
                "api.services.dataset_service.dataset_service._snapshot",
                side_effect=AssertionError("No unbounded fallback allowed"),
            ):
                with self.assertRaisesRegex(RuntimeError, "database execution"):
                    ExcelDatasetService().get_df()
        finally:
            current_selection.reset(token)
