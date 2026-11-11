"""
Schema Service — Dynamic Dataset Metadata & Semantic Mapping
=============================================================
Introspects the loaded DataFrame or active SemanticModel and produces rich
per-column metadata dynamically for any dataset or connector source.
"""

import re
from decimal import Decimal
import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional, Tuple
from difflib import SequenceMatcher
from api.utils.logger import get_logger

logger = get_logger("services.schema_service")


SCHEMA_MAPPING_VERSION = "2.0.0"

_AVG_HINTS = (
    "percent", "pct", "ratio", "rate", "avg", "average", "mean",
    "discount", "score", "price", "fx", "index", "temp", "humidity", "speed",
)
_DATE_TOKENS = ("date", "timestamp", "datetime", "month", "quarter", "year", "period")
_DURATION_HINTS = ("duration", "uptime", "downtime", "latency", "elapsed", "age", "lead_time", "cycle_time")


def _is_identifier_name(column_name: str) -> bool:
    low = column_name.strip().lower()
    if low in ("id", "code", "key", "uuid", "guid", "sku", "imo"):
        return True
    if re.search(r"(?:^|_)(?:id|code|key|uuid|guid|num|no)$", low):
        return True
    if re.search(r"[a-z](?:Id|ID|Key|Code|Num|No)$", column_name):
        return True
    return False


def _is_temporal_name(column_name: str) -> bool:
    low = column_name.strip().lower()
    if any(h in low for h in _DURATION_HINTS):
        return False
    return any(tok in low for tok in _DATE_TOKENS)


def _is_decimal_series(series: pd.Series) -> bool:
    if series.empty:
        return False
    non_null = series.dropna().head(10)
    return len(non_null) > 0 and all(isinstance(v, (Decimal, int, float)) and not isinstance(v, bool) for v in non_null)


class ColumnMetadata:
    """Rich, zero-hardcode metadata for a single dataset column."""

    def __init__(self, column_name: str, series: pd.Series):
        self.column_name = column_name
        self.data_type = str(series.dtype)
        is_bool = pd.api.types.is_bool_dtype(series)
        self.is_numeric = (pd.api.types.is_numeric_dtype(series) and not is_bool) or _is_decimal_series(series)
        self.is_identifier = _is_identifier_name(column_name)
        is_dt = pd.api.types.is_datetime64_any_dtype(series)
        self.is_date = is_dt or (_is_temporal_name(column_name) and not (self.is_numeric and pd.api.types.is_float_dtype(series)))
        self.is_measure = self.is_numeric and not self.is_identifier and not self.is_date
        self.is_dimension = not self.is_measure
        self.is_filterable = True
        self.is_aggregatable = self.is_measure

        low = column_name.lower()
        if self.is_measure:
            if any(h in low for h in ("percent", "pct", "ratio")):
                self.semantic_type = "percentage"
            else:
                self.semantic_type = "measure"
        elif self.is_date:
            self.semantic_type = "date"
        elif self.is_identifier:
            self.semantic_type = "identifier"
        else:
            self.semantic_type = "dimension"

        if self.is_aggregatable:
            self.aggregations = ["SUM", "AVG", "MIN", "MAX", "COUNT"]
            self.default_aggregation = "AVG" if any(h in low for h in _AVG_HINTS) else "SUM"
        else:
            self.aggregations = ["COUNT", "COUNT_DISTINCT"]
            self.default_aggregation = "COUNT"

        # Sample values / range
        self.unique_count = int(series.nunique())
        if self.is_numeric and not series.empty:
            clean = series.dropna()
            if len(clean) > 0:
                self.value_range = {"min": float(clean.min()), "max": float(clean.max())}
                self.sample_values = [float(v) for v in clean.head(5).tolist()]
            else:
                self.value_range = None
                self.sample_values = []
        elif not series.empty:
            unique_vals = series.dropna().unique()[:8]
            self.sample_values = [str(v) for v in unique_vals]
            self.value_range = None
        else:
            self.sample_values = []
            self.value_range = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "column_name": self.column_name,
            "data_type": self.data_type,
            "semantic_type": self.semantic_type,
            "is_dimension": self.is_dimension,
            "is_measure": self.is_measure,
            "is_date": self.is_date,
            "is_identifier": self.is_identifier,
            "is_filterable": self.is_filterable,
            "is_aggregatable": self.is_aggregatable,
            "aggregations": self.aggregations,
            "default_aggregation": self.default_aggregation,
            "unique_count": self.unique_count,
            "sample_values": self.sample_values,
            "value_range": self.value_range,
        }

    def to_prompt_string(self) -> str:
        """Compact string for inclusion in LLM prompts."""
        parts = [f"{self.column_name} [{self.data_type}] ({self.semantic_type})"]
        if self.is_aggregatable:
            parts.append(f"agg={self.default_aggregation}")
        if self.value_range:
            parts.append(f"range={self.value_range['min']:.0f}..{self.value_range['max']:.0f}")
        elif self.sample_values:
            samples = ", ".join(str(s) for s in self.sample_values[:4])
            parts.append(f"values=[{samples}]")
        return " | ".join(parts)


