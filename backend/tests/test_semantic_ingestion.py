"""Multi-domain fixtures prove reviewed metadata and exact source preservation."""
import io
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from openpyxl import Workbook
from api.models.execution_context import current_identity
from api.platform.contracts import ParseOptions, TransformationPlan
from api.platform.ingestion import IngestionService
from api.platform.semantic import SemanticRegistry
from api.platform.store import MetadataStore
from api.services.analytics_engine import AnalyticsEngine
from api.services.dataset_service import DatasetService


class GenericIngestionTests(unittest.TestCase):
    def setUp(self):
        self.service = IngestionService()

    def test_decimal_identifier_null_and_repeated_transaction_preservation(self):
        content = b"EmployeeID,Salary,Department\n00123,1234.567890123456789,IT\n00123,1234.567890123456789,IT\n00456,,HR\n"
        df, profile = self.service.prepare(content, "HR.csv")
        self.assertEqual(df["EmployeeID"].tolist(), ["00123", "00123", "00456"])
        self.assertEqual(df["Salary"].iloc[0], Decimal("1234.567890123456789"))
        self.assertEqual(profile.duplicate_count, 1)
        self.assertEqual(len(df), 3)
        rows = DatasetService._rows(df)
        frame = DatasetService._frame(rows, DatasetService._columns(df))
        self.assertEqual(frame["Salary"].iloc[0], df["Salary"].iloc[0])
        self.assertIsNone(rows[2]["Salary"])

    def test_multisheet_discovery_header_selection_and_excel_number_format(self):
        book = Workbook()
        sheet = book.active
        sheet.title = "Sales"
        sheet.append(["Report", None])
        sheet.append(["CustomerCode", "Revenue"])
        sheet.append([123, 10.25])
        sheet["A3"].number_format = "00000"
        book.create_sheet("Manufacturing").append(["Machine", "Output"])
        data = io.BytesIO(); book.save(data)
        raw = data.getvalue()
        self.assertEqual(len(self.service.discover(raw, "data.xlsx")["sheets"]), 2)
        with self.assertRaises(HTTPException) as exc:
            self.service.prepare(raw, "data.xlsx")
        self.assertEqual(exc.exception.status_code, 409)
        frame, _ = self.service.prepare(raw, "data.xlsx", TransformationPlan(parsing=ParseOptions(sheet="Sales", header_row=2)))
        self.assertEqual(frame["CustomerCode"].iloc[0], "00123")

    def test_locale_and_explicit_duplicate_policy(self):
        options = ParseOptions(delimiter=";", decimal_separator=",", thousands_separator=".",
                               column_types={"Amount": "decimal"}, duplicate_policy="drop")
        frame, profile = self.service.prepare(b"Code;Amount\n001;1.234,56\n001;1.234,56\n", "Sales.csv", TransformationPlan(parsing=options))
        self.assertEqual(len(frame), 1)
        self.assertEqual(frame["Amount"].iloc[0], Decimal("1234.56"))

    def test_invalid_explicit_type_is_review_state_with_rejected_rows(self):
        plan = TransformationPlan(parsing=ParseOptions(column_types={"Output": "integer"}))
        with self.assertRaises(HTTPException) as exc:
            self.service.prepare(b"Machine,Output\nA,unknown\n", "Factory.csv", plan)
        self.assertEqual(exc.exception.detail["state"], "review_required")
        self.assertEqual(exc.exception.detail["rejected_rows"][0]["row"], 2)


