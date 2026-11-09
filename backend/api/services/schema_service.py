"""
Schema Service — Dataset Metadata & Semantic Mapping
=====================================================
Introspects the loaded DataFrame and produces rich per-column metadata
used by the IntentEngine and AnalyticsEngine for accurate column resolution.
"""

import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional, Tuple
from difflib import SequenceMatcher
from api.utils.logger import get_logger

logger = get_logger("services.schema_service")


# Schema mapping version — bump when column aliases or classifications change.
# Unit tests should assert against this version to detect silent regressions.
SCHEMA_MAPPING_VERSION = "1.0.0"

# ── User-term → column aliases ────────────────────────────────────────────────
# Maps common natural-language terms to actual SAC Sales column names.

_COLUMN_ALIASES: Dict[str, str] = {
    # Revenue / Sales
    "revenue": "NetRevenueUSD",
    "sales": "NetRevenueUSD",
    "net revenue": "NetRevenueUSD",
    "total revenue": "NetRevenueUSD",
    "total sales": "NetRevenueUSD",
    "income": "NetRevenueUSD",
    "turnover": "NetRevenueUSD",
    # Profit / Margin
    "profit": "GrossMarginUSD",
    "gross profit": "GrossMarginUSD",
    "gross margin": "GrossMarginUSD",
    "margin": "GrossMarginUSD",
    "margin usd": "GrossMarginUSD",
    "margin percent": "GrossMarginPercent",
    "margin %": "GrossMarginPercent",
    "profit margin": "GrossMarginPercent",
    "profit %": "GrossMarginPercent",
    "gross margin %": "GrossMarginPercent",
    "gross margin percent": "GrossMarginPercent",
    # Cost
    "cost": "TotalCostUSD",
    "total cost": "TotalCostUSD",
    "cogs": "TotalCostUSD",
    "cost of goods": "TotalCostUSD",
    "unit cost": "UnitCostUSD",
    # Quantity
    "quantity": "Quantity",
    "units": "Quantity",
    "units sold": "Quantity",
    "volume": "Quantity",
    "orders": "Quantity",
    "order count": "Quantity",
    # Price
    "price": "UnitListPriceUSD",
    "list price": "UnitListPriceUSD",
    "unit price": "UnitListPriceUSD",
    "net price": "NetUnitPriceUSD",
    "net unit price": "NetUnitPriceUSD",
    # Discount
    "discount": "DiscountPercent",
    "discount %": "DiscountPercent",
    "discount percent": "DiscountPercent",
    # FX
    "fx rate": "FXRateToUSD",
    "exchange rate": "FXRateToUSD",
    "local revenue": "NetRevenueLocalCurrency",
    # Dimensions
    "customer": "CustomerName",
    "customer name": "CustomerName",
    "customers": "CustomerName",
    "client": "CustomerName",
    "product": "ProductName",
    "product name": "ProductName",
    "products": "ProductName",
    "region": "Region",
    "regions": "Region",
    "country": "Country",
    "countries": "Country",
    "category": "Category",
    "categories": "Category",
    "subcategory": "SubCategory",
    "sub category": "SubCategory",
    "sub-category": "SubCategory",
    "segment": "CustomerSegment",
    "customer segment": "CustomerSegment",
    "industry": "IndustryVertical",
    "vertical": "IndustryVertical",
    "industry vertical": "IndustryVertical",
    "channel": "Channel",
    "sales channel": "Channel",
    "sales rep": "SalesRepName",
    "rep": "SalesRepName",
    "representative": "SalesRepName",
    "sales office": "SalesOffice",
    "office": "SalesOffice",
    "sales region": "SalesRegion",
    "order type": "OrderType",
    "order status": "OrderStatus",
    "status": "OrderStatus",
    "payment": "PaymentTerms",
    "payment terms": "PaymentTerms",
    "currency": "TransactionCurrency",
    # Temporal
    "date": "OrderDate",
    "order date": "OrderDate",
    "year": "Year",
    "quarter": "Quarter",
    "month": "MonthName",
    "month name": "MonthName",
    "month label": "MonthLabel",
    "month number": "MonthNum",
}

