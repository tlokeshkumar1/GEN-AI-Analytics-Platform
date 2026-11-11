"""Tests for complex Excel reports: title banners, merged multi-level headers, side notes, and footers."""
import io
import sys
import unittest
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from openpyxl import Workbook
from api.platform.contracts import ParseOptions, TransformationPlan
from api.platform.ingestion import IngestionService
from api.services.upload_service import UploadService


class ComplexExcelIngestionTests(unittest.TestCase):
    def setUp(self):
        self.service = IngestionService()

    def _build_complex_workbook(self) -> bytes:
        wb = Workbook()
        ws = wb.active
        ws.title = "APR-26 "

        # Row 1: Merged title banner
        ws.cell(1, 1, "Monthly Plant Operations Summary")
        ws.merge_cells("A1:G1")

        # Row 2 & 3: Mixed vertical and horizontal merged headers
        ws.cell(2, 1, "Date")
        ws.merge_cells("A2:A3")

        ws.cell(2, 2, "Opening Balance\n(Local + Import)")
        ws.merge_cells("B2:C2")
        ws.cell(3, 2, "Domestic")
        ws.cell(3, 3, "Import")

        ws.cell(2, 4, "Receipts")
        ws.merge_cells("D2:E2")
        ws.cell(3, 4, "Domestic")
        ws.cell(3, 5, "Import")

        ws.cell(2, 6, "Opening WIP")
        ws.merge_cells("F2:F3")

        ws.cell(2, 7, "Total Stock")
        ws.merge_cells("G2:G3")

        # Rows 4-6: Daily tabular records (+ blank columns 8-9 gap, + unheaded side notes col 10)
        records = [
            (datetime(2026, 4, 1), 100.5, 10.0, 20.0, 5.0, 40.0, 175.5),
            (datetime(2026, 4, 2), 110.5, 12.0, 15.0, 0.0, 45.0, 182.5),
            (datetime(2026, 4, 3), 120.5, 14.0, 25.0, 10.0, 50.0, 219.5),
        ]
        for idx, rec in enumerate(records, start=4):
            for c_idx, val in enumerate(rec, start=1):
                ws.cell(idx, c_idx, val)
            ws.cell(idx, 10, 999.99)  # Unheaded scratch column outside empty col 8-9 gap

        # Row 7: Totals row matching column sums with missing lead key
        ws.cell(7, 2, 331.5)
        ws.cell(7, 3, 36.0)
        ws.cell(7, 4, 60.0)
        ws.cell(7, 5, 15.0)

        # Rows 8-9: Empty gap, Row 10-12: Detached footer summary box
        ws.cell(10, 2, "Report finalized on 03.04.2026")
        ws.merge_cells("B10:E10")
        ws.cell(11, 2, "Opening")
        ws.cell(11, 3, "Closing")
        ws.cell(12, 2, 110.5)
        ws.cell(12, 3, 219.5)

        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def test_discover_suggests_header_row_past_title_banner(self):
        raw = self._build_complex_workbook()
        info = self.service.discover(raw, "plant_report.xlsx")
        self.assertEqual(info["suggested_header_row"], 2)
        self.assertEqual(info["sheets"][0]["suggested_header_row"], 2)
        self.assertFalse(info["requires_selection"])

    def test_merged_hierarchical_headers_footers_and_scratch_columns(self):
        raw = self._build_complex_workbook()

        # Works even when default header_row=1 or explicit header_row=2 or trimmed sheet name
        for hr, sheet_opt in [(1, None), (2, "APR-26")]:
            df, profile = self.service.prepare(
                raw,
                "plant_report.xlsx",
                TransformationPlan(parsing=ParseOptions(sheet=sheet_opt, header_row=hr)),
            )
            self.assertEqual(len(df), 3)
            self.assertEqual(
                list(df.columns),
                [
                    "Date",
                    "Opening Balance (Local + Import) - Domestic",
                    "Opening Balance (Local + Import) - Import",
                    "Receipts - Domestic",
                    "Receipts - Import",
                    "Opening WIP",
                    "Total Stock",
                ],
            )
            types = {f.name: f.type for f in profile.fields}
            self.assertEqual(types["Date"], "date")
            self.assertEqual(types["Opening Balance (Local + Import) - Domestic"], "decimal")
            self.assertEqual(types["Total Stock"], "decimal")
            self.assertEqual(df["Receipts - Domestic"].iloc[0], Decimal("20.0"))

    def test_explicit_subheader_row_selection_unrolls_merges_and_deduplicates(self):
        raw = self._build_complex_workbook()
        df, _ = self.service.prepare(
            raw,
            "plant_report.xlsx",
            TransformationPlan(parsing=ParseOptions(header_row=3)),
        )
        self.assertEqual(len(df), 3)
        self.assertEqual(
            list(df.columns),
            ["Date", "Domestic", "Import", "Domestic_2", "Import_2", "Opening WIP", "Total Stock"],
        )

    def test_side_by_side_tables_with_duplicate_headers_and_empty_spacer_columns(self):
        wb = Workbook()
        ws = wb.active
        ws.title = "SideBySide"
        ws.append(["Name", "Status", None, None, "Name", "Status"])
        ws.append(["Module A", "Active", None, None, "Module B", "Inactive"])
        ws.append(["Module C", "Active", None, None, "Module D", "Pending"])
        buf = io.BytesIO()
        wb.save(buf)
        raw = buf.getvalue()

        info = self.service.discover(raw, "side_by_side.xlsx")
        self.assertEqual(info["suggested_header_row"], 1)

        df, _ = self.service.prepare(raw, "side_by_side.xlsx")
        self.assertEqual(list(df.columns), ["Name", "Status", "Name_2", "Status_2"])
        self.assertEqual(len(df), 2)

    def test_invalid_numeric_header_row_still_triggers_review_required(self):
        raw = self._build_complex_workbook()
        with self.assertRaises(HTTPException) as exc:
            self.service.prepare(
                raw,
                "plant_report.xlsx",
                TransformationPlan(parsing=ParseOptions(header_row=4)),
            )
        self.assertEqual(exc.exception.status_code, 409)

    def test_upload_service_commit_does_not_reapply_raw_sheet_plan_to_clean_export(self):
        raw = self._build_complex_workbook()
        plan = TransformationPlan(parsing=ParseOptions(sheet="APR-26", header_row=2))
        captured = {}

        def fake_upload(content, filename, async_index=None, transformation_plan=None, **kwargs):
            captured["transformation_plan"] = transformation_plan
            df_check, _ = IngestionService().prepare(content, filename, transformation_plan)
            captured["rows"] = len(df_check)
            return {
                "dataset": {"id": "ds-test", "folder": "plant_report", "currentFilename": filename, "embeddingStatus": "Ready"},
                "version": 1,
                "embeddings_generated": 0,
            }

        with (
            patch("api.services.upload_service.dataset_service.upload", side_effect=fake_upload),
            patch("api.services.upload_service.dataset_service._catalog", side_effect=RuntimeError("skip")),
            patch("api.services.upload_service.hana_table_service.persist_dataframe", return_value={"success": True, "table_name": "PLANT_REPORT"}),
        ):
            res = UploadService().process_file(raw, "plant_report.xlsx", False, plan, "PLANT_REPORT", "create")

        self.assertEqual(res["status"], "success")
        self.assertEqual(res["rows_processed"], 3)
        self.assertIsNone(captured["transformation_plan"])
        self.assertEqual(captured["rows"], 3)


if __name__ == "__main__":
    unittest.main()

