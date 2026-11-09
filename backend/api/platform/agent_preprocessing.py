"""
Agent 1: Zero-Hardcode Preprocessing Agent
===========================================
Performs automated data sanitization, deduplication, null-value remediation,
type coercion, and currency/number normalization on any tabular DataFrame
without hardcoded column names or assumptions.
"""

import re
import math
from typing import Dict, Any, Tuple, List
import pandas as pd
import numpy as np

from api.utils.logger import get_logger

logger = get_logger("agent.preprocessing")


class PreprocessingAgent:
    """
    Autonomous data cleaning agent that removes duplicate and null values,
    normalizes headers, and coerces types conservatively.
    """

    def clean(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, Dict[str, Any]]:
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
                "message": "Empty or null DataFrame provided."
            }

        rows_before = len(df)
        cols_before = len(df.columns)
        nulls_cleaned_count = 0

        # Step 1: Sanitize Column Headers
        df = self._sanitize_headers(df)

        # Step 2: Remove completely empty rows and columns
        df = df.dropna(how="all")
        df = df.dropna(axis=1, how="all")

        # Step 3: Remove duplicate rows
        duplicates_before = len(df)
        df = df.drop_duplicates()
        exact_duplicates_removed = duplicates_before - len(df)

        # Step 4: Detect and Clean String-Encoded Numbers / Currencies
        df, num_cleaned = self._normalize_formatted_numbers(df)
        nulls_cleaned_count += num_cleaned

        # Step 5: Null / Missing Value Handling per Column Type
        df, col_null_fixes = self._remediate_nulls(df)
        nulls_cleaned_count += sum(col_null_fixes.values())

        # Step 6: Coerce Potential Date Columns
        df = self._normalize_dates(df)

        # Step 7: Deduplicate Potential Primary Key collision rows if any remain
        df, pk_dups = self._deduplicate_candidate_keys(df)
        total_duplicates_removed = exact_duplicates_removed + pk_dups

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
            "message": f"Sanitized {rows_after} rows. Removed {total_duplicates_removed} duplicates and remediated {nulls_cleaned_count} null/missing cells."
        }

        logger.info(f"[PreprocessingAgent] Finished: {audit['message']}")
        return df, audit

    def _sanitize_headers(self, df: pd.DataFrame) -> pd.DataFrame:
        """Sanitize column headers to valid, unique identifiers."""
        new_cols = []
        seen = {}
        for col in df.columns:
            name = str(col).strip()
            # Replace spaces and punctuation with underscores
            clean_name = re.sub(r'[\s\-\/\.]+', '_', name)
            clean_name = re.sub(r'[^\w_]', '', clean_name)
            clean_name = re.sub(r'_+', '_', clean_name).strip('_')
            if not clean_name:
                clean_name = "Column"

            # Handle duplicate column names
            if clean_name in seen:
                seen[clean_name] += 1
                unique_name = f"{clean_name}_{seen[clean_name]}"
            else:
                seen[clean_name] = 0
                unique_name = clean_name
            new_cols.append(unique_name)

        df.columns = new_cols
        return df

    def _normalize_formatted_numbers(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, int]:
        """Convert string numbers formatted with currency symbols, commas, or percent signs to numeric."""
        cleaned_cells = 0
        currency_regex = re.compile(r'^[\$\€\£\¥\₹]?\s*[-+]?[\d,]+(?:\.\d+)?%?$')

        for col in df.columns:
            if df[col].dtype == object or pd.api.types.is_string_dtype(df[col]):
                # Sample non-null values
                series = df[col].dropna()
                if series.empty:
                    continue

                sample = series.head(50).astype(str).str.strip()
                matches = sample.apply(lambda s: bool(currency_regex.match(s)))

                # If >= 80% of samples match formatted numeric pattern
                if matches.mean() >= 0.8:
                    try:
                        def parse_val(v):
                            if pd.isna(v) or v is None:
                                return np.nan
                            s = str(v).strip().replace(',', '').replace('$', '').replace('€', '').replace('£', '').replace('¥', '').replace('₹', '')
                            is_pct = s.endswith('%')
                            if is_pct:
                                s = s[:-1].strip()
                            try:
                                val = float(s)
                                return val / 100.0 if is_pct else val
                            except ValueError:
                                return np.nan

                        cleaned_series = df[col].apply(parse_val)
                        if cleaned_series.notna().mean() >= 0.7:
                            df[col] = cleaned_series
                            cleaned_cells += len(series)
                    except Exception as exc:
                        logger.debug(f"Could not convert column {col} to numeric: {exc}")

        return df, cleaned_cells

    def _remediate_nulls(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, Dict[str, int]]:
        """Remediate nulls dynamically based on column data type."""
        null_counts = {}

        for col in df.columns:
            null_count = int(df[col].isna().sum())
            if null_count == 0:
                continue

            null_ratio = null_count / len(df) if len(df) > 0 else 0

            # If column is numeric
            if pd.api.types.is_numeric_dtype(df[col]):
                if null_ratio <= 0.20:
                    # Low missingness: fill with median (or 0 if all nan)
                    median_val = df[col].median()
                    fill_val = median_val if pd.notna(median_val) else 0
                    df[col] = df[col].fillna(fill_val)
                else:
                    # High missingness: fill with 0 to preserve numeric operations
                    df[col] = df[col].fillna(0)
                null_counts[col] = null_count

            # If column is categorical / string
            elif pd.api.types.is_string_dtype(df[col]) or df[col].dtype == object:
                # Replace nulls and empty whitespace strings with "Unknown"
                df[col] = df[col].apply(lambda v: "Unknown" if pd.isna(v) or str(v).strip() == "" else v)
                null_counts[col] = null_count

            # If boolean
            elif pd.api.types.is_bool_dtype(df[col]):
                df[col] = df[col].fillna(False)
                null_counts[col] = null_count

        return df, null_counts

    def _normalize_dates(self, df: pd.DataFrame) -> pd.DataFrame:
        """Attempt to convert string columns that look like dates to datetime ISO strings."""
        for col in df.columns:
            if df[col].dtype == object or pd.api.types.is_string_dtype(df[col]):
                col_lower = col.lower()
                is_date_hint = any(k in col_lower for k in ["date", "time", "timestamp", "year", "month", "day", "created", "updated"])
                sample = df[col].dropna().head(20)
                if sample.empty:
                    continue

                if is_date_hint:
                    try:
                        parsed = pd.to_datetime(sample, errors='coerce')
                        if parsed.notna().mean() >= 0.8:
                            # Safely convert entire column to string ISO format
                            full_parsed = pd.to_datetime(df[col], errors='coerce')
                            # If conversion was mostly successful, replace with ISO date strings
                            if full_parsed.notna().mean() >= 0.7:
                                df[col] = full_parsed.dt.strftime('%Y-%m-%d')
                                # Fill unparseable dates with mode or forward fill
                                df[col] = df[col].ffill().bfill()
                    except Exception:
                        pass
        return df

    def _deduplicate_candidate_keys(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, int]:
        """Detect primary key candidates and remove duplicate collision rows."""
        dups_removed = 0
        for col in df.columns:
            col_lower = col.lower()
            if col_lower.endswith(("id", "code", "key", "number")) and col_lower not in ("month_num", "monthnum"):
                # Check uniqueness ratio
                non_nulls = df[col].dropna()
                if len(non_nulls) > 0 and (non_nulls.nunique() / len(non_nulls)) >= 0.95:
                    before_len = len(df)
                    df = df.drop_duplicates(subset=[col], keep="first")
                    dups_removed += before_len - len(df)
                    break
        return df, dups_removed


preprocessing_agent = PreprocessingAgent()