# Columns that are measures (numeric, aggregatable)
_MEASURE_COLUMNS = {
    "NetRevenueUSD", "TotalCostUSD", "GrossMarginUSD", "Quantity",
    "UnitListPriceUSD", "NetUnitPriceUSD", "UnitCostUSD",
    "DiscountPercent", "GrossMarginPercent", "FXRateToUSD",
    "NetRevenueLocalCurrency",
}

# Columns that are dimensions (categorical, filterable)
_DIMENSION_COLUMNS = {
    "Region", "Country", "Category", "Subcategory", "CustomerSegment",
    "SalesRegion", "Channel", "OrderType", "OrderStatus", "IndustryVertical",
    "CustomerName", "ProductName", "SalesRepName", "SalesOffice",
    "SalesRepRole", "PaymentTerms", "TransactionCurrency",
    "UnitOfMeasure", "CustomerID", "ProductID", "SalesRepID", "OrderID",
}

# Columns that are temporal
_DATE_COLUMNS = {"OrderDate", "Year", "Quarter", "MonthNum", "MonthName", "MonthLabel"}

# Default aggregation per measure
_DEFAULT_AGGREGATIONS: Dict[str, str] = {
    "NetRevenueUSD": "SUM",
    "TotalCostUSD": "SUM",
    "GrossMarginUSD": "SUM",
    "Quantity": "SUM",
    "UnitListPriceUSD": "AVG",
    "NetUnitPriceUSD": "AVG",
    "UnitCostUSD": "AVG",
    "DiscountPercent": "AVG",
    "GrossMarginPercent": "AVG",
    "FXRateToUSD": "AVG",
    "NetRevenueLocalCurrency": "SUM",
}