class SemanticApprovalTests(unittest.TestCase):
    def test_empty_source_records_and_rename_then_fill_are_preserved(self):
        plan = TransformationPlan.model_validate({"operations": [{"operation": "rename", "field": "Amount", "value": "Cost"}, {"operation": "fill_missing", "field": "Cost", "value": "0.00"}]})
        frame, _ = IngestionService().prepare(b"ID,Amount\n001,0.10\n,\n", "source.csv", plan)
        self.assertEqual(len(frame), 2)
        self.assertEqual(str(frame.iloc[1]["Cost"]), "0.00")

    def test_definition_reuse_is_explicit_and_schema_changes_require_review(self):
        _, snapshot = self.snapshot(b"EmployeeID,Salary\n001,100\n")
        model = self.registry.propose(self.entry, 1, snapshot)
        proposed = model.model_dump(mode="json")
        proposed["grain"] = "One employee"
        model = self.registry.propose(self.entry, 1, snapshot, proposed)
        self.registry.review(self.entry, 1, model.revision, "approved")
        result = self.registry.reuse(self.entry, 1, 2, model.revision, snapshot, snapshot)
        self.assertEqual(result["model"]["status"], "approved")
        self.assertEqual(result["model"]["data_version"], 2)
        _, changed = self.snapshot(b"EmployeeID,Salary,Department\n001,100,IT\n")
        with self.assertRaises(HTTPException):
            self.registry.reuse(self.entry, 1, 3, model.revision, snapshot, changed)
        self.assertEqual(self.registry.list(self.entry, 3), [])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.registry = SemanticRegistry(MetadataStore(Path(self.temp.name) / "metadata.db", "sqlite"))
        self.entry = {"id": "dataset", "workspaceId": "w", "ownerId": "owner"}
        self.token = current_identity.set({"workspace_id": "w", "user_id": "owner", "roles": ["Member"]})
        self.addCleanup(current_identity.reset, self.token)

    def snapshot(self, content):
        frame, _ = IngestionService().prepare(content, "fixture.csv")
        return frame, {"columns": DatasetService._columns(frame), "rows": DatasetService._rows(frame)}

    def test_sales_hr_manufacturing_use_their_own_fields(self):
        fixtures = [(b"OrderID,Revenue,Region\n001,10.25,East\n", "Revenue"),
                    (b"EmployeeID,Salary,Department\n001,100.50,IT\n", "Salary"),
                    (b"MachineID,Output,Plant\n001,15,North\n", "Output")]
        for index, (content, metric) in enumerate(fixtures, 1):
            frame, snapshot = self.snapshot(content)
            proposed = self.registry.propose(self.entry, index, snapshot)
            field = next(f for f in proposed.fields if f.name == metric)
            self.assertIn("SUM", field.aggregations)
            self.assertFalse(any(f.name == "NetRevenueUSD" for f in proposed.fields))
            with self.assertRaises(HTTPException):
                self.registry.get(self.entry, index, proposed.revision, approved=True)
            revised = proposed.model_dump(mode="json")
            revised["grain"] = "One source transaction"
            for value in revised["fields"]:
                if value["name"] == metric:
                    value["default_aggregation"] = "SUM"
            model = self.registry.propose(self.entry, index, snapshot, revised)
            approved = self.registry.review(self.entry, index, model.revision, "approved")
            self.assertEqual(approved.reviewer, "owner")
            plan = self.registry.propose_analytics(self.entry, index, approved.revision, snapshot)
            self.assertTrue(all(item.status == "proposed" for item in plan.items))
            self.assertFalse(any("efficiency" in item.title.lower() for item in plan.items))

    def test_approval_requires_grain_and_reviewed_revision_is_immutable(self):
        _, snapshot = self.snapshot(b"EmployeeID,Salary\n001,100\n")
        model = self.registry.propose(self.entry, 1, snapshot)
        with self.assertRaises(HTTPException):
            self.registry.review(self.entry, 1, model.revision, "approved")
        self.registry.review(self.entry, 1, model.revision, "rejected")
        with self.assertRaises(HTTPException):
            self.registry.review(self.entry, 1, model.revision, "approved")

    def test_metadata_compare_and_swap_prevents_overwriting_another_review(self):
        store = self.registry.store
        store.put("test", "one", {"value": 1})
        store.put("test", "one", {"value": 2}, expected_revision=1)
        with self.assertRaises(HTTPException) as exc:
            store.put("test", "one", {"value": 3}, expected_revision=1)
        self.assertEqual(exc.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