class SchemaService:
    """
    Introspects the loaded dataset and provides rich metadata for
    the IntentEngine and AnalyticsEngine.
    """

    _instance = None
    _metadata: Optional[Dict[str, ColumnMetadata]] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def _build_metadata(self, df: pd.DataFrame) -> Dict[str, ColumnMetadata]:
        """Build metadata from the current DataFrame."""
        metadata = {}
        for col in df.columns:
            metadata[col] = ColumnMetadata(col, df[col])
        return metadata

    def refresh(self, df: pd.DataFrame) -> None:
        """Rebuild metadata from a new DataFrame (called after upload)."""
        self._metadata = self._build_metadata(df)
        logger.info(f"Schema metadata refreshed: {len(self._metadata)} columns")

    def get_metadata(self) -> Dict[str, ColumnMetadata]:
        """Get metadata, auto-loading from DataService if needed."""
        from api.services.data_service import data_service
        df = data_service.get_dataframe()
        from api.models.execution_context import current_selection
        selection = current_selection.get()
        if selection is not None:
            from api.platform.semantic import semantic_registry
            model = semantic_registry.get(selection.entry, selection.context.version,
                                          selection.context.semantic_revision, approved=True)
            metadata = {}
            for field in model.fields:
                series = df[field.name] if field.name in df.columns else pd.Series(dtype=object)
                item = ColumnMetadata(field.name, series)
                item.is_numeric = field.type in ("integer", "decimal")
                item.is_measure = field.role == "measure"
                item.is_dimension = field.role in ("dimension", "identifier")
                item.is_identifier = field.role == "identifier"
                item.is_date = field.role == "time"
                item.semantic_type = field.role
                item.is_filterable = True
                item.is_aggregatable = bool(field.aggregations)
                item.aggregations = field.aggregations
                item.default_aggregation = field.default_aggregation
                metadata[field.name] = item
            return metadata
        if self._metadata is None:
            self._metadata = self._build_metadata(df)
            logger.info(f"Schema metadata initialized: {len(self._metadata)} columns")
        return self._metadata

    def get_column_names(self) -> List[str]:
        return list(self.get_metadata().keys())

    def get_measures(self) -> List[str]:
        return [k for k, v in self.get_metadata().items() if v.is_measure]

    def get_dimensions(self) -> List[str]:
        return [k for k, v in self.get_metadata().items() if v.is_dimension]

    def get_date_columns(self) -> List[str]:
        return [k for k, v in self.get_metadata().items() if v.is_date]

    # ── Column Resolution ─────────────────────────────────────────────────────

    def resolve_column(self, user_term: str) -> Optional[str]:
        """
        Resolve a user's natural-language term to an actual column name dynamically:
        1. Exact match (case-insensitive or underscore/space-normalized)
        2. Active SemanticModel field name / semantic_name / aliases
        3. Substring / fuzzy matching (>0.7 similarity) against active columns
        """
        return self.resolve_column_with_ambiguity_check(user_term)["resolved_col"]

    def resolve_column_with_ambiguity_check(
        self, user_term: str
    ) -> Dict[str, Any]:
        """
        Resolve a user term to an actual column name in the active dataset, detecting ambiguity.
        """
        from api.models.execution_context import current_selection
        selection = current_selection.get()
        term = user_term.strip().casefold()
        term_norm = re.sub(r"[^a-z0-9]", "", term)

        if selection is not None:
            from api.platform.semantic import semantic_registry
            model = semantic_registry.get(selection.entry, selection.context.version, selection.context.semantic_revision, approved=True)
            matches = [
                f.name for f in model.fields
                if term in {f.name.casefold(), f.semantic_name.casefold(), *[a.casefold() for a in f.aliases]}
                or (term_norm and term_norm in {re.sub(r"[^a-z0-9]", "", f.name.casefold()), re.sub(r"[^a-z0-9]", "", f.semantic_name.casefold())})
            ]
            if not matches and term_norm:
                matches = [
                    f.name for f in model.fields
                    if term in f.name.casefold() or term in f.semantic_name.casefold()
                    or any(term in a.casefold() for a in f.aliases)
                ]
            return {
                "resolved_col": matches[0] if len(matches) == 1 else None,
                "matches": matches,
                "is_ambiguous": len(matches) > 1,
                "clarification_prompt": f"Choose the intended field: {', '.join(matches)}." if len(matches) > 1 else None,
            }

        meta = self.get_metadata()

        # 1. Exact or normalized column name match
        for col_name in meta:
            if col_name.casefold() == term or (term_norm and re.sub(r"[^a-z0-9]", "", col_name.casefold()) == term_norm):
                return {
                    "resolved_col": col_name,
                    "matches": [col_name],
                    "is_ambiguous": False,
                    "clarification_prompt": None,
                }

        # 2. Substring match across actual dataset columns (for ambiguity detection)
        partial_matches = [col_name for col_name in meta if term and (term in col_name.casefold() or term in col_name.replace("_", " ").casefold())]
        if len(partial_matches) > 1:
            options = [f"  • {col} ({meta[col].semantic_type})" for col in partial_matches]
            return {
                "resolved_col": None,
                "matches": partial_matches,
                "is_ambiguous": True,
                "clarification_prompt": f"The term \"{user_term}\" could refer to multiple columns:\n" + "\n".join(options) + "\nPlease specify which one you mean.",
            }
        if len(partial_matches) == 1:
            return {
                "resolved_col": partial_matches[0],
                "matches": partial_matches,
                "is_ambiguous": False,
                "clarification_prompt": None,
            }

        # 3. Fuzzy matching against actual column names
        best_score = 0.0
        best_match = None
        for col_name in meta:
            score = SequenceMatcher(None, term, col_name.casefold()).ratio()
            if score > best_score and score > 0.7:
                best_score = score
                best_match = col_name

        return {
            "resolved_col": best_match,
            "matches": [best_match] if best_match else [],
            "is_ambiguous": False,
            "clarification_prompt": None,
        }

    def resolve_filter_value(self, column: str, user_value: str) -> Tuple[Optional[str], List[str]]:
        """
        Resolve a user's filter value to an actual dataset value.
        Returns (resolved_value, possible_matches).
        If ambiguous, resolved_value is None and possible_matches contains alternatives.
        """
        meta = self.get_metadata()
        if column not in meta or meta[column].is_numeric:
            return (user_value, [])

        from api.services.data_service import data_service
        df = data_service.get_dataframe()
        if column not in df.columns:
            return (None, [])

        actual_values = df[column].dropna().unique().tolist()
        actual_values = [str(v) for v in actual_values]
        user_lower = user_value.strip().lower()

        # Exact match
        for val in actual_values:
            if val.lower() == user_lower:
                return (val, [])

        # Substring match
        matches = [v for v in actual_values if user_lower in v.lower() or v.lower() in user_lower]
        if len(matches) == 1:
            return (matches[0], [])
        if len(matches) > 1:
            return (None, matches)

        # Fuzzy match
        scored = []
        for val in actual_values:
            score = SequenceMatcher(None, user_lower, val.lower()).ratio()
            if score > 0.6:
                scored.append((val, score))
        scored.sort(key=lambda x: x[1], reverse=True)

        if scored and scored[0][1] > 0.8:
            return (scored[0][0], [])
        if scored:
            return (None, [s[0] for s in scored[:5]])

        return (None, [])

    # ── Prompt-Ready Schema Description ───────────────────────────────────────

    def get_schema_for_prompt(self) -> str:
        """Generate a compact schema description for LLM prompts."""
        lines = []
        meta = self.get_metadata()

        lines.append("MEASURES (numeric, aggregatable):")
        for col_name, col_meta in meta.items():
            if col_meta.is_measure:
                lines.append(f"  {col_meta.to_prompt_string()}")

        lines.append("\nDIMENSIONS (categorical, filterable):")
        for col_name, col_meta in meta.items():
            if col_meta.is_dimension and not col_meta.is_identifier:
                lines.append(f"  {col_meta.to_prompt_string()}")

        lines.append("\nTEMPORAL (date/time columns):")
        for col_name, col_meta in meta.items():
            if col_meta.is_date:
                lines.append(f"  {col_meta.to_prompt_string()}")
        return "\n".join(lines)

    def get_compact_schema_for_prompt(self) -> str:
        """Generate a high-density, compact schema string to minimize LLM token usage (~300 tokens vs 1500)."""
        meta = self.get_metadata()
        measures = [k for k, v in meta.items() if v.is_measure]
        dims = [k for k, v in meta.items() if v.is_dimension and not v.is_identifier]
        dates = [k for k, v in meta.items() if v.is_date]
        return (
            f"MEASURES (numeric metrics): {', '.join(measures)}\n"
            f"DIMENSIONS (grouping attributes): {', '.join(dims)}\n"
            f"TEMPORAL (time periods): {', '.join(dates)}"
        )

schema_service = SchemaService()