class ColumnMetadata:
    """Rich metadata for a single dataset column."""

    def __init__(self, column_name: str, series: pd.Series):
        self.column_name = column_name
        self.data_type = str(series.dtype)
        self.is_numeric = pd.api.types.is_numeric_dtype(series)
        self.is_measure = column_name in _MEASURE_COLUMNS
        self.is_dimension = column_name in _DIMENSION_COLUMNS
        self.is_date = column_name in _DATE_COLUMNS
        self.is_identifier = column_name.endswith("ID") or column_name == "OrderID"
        self.is_filterable = self.is_dimension or self.is_date
        self.is_aggregatable = self.is_measure

        # Semantic type
        if self.is_measure:
            if "Percent" in column_name:
                self.semantic_type = "percentage"
            else:
                self.semantic_type = "measure"
        elif self.is_date:
            self.semantic_type = "date"
        elif self.is_identifier:
            self.semantic_type = "identifier"
        elif self.is_dimension:
            self.semantic_type = "dimension"
        else:
            self.semantic_type = "attribute"

        # Aggregation support
        if self.is_aggregatable:
            self.aggregations = ["SUM", "AVG", "MIN", "MAX", "COUNT"]
            self.default_aggregation = _DEFAULT_AGGREGATIONS.get(column_name, "SUM")
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
                item = ColumnMetadata(field.name, df[field.name])
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
        Resolve a user's natural-language term to an actual column name.
        1. Exact match (case-insensitive)
        2. Alias lookup
        3. Fuzzy matching (>0.7 similarity)
        """
        from api.models.execution_context import current_selection
        if current_selection.get() is not None:
            return self.resolve_column_with_ambiguity_check(user_term)["resolved_col"]
        term_lower = user_term.strip().lower()

        # 1. Exact column name match
        for col_name in self.get_metadata():
            if col_name.lower() == term_lower:
                return col_name

        # 2. Alias lookup
        if term_lower in _COLUMN_ALIASES:
            target = _COLUMN_ALIASES[term_lower]
            if target in self.get_metadata():
                return target

        # 3. Fuzzy matching against column names
        best_score = 0.0
        best_match = None
        for col_name in self.get_metadata():
            score = SequenceMatcher(None, term_lower, col_name.lower()).ratio()
            if score > best_score and score > 0.7:
                best_score = score
                best_match = col_name

        # 4. Fuzzy matching against aliases
        for alias, col_name in _COLUMN_ALIASES.items():
            score = SequenceMatcher(None, term_lower, alias).ratio()
            if score > best_score and score > 0.7:
                best_score = score
                best_match = col_name

        return best_match

    def resolve_column_with_ambiguity_check(
        self, user_term: str
    ) -> Dict[str, Any]:
        """
        Resolve a user term to a column name, detecting ambiguity.

        Returns a dict with:
          resolved_col:          str | None — the resolved column (None if ambiguous)
          matches:               list[str]  — all candidate columns
          is_ambiguous:          bool
          clarification_prompt:  str | None — human-readable question if ambiguous
        """
        from api.models.execution_context import current_selection
        selection = current_selection.get()
        if selection is not None:
            from api.platform.semantic import semantic_registry
            model = semantic_registry.get(selection.entry, selection.context.version, selection.context.semantic_revision, approved=True)
            term = user_term.strip().casefold()
            matches = [f.name for f in model.fields if term in {f.name.casefold(), f.semantic_name.casefold(), *[a.casefold() for a in f.aliases]}]
            return {"resolved_col": matches[0] if len(matches) == 1 else None, "matches": matches,
                    "is_ambiguous": len(matches) > 1,
                    "clarification_prompt": f"Choose the intended field: {', '.join(matches)}." if len(matches) > 1 else None}
        term_lower = user_term.strip().lower()
        meta = self.get_metadata()

        # ── 1. Exact column name match ────────────────────────────────────
        for col_name in meta:
            if col_name.lower() == term_lower:
                return {
                    "resolved_col": col_name,
                    "matches": [col_name],
                    "is_ambiguous": False,
                    "clarification_prompt": None,
                }

        # ── 2. Alias lookup — collect ALL aliases that match ──────────────
        alias_matches: list[str] = []
        for alias, target_col in _COLUMN_ALIASES.items():
            if alias == term_lower and target_col in meta:
                if target_col not in alias_matches:
                    alias_matches.append(target_col)

        if len(alias_matches) == 1:
            return {
                "resolved_col": alias_matches[0],
                "matches": alias_matches,
                "is_ambiguous": False,
                "clarification_prompt": None,
            }

        # ── 3. Check for ambiguity: does the term partially match
        #       multiple aliases that resolve to DIFFERENT columns? ────────
        partial_targets: dict[str, list[str]] = {}  # col → [aliases]
        for alias, target_col in _COLUMN_ALIASES.items():
            if term_lower in alias or alias in term_lower:
                if target_col in meta:
                    partial_targets.setdefault(target_col, []).append(alias)

        unique_targets = list(partial_targets.keys())
        if len(unique_targets) > 1:
            # Ambiguous — generate clarification
            options = []
            for col in unique_targets:
                col_meta = meta.get(col)
                label = col_meta.semantic_type if col_meta else "unknown"
                options.append(f"  • {col} ({label})")
            clarification = (
                f"The term \"{user_term}\" could refer to multiple columns:\n"
                + "\n".join(options)
                + "\nPlease specify which one you mean."
            )
            return {
                "resolved_col": None,
                "matches": unique_targets,
                "is_ambiguous": True,
                "clarification_prompt": clarification,
            }

        if len(unique_targets) == 1:
            return {
                "resolved_col": unique_targets[0],
                "matches": unique_targets,
                "is_ambiguous": False,
                "clarification_prompt": None,
            }

        # ── 4. Fuzzy matching (same as resolve_column) ────────────────────
        best_score = 0.0
        best_match = None
        for col_name in meta:
            score = SequenceMatcher(None, term_lower, col_name.lower()).ratio()
            if score > best_score and score > 0.7:
                best_score = score
                best_match = col_name
        for alias, col_name in _COLUMN_ALIASES.items():
            score = SequenceMatcher(None, term_lower, alias).ratio()
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
