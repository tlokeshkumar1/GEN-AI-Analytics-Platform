"""
Agent 1: Zero-Hardcode Preprocessing Agent
===========================================
Performs automated data sanitization, deduplication, null-value remediation,
type coercion, and currency/number normalization on any tabular DataFrame
without hardcoded column names or assumptions.
"""

import re
import copy
import os
from decimal import Decimal, localcontext
from typing import Dict, Any, Tuple
import pandas as pd

from api.utils.logger import get_logger

logger = get_logger("agent.preprocessing")


class PreprocessingAgent:
    """
    Autonomous data cleaning agent that removes duplicate and null values,
    normalizes headers, and coerces types conservatively.
    """

    def clean(
        self, df: pd.DataFrame, parsing_options=None
    ) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        """
        Run the complete cleaning pipeline.
        Returns:
            Tuple of (cleaned_dataframe, audit_metrics_dict)
        """
        if df is None or df.empty:
            return pd.DataFrame(), {
                "rows_before": 0,
                "rows_after": 0,
                "duplicates_removed": 0,
                "null_values_cleaned": 0,
                "columns_cleaned": 0,
                "message": "Empty or null DataFrame provided.",
            }

        df = df.copy(deep=True)
        rows_before = len(df)
        cols_before = len(df.columns)
        nulls_cleaned_count = 0

        # Step 1: Sanitize Column Headers
        df = self._sanitize_headers(df)

        # Step 2: Remove completely empty rows and columns
        df = df.dropna(how="all")
        df = df.dropna(axis=1, how="all")
        if df.attrs.get("columns"):
            df.attrs["columns"] = [
                c for c in df.attrs["columns"] if c["name"] in df.columns
            ]

        # Step 3: Remove duplicate rows
        duplicates_before = len(df)
        if parsing_options is None or parsing_options.duplicate_policy == "drop":
            df = df.drop_duplicates()
        exact_duplicates_removed = duplicates_before - len(df)

        # Step 4: Detect and Clean String-Encoded Numbers / Currencies
        df, num_cleaned = self._normalize_formatted_numbers(df)
        nulls_cleaned_count += num_cleaned

        # Step 5: Null / Missing Value Handling per Column Type
        df, col_null_fixes = self._remediate_nulls(df)
        nulls_cleaned_count += sum(col_null_fixes.values())

        # Step 6: Coerce Potential Date Columns (preserve genuine nulls without ffill/bfill fabrication)
        df = self._normalize_dates(df)

        total_duplicates_removed = exact_duplicates_removed

        rows_after = len(df)

        audit = {
            "rows_before": rows_before,
            "rows_after": rows_after,
            "columns_before": cols_before,
            "columns_after": len(df.columns),
            "duplicates_removed": total_duplicates_removed,
            "null_values_cleaned": nulls_cleaned_count,
            "null_fixes_by_column": col_null_fixes,
            "status": "success",
            "message": f"Sanitized {rows_after} rows. Removed {total_duplicates_removed} duplicate rows and sanitized {nulls_cleaned_count} cells.",
        }

        logger.info(f"[PreprocessingAgent] Finished: {audit['message']}")
        return df, audit

    def _sanitize_headers(self, df: pd.DataFrame) -> pd.DataFrame:
        """Sanitize column headers to valid, unique identifiers."""
        new_cols = []
        seen = {}
        used = set()
        for col in df.columns:
            name = str(col).strip()
            # Replace spaces and punctuation with underscores
            clean_name = re.sub(r"[\s\-\/\.]+", "_", name)
            clean_name = re.sub(r"[^\w_]", "", clean_name)
            clean_name = re.sub(r"_+", "_", clean_name).strip("_")
            if not clean_name:
                clean_name = "Column"

            # Handle duplicate column names
            if clean_name in seen:
                seen[clean_name] += 1
                unique_name = f"{clean_name}_{seen[clean_name]}"
            else:
                seen[clean_name] = 0
                unique_name = clean_name
            while unique_name in used:
                seen[clean_name] += 1
                unique_name = f"{clean_name}_{seen[clean_name]}"
            used.add(unique_name)
            new_cols.append(unique_name)

        renamed = dict(zip(df.columns, new_cols))
        df.attrs["source_column_names"] = {new: old for old, new in renamed.items()}
        df.columns = new_cols
        if df.attrs.get("columns"):
            columns = copy.deepcopy(df.attrs["columns"])
            for column in columns:
                column["name"] = renamed.get(column["name"], column["name"])
            df.attrs["columns"] = columns
        return df

    def _normalize_formatted_numbers(
        self, df: pd.DataFrame
    ) -> Tuple[pd.DataFrame, int]:
        """Convert string numbers formatted with currency symbols, commas, or percent signs to numeric."""
        cleaned_cells = 0
        declared = {c["name"]: c["type"] for c in df.attrs.get("columns", [])}
        explicit = (
            df.attrs.get("transformation_plan", {})
            .get("parsing", {})
            .get("column_types", {})
        )
        # Commas are thousands separators only when their grouping is unambiguous.
        pattern = re.compile(
            r"^[\$\u20ac\u00a3\u00a5\u20b9]?\s*[-+]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?%?$"
        )
        for col in df.columns:
            source_name = df.attrs.get("source_column_names", {}).get(col, col)
            if declared.get(col) in (
                "identifier",
                "date",
                "boolean",
                "decimal",
            ) or explicit.get(source_name) in ("string", "identifier"):
                continue
            if not (df[col].dtype == object or pd.api.types.is_string_dtype(df[col])):
                continue
            values = df[col].dropna()
            if values.empty or not values.map(lambda v: isinstance(v, str)).all():
                continue
            texts = values.astype(str).str.strip()
            if texts.str.match(r"^[+-]?0\d+").any():
                continue  # Leading zeros carry identifier meaning.
            if not texts.map(lambda v: bool(pattern.fullmatch(v))).all():
                continue  # Never replace unparseable source values with invented nulls.

            def parse(value):
                if pd.isna(value):
                    return None
                text = str(value).strip()
                percent = text.endswith("%")
                text = re.sub(r"[\$\u20ac\u00a3\u00a5\u20b9,%]", "", text).strip()
                number = Decimal(text)
                with localcontext() as context:
                    context.prec = max(38, len(number.as_tuple().digits))
                    return number / Decimal(100) if percent else number

            df[col] = pd.Series(
                [parse(v) for v in df[col]], index=df.index, dtype=object
            )
            for column in df.attrs.get("columns", []):
                if column["name"] == col:
                    column["type"] = "decimal"
            cleaned_cells += len(values)
        return df, cleaned_cells

    def _remediate_nulls(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, Dict[str, int]]:
        """Remediate string/categorical nulls and empty whitespace while preserving true numeric distributions."""
        null_counts = {}

        declared = {c["name"]: c["type"] for c in df.attrs.get("columns", [])}
        for col in df.columns:
            if declared.get(col) in (
                "identifier",
                "decimal",
                "integer",
                "number",
                "date",
                "boolean",
            ):
                continue
            if (
                os.getenv("PLATFORM_CATEGORICAL_NULL_POLICY", "label").lower()
                == "preserve"
            ):
                continue
            null_count = int(df[col].isna().sum())

            # If column is numeric: preserve genuine NULLs/NaNs so SQL AVG/SUM/MIN/MAX calculations
            # remain mathematically exact and are not distorted by blind zero/median imputation.
            if pd.api.types.is_numeric_dtype(df[col]):
                if null_count > 0:
                    null_counts[col] = null_count

            # If column is categorical / string: normalize empty whitespace and nulls to "Unassigned"
            elif pd.api.types.is_string_dtype(df[col]) or df[col].dtype == object:
                empty_mask = df[col].isna() | df[col].astype(str).str.strip().isin(
                    ["", "nan", "NaN", "None", "null"]
                )
                cleaned_in_col = int(empty_mask.sum())
                if cleaned_in_col > 0:
                    df.loc[empty_mask, col] = "Unassigned"
                    null_counts[col] = cleaned_in_col

            # If boolean
            elif pd.api.types.is_bool_dtype(df[col]):
                if null_count > 0:
                    df[col] = df[col].fillna(False)
                    null_counts[col] = null_count

        return df, null_counts

    def _normalize_dates(self, df: pd.DataFrame) -> pd.DataFrame:
        """Preserve timestamps and ambiguous strings; parsing options own date coercion."""
        # IngestionService already applies reviewed formats/timezones. Re-inference here
        # used to discard time components and turn partially parsed values into nulls.
        return df


preprocessing_agent = PreprocessingAgent()
