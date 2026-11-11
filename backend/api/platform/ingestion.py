"""Deterministic source discovery, conservative typing and recorded transformations."""
import csv
import hashlib
import io
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

import pandas as pd
from fastapi import HTTPException

from api.platform.contracts import DataProfile, FieldProfile, ParseOptions, TransformationPlan
from api.services.analytics_engine import json_value, missing


class IngestionService:
    @staticmethod
    def _normalize_label(value):
        if value is None:
            return ""
        return re.sub(r"\s+", " ", str(value)).strip()

    @staticmethod
    def _is_empty_cell(value):
        return value is None or (isinstance(value, str) and value.strip() == "")

    @staticmethod
    def _resolve_sheet_name(available, requested):
        if not requested:
            return available[0]
        if requested in available:
            return requested
        stripped = requested.strip()
        return next((name for name in available if name.strip() == stripped), None)

    @staticmethod
    def _build_merged_lookup(sheet):
        merged_lookup = {}
        merged_ranges = list(sheet.merged_cells.ranges)
        for rng in merged_ranges:
            top_left = sheet.cell(rng.min_row, rng.min_col).value
            if isinstance(top_left, int) and re.fullmatch(r"0{2,}", sheet.cell(rng.min_row, rng.min_col).number_format or ""):
                top_left = str(top_left).zfill(len(sheet.cell(rng.min_row, rng.min_col).number_format))
            for r in range(rng.min_row, rng.max_row + 1):
                for c in range(rng.min_col, rng.max_col + 1):
                    merged_lookup[(r, c)] = (top_left, rng)
        return merged_lookup, merged_ranges

    @classmethod
    def _unrolled_value(cls, raw_rows, merged_lookup, r_0b, c_0b, base_row=1, base_col=1):
        key = (base_row + r_0b, base_col + c_0b)
        if key in merged_lookup:
            return merged_lookup[key][0]
        if 0 <= r_0b < len(raw_rows) and 0 <= c_0b < len(raw_rows[r_0b]):
            return raw_rows[r_0b][c_0b]
        return None

    @classmethod
    def _is_header_candidate(cls, raw_rows, merged_lookup, idx, table_max_width, base_row=1, base_col=1):
        row = raw_rows[idx]
        non_empty = [c for c, v in enumerate(row) if not cls._is_empty_cell(v)]
        if not non_empty:
            return False, "empty"
        unrolled = [cls._unrolled_value(raw_rows, merged_lookup, idx, c, base_row, base_col) for c in range(len(row))]
        distinct = {cls._normalize_label(v) for v in unrolled if not cls._is_empty_cell(v)}
        if table_max_width >= 2 and (len(non_empty) <= 1 or len(distinct) <= 1):
            return False, "banner"
        non_str = sum(1 for c in non_empty if isinstance(row[c], (int, float, Decimal, datetime, date, bool)))
        str_cnt = len(non_empty) - non_str
        if str_cnt == 0 or non_str > str_cnt:
            return False, "data"
        return True, "valid"

    @classmethod
    def _is_subheader_row(cls, raw_rows, merged_lookup, merged_ranges, parent_0b, child_0b, base_row=1, base_col=1):
        if child_0b >= len(raw_rows):
            return False
        parent_1b = base_row + parent_0b
        child_1b = base_row + child_0b
        has_group_merges = any(
            rng.min_row <= parent_1b <= rng.max_row and rng.min_col < rng.max_col
            for rng in merged_ranges
        )
        has_vertical_merges = any(
            rng.min_row <= parent_1b < child_1b <= rng.max_row
            for rng in merged_ranges
        )
        if not has_group_merges and not has_vertical_merges:
            return False

        child_row = raw_rows[child_0b]
        child_non_empty = [c for c, v in enumerate(child_row) if not cls._is_empty_cell(v)]
        if not child_non_empty:
            return False
        if any(not isinstance(child_row[c], str) or re.fullmatch(r"[-+]?[\d,]+(?:\.\d+)?", child_row[c].strip()) for c in child_non_empty):
            return False
        return True

    @classmethod
    def _detect_header_row(cls, raw_rows, merged_lookup=None, merged_ranges=None, base_row=1, base_col=1):
        if not raw_rows:
            return 1
        merged_lookup = merged_lookup or {}
        merged_ranges = merged_ranges or []
        scan_limit = min(15, len(raw_rows))
        table_max_width = max((sum(1 for v in r if not cls._is_empty_cell(v)) for r in raw_rows[:30]), default=0)

        candidates = []
        for idx in range(scan_limit):
            ok, _ = cls._is_header_candidate(raw_rows, merged_lookup, idx, table_max_width, base_row, base_col)
            if not ok:
                continue
            unrolled = [cls._unrolled_value(raw_rows, merged_lookup, idx, c, base_row, base_col) for c in range(len(raw_rows[idx]))]
            unrolled_cnt = sum(1 for v in unrolled if not cls._is_empty_cell(v))
            has_sub = cls._is_subheader_row(raw_rows, merged_lookup, merged_ranges, idx, idx + 1, base_row, base_col)
            score = (unrolled_cnt * 10) + (100 if has_sub else 0) - (idx * 2)
            candidates.append((score, idx + 1))
        if candidates:
            candidates.sort(key=lambda item: (item[0], -item[1]), reverse=True)
            return candidates[0][1]
        return 1

    @classmethod
    def _trim_excel_body(cls, body_rows, merged_lookup=None, merged_ranges=None, body_start_1b=2, base_col=1, active_cols=None):
        if not body_rows:
            return body_rows
        merged_lookup = merged_lookup or {}
        # 1. Strip trailing completely empty rows
        while body_rows and all(cls._is_empty_cell(v) for v in body_rows[-1]):
            body_rows.pop()
        if not body_rows:
            return body_rows

        # 2. Strip detached footer/summary blocks separated by blank gap row(s)
        empty_indices = [i for i, row in enumerate(body_rows) if all(cls._is_empty_cell(v) for v in row)]
        if empty_indices:
            main_rows = body_rows[:empty_indices[0]]
            footer_start = empty_indices[0]
            while footer_start < len(body_rows) and all(cls._is_empty_cell(v) for v in body_rows[footer_start]):
                footer_start += 1
            footer_block = body_rows[footer_start:]
            if len(main_rows) >= 3 and footer_block:
                c0_main_ratio = sum(1 for r in main_rows if not cls._is_empty_cell(r[0])) / len(main_rows)
                c0_footer_ratio = sum(1 for r in footer_block if not cls._is_empty_cell(r[0])) / len(footer_block)
                footer_has_h_merge = False
                if active_cols and merged_ranges:
                    r_1b = body_start_1b + footer_start
                    footer_has_h_merge = any(rng.min_row <= r_1b <= rng.max_row and rng.min_col < rng.max_col for rng in merged_ranges)
                if (c0_main_ratio >= 0.8 and c0_footer_ratio < 0.3) or footer_has_h_merge:
                    body_rows = main_rows
                else:
                    body_rows = [r for r in body_rows if any(not cls._is_empty_cell(v) for v in r)]

        # 3. Strip bottom spreadsheet Totals/Summary row whose cells match column sums of rows above
        if len(body_rows) >= 3:
            last_row = body_rows[-1]
            sum_matches = 0
            for c_idx in range(len(last_row)):
                val = last_row[c_idx]
                if isinstance(val, (int, float, Decimal)) and not isinstance(val, bool) and val != 0:
                    col_sum = sum(
                        float(r[c_idx]) for r in body_rows[:-1]
                        if isinstance(r[c_idx], (int, float, Decimal)) and not isinstance(r[c_idx], bool)
                    )
                    if abs(col_sum - float(val)) < max(1e-3, abs(float(val)) * 1e-6):
                        sum_matches += 1
            lead_label = cls._normalize_label(last_row[0]).lower()
            is_total_lead = cls._is_empty_cell(last_row[0]) or lead_label in {"total", "grand total", "sub total", "subtotal", "sum"}
            if (sum_matches >= 2 and is_total_lead) or sum_matches >= 3:
                body_rows.pop()

        return body_rows

    def discover(self, content, filename):
        if filename.lower().endswith(".csv"):
            try:
                text = content.decode("utf-8-sig", errors="replace")
                rows = list(csv.reader(io.StringIO(text)))[:15]
            except Exception:
                rows = []
            return {"sheets": [], "format": "csv", "requires_selection": False,
                    "suggested_header_row": self._detect_header_row(rows) if rows else 1}
        if filename.lower().endswith(".xls"):
            book = pd.ExcelFile(io.BytesIO(content))
            sheets = []
            for name in book.sheet_names:
                raw = pd.read_excel(book, sheet_name=name, header=None, nrows=15, dtype=object)
                rows = [[None if missing(v) else v for v in row] for row in raw.values.tolist()]
                sheets.append({"name": name, "tables": [], "suggested_header_row": self._detect_header_row(rows)})
            return {"sheets": sheets, "format": "xls", "requires_selection": len(book.sheet_names) > 1,
                    "suggested_header_row": sheets[0]["suggested_header_row"] if sheets else 1}
        from openpyxl import load_workbook
        try:
            book = load_workbook(io.BytesIO(content), data_only=True)
            sheets = []
            for sheet in book.worksheets:
                merged_lookup, merged_ranges = self._build_merged_lookup(sheet)
                sample_rows = [[c.value for c in row] for row in sheet.iter_rows(max_row=min(sheet.max_row, 15))]
                suggested_hr = self._detect_header_row(sample_rows, merged_lookup, merged_ranges)
                sheets.append({
                    "name": sheet.title, "rows": sheet.max_row, "columns": sheet.max_column,
                    "tables": [{"name": table.name, "range": table.ref} for table in sheet.tables.values()],
                    "suggested_header_row": suggested_hr,
                    "preview": [[json_value(c) for c in row] for row in sample_rows[:8]],
                })
            return {"sheets": sheets, "format": "xlsx", "requires_selection": len(sheets) > 1,
                    "suggested_header_row": sheets[0]["suggested_header_row"] if sheets else 1}
        except Exception:
            raise HTTPException(422, "Workbook could not be inspected. Check the file format.") from None

    def _raw_frame(self, content, filename, options):
        is_excel = False
        merged_lookup, merged_ranges = {}, []
        base_row, base_col = 1, 1

        if filename.lower().endswith(".csv"):
            try:
                text = content.decode(options.encoding)
                rows = list(csv.reader(io.StringIO(text), delimiter=options.delimiter))
            except (UnicodeError, csv.Error, LookupError):
                raise HTTPException(422, "CSV parsing failed. Review encoding and delimiter.") from None
        elif filename.lower().endswith(".xls"):
            is_excel = True
            book = pd.ExcelFile(io.BytesIO(content))
            if len(book.sheet_names) > 1 and not options.sheet:
                raise HTTPException(409, {"state": "review_required", "message": "Select a workbook sheet.", "sheets": book.sheet_names})
            target_sheet = self._resolve_sheet_name(book.sheet_names, options.sheet)
            if target_sheet is None:
                raise HTTPException(422, "Selected worksheet does not exist.")
            raw = pd.read_excel(book, sheet_name=target_sheet, header=None, dtype=object)
            rows = [[None if missing(v) else v for v in row] for row in raw.values.tolist()]
        else:
            is_excel = True
            from openpyxl import load_workbook
            from openpyxl.utils.cell import range_boundaries
            book = load_workbook(io.BytesIO(content), data_only=True)
            if len(book.sheetnames) > 1 and not options.sheet:
                raise HTTPException(409, {"state": "review_required", "message": "Select a workbook sheet.", "sheets": book.sheetnames})
            target_sheet = self._resolve_sheet_name(book.sheetnames, options.sheet)
            if target_sheet is None:
                raise HTTPException(422, "Selected worksheet does not exist.")
            sheet = book[target_sheet]
            merged_lookup, merged_ranges = self._build_merged_lookup(sheet)
            bounds = {}
            if options.table:
                if options.table not in sheet.tables:
                    raise HTTPException(422, "Selected table does not exist in this sheet.")
                left, top, right, bottom = range_boundaries(sheet.tables[options.table].ref)
                bounds = dict(min_col=left, min_row=top, max_col=right, max_row=bottom)
                base_row, base_col = top, left
            elif len(sheet.tables) > 1:
                raise HTTPException(409, {"state": "review_required", "message": "Select a table from this worksheet.", "tables": list(sheet.tables)})
            rows = []
            for cells in sheet.iter_rows(**bounds):
                row = []
                for cell in cells:
                    value = cell.value
                    if isinstance(value, int) and re.fullmatch(r"0{2,}", cell.number_format or ""):
                        value = str(value).zfill(len(cell.number_format))
                    row.append(value)
                rows.append(row)

        if len(rows) < options.header_row:
            raise HTTPException(422, "Header row is outside the source table.")

        table_max_width = max((sum(1 for v in r if not self._is_empty_cell(v)) for r in rows[:30]), default=0)
        header_start_0b = options.header_row - 1
        if options.header_row == 1:
            row1_ok, _ = self._is_header_candidate(rows, merged_lookup, 0, table_max_width, base_row, base_col)
            if not row1_ok:
                detected = self._detect_header_row(rows, merged_lookup, merged_ranges, base_row, base_col)
                header_start_0b = detected - 1

        # Expand multi-level merged header hierarchies (e.g. parent category row + sub-column row)
        header_end_0b = header_start_0b + 1
        while header_end_0b < len(rows) and (header_end_0b - header_start_0b) < 4:
            if self._is_subheader_row(rows, merged_lookup, merged_ranges, header_end_0b - 1, header_end_0b, base_row, base_col):
                header_end_0b += 1
            else:
                break

        max_cols = max((len(r) for r in rows), default=0)
        if max_cols == 0:
            raise HTTPException(409, {"state": "review_required", "message": "Choose a header row with unique non-empty field names."})

        # Determine active columns: exclude completely empty columns and trailing unheaded Excel scratchpad columns
        if is_excel:
            populated_cols = []
            headed_cols = set()
            for c in range(max_cols):
                unrolled_hdr = [self._unrolled_value(rows, merged_lookup, r, c, base_row, base_col) for r in range(header_start_0b, header_end_0b)]
                col_has_header = any(not self._is_empty_cell(v) for v in unrolled_hdr)
                if col_has_header:
                    populated_cols.append(c)
                    headed_cols.add(c)
                elif any(c < len(rows[r]) and not self._is_empty_cell(rows[r][c]) for r in range(header_start_0b, len(rows))):
                    populated_cols.append(c)
            if headed_cols:
                max_headed = max(headed_cols)
                active_cols = [c for c in populated_cols if c <= max_headed]
            else:
                active_cols = populated_cols
        else:
            active_cols = list(range(len(rows[header_start_0b])))

        if not active_cols:
            raise HTTPException(409, {"state": "review_required", "message": "Choose a header row with unique non-empty field names."})

        raw_header_values = []
        headers = []
        for c in active_cols:
            levels = []
            raw_cell_for_type = None
            for r in range(header_start_0b, header_end_0b):
                val = self._unrolled_value(rows, merged_lookup, r, c, base_row, base_col)
                if not self._is_empty_cell(val):
                    raw_cell_for_type = val
                    label = self._normalize_label(val)
                    if label and (not levels or levels[-1] != label):
                        levels.append(label)
            raw_header_values.append(raw_cell_for_type)
            headers.append(" - ".join(levels))

        if any(not h or h == "__rowId" for h in headers):
            raise HTTPException(409, {"state": "review_required", "message": "Choose a header row with unique non-empty field names."})
        if any(not isinstance(v, str) for v in raw_header_values):
            raise HTTPException(409, {"state": "review_required", "message": "Header cells must contain field names. Select the header row."})
        if len(headers) >= 2 and len(set(headers)) == 1:
            raise HTTPException(409, {"state": "review_required", "message": "Choose a header row with unique non-empty field names."})

        # Disambiguate legitimate repeated side-by-side / sub-column header labels (e.g. duplicate labels)
        if len(set(headers)) != len(headers):
            if is_excel:
                seen_counts = {}
                unique_headers = []
                for h in headers:
                    if h in seen_counts:
                        seen_counts[h] += 1
                        unique_headers.append(f"{h}_{seen_counts[h]}")
                    else:
                        seen_counts[h] = 1
                        unique_headers.append(h)
                headers = unique_headers
            else:
                raise HTTPException(409, {"state": "review_required", "message": "Choose a header row with unique non-empty field names."})

        # Slice body rows aligned to active_cols
        if is_excel:
            body = [[rows[r][c] if c < len(rows[r]) else None for c in active_cols] for r in range(header_end_0b, len(rows))]
            body = self._trim_excel_body(body, merged_lookup, merged_ranges, base_row + header_end_0b, base_col, active_cols)
        else:
            # Empty records can be meaningful at the source grain; preserve them explicitly.
            body = [row if row else [None] * len(headers) for row in rows[header_end_0b:]]
            if any(len(row) != len(headers) for row in body):
                raise HTTPException(422, "Rows have inconsistent field counts. Review delimiter or table boundaries.")

        df = pd.DataFrame(body, columns=headers, dtype=object)
        df.attrs["body_start_row"] = header_end_0b + 1
        return df

    def _infer(self, name, values):
        if not values:
            return "string"
        if re.search(r"(^id$|id$|code$|number$|key$)", name, re.IGNORECASE) or any(re.fullmatch(r"[-+]?0\d+", str(v)) for v in values):
            return "identifier"
        if all(isinstance(v, bool) or str(v).lower() in {"true", "false"} for v in values):
            return "boolean"
        if all(isinstance(v, (datetime, date)) for v in values):
            return "date"
        if all(re.fullmatch(r"[-+]?\d+", str(v)) for v in values):
            return "integer"
        if all(re.fullmatch(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[Ee][-+]?\d+)?", str(v)) for v in values):
            return "decimal"
        return "string"

    def _cast(self, value, kind, name, options):
        if value is None or value == "":
            return None
        if kind in ("identifier", "string"):
            return str(value)
        if kind in ("integer", "decimal"):
            text = str(value).strip()
            if name in options.currencies:
                currency = options.currencies[name]
                symbol = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹"}.get(currency, currency)
                text = text.replace(currency, "").replace(symbol, "").strip()
            if options.units.get(name) == "%":
                text = text.removesuffix("%").strip()
            if options.thousands_separator:
                if options.thousands_separator == options.decimal_separator:
                    raise ValueError("Decimal and thousands separators must differ")
                text = text.replace(options.thousands_separator, "")
            text = text.replace(options.decimal_separator, ".")
            number = Decimal(text)
            if not number.is_finite() or (kind == "integer" and number != number.to_integral_value()):
                raise ValueError("Expected a finite number of the selected type")
            return int(number) if kind == "integer" else number
        if kind == "boolean":
            text = str(value).lower()
            if text not in ("true", "false"):
                raise ValueError("Expected true or false")
            return text == "true"
        if kind == "date":
            if not isinstance(value, (datetime, date)) and not options.date_format:
                raise ValueError("Choose an explicit date format for textual dates")
            parsed = pd.Timestamp(value) if isinstance(value, (datetime, date)) else pd.Timestamp(datetime.strptime(str(value), options.date_format))
            if options.timezone and parsed.tzinfo is None:
                parsed = parsed.tz_localize(options.timezone, ambiguous="raise", nonexistent="raise")
            return parsed
        raise ValueError("Unsupported field type")

    def prepare(self, content, filename, plan=None):
        plan = plan or TransformationPlan()
        options = plan.parsing
        try:
            df = self._raw_frame(content, filename, options)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(422, "Source parsing failed. Review file type, sheet and table selection.") from None
        duplicate_count = int(df.duplicated().sum())
        if duplicate_count and options.duplicate_policy == "reject":
            raise HTTPException(409, {"state": "review_required", "message": "Duplicate rows found. Select an explicit policy.", "duplicate_count": duplicate_count})
        if options.duplicate_policy == "drop":
            df = df.drop_duplicates().reset_index(drop=True)
        fields, rejected, columns = [], [], []
        for name in df.columns:
            raw = df[name].tolist()
            values = [v for v in raw if v is not None and v != ""]
            kind = options.column_types.get(name) or self._infer(name, values)
            parsed = []
            for index, value in enumerate(raw):
                try:
                    parsed.append(self._cast(value, kind, name, options))
                except (ValueError, TypeError, InvalidOperation, OverflowError):
                    rejected.append({"row": index + df.attrs.get("body_start_row", options.header_row + 1), "field": name, "reason": f"Value does not match {kind}; review parsing settings."})
                    parsed.append(None)
            df[name] = pd.Series(parsed, dtype=object)
            if kind == "integer" and all(v is not None for v in parsed):
                try:
                    df[name] = df[name].astype("int64")
                except OverflowError:
                    kind = "decimal"
                    df[name] = pd.Series([Decimal(str(v)) for v in parsed], dtype=object)
            if kind == "date":
                df[name] = pd.to_datetime(df[name])
            warnings = []
            if kind == "string" and any(re.search(r"\d[/,.%$€£]\d|[/,%$€£]", str(v)) for v in values):
                warnings.append("Potential formatted number or date; kept as text pending review.")
            fields.append(FieldProfile(name=name, type=kind, missing_count=sum(v is None for v in parsed),
                                       distinct_count=len({str(v) for v in parsed if v is not None}),
                                       samples=[json_value(v) for v in parsed[:5]], warnings=warnings))
            columns.append(dict(name=name, type="number" if kind == "integer" else kind, required=False,
                                unit=options.units.get(name), currency=options.currencies.get(name)))
        if rejected:
            raise HTTPException(422, {"state": "review_required", "message": "Some rows could not be converted. No dataset was published.", "rejected_rows": rejected})
        for step in plan.operations:
            if step.field not in df:
                raise HTTPException(422, "Transformation references an unknown field.")
            if step.operation == "trim":
                df[step.field] = df[step.field].map(lambda v: v.strip() if isinstance(v, str) else v)
            elif step.operation == "rename":
                if not isinstance(step.value, str) or not step.value.strip() or step.value in df or step.value == "__rowId":
                    raise HTTPException(422, "A renamed field must have a unique non-empty name.")
                df = df.rename(columns={step.field: step.value})
                for column in columns:
                    if column["name"] == step.field:
                        column["name"] = step.value
                for field in fields:
                    if field.name == step.field:
                        field.name = step.value
            elif step.operation == "fill_missing":
                kind = next(f.type for f in fields if f.name == step.field)
                value = self._cast(step.value, kind, step.field, options)
                df[step.field] = df[step.field].map(lambda v: value if missing(v) else v)
        profile = DataProfile(row_count=len(df), duplicate_count=duplicate_count, fields=fields,
                              warnings=["Repeated rows were preserved; matching values do not establish duplicate transactions."] if duplicate_count and options.duplicate_policy == "keep" else [],
                              source_hash=hashlib.sha256(content).hexdigest())
        df.attrs.update(columns=columns, data_profile=profile.model_dump(mode="json"), transformation_plan=plan.model_dump(mode="json"))
        return df, profile


ingestion_service = IngestionService()
