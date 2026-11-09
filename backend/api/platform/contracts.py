"""Persisted workflow contracts; proposal certainty is never reported as accuracy."""
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from api.models.query_plan import Aggregation, QueryPlan, Measure


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ParseOptions(Contract):
    sheet: str | None = None
    table: str | None = None
    header_row: int = Field(1, ge=1)
    delimiter: str = Field(",", min_length=1, max_length=1)
    encoding: str = "utf-8-sig"
    decimal_separator: Literal[".", ","] = "."
    thousands_separator: Literal[",", ".", " "] | None = None
    date_format: str | None = None
    timezone: str | None = None
    duplicate_policy: Literal["keep", "reject", "drop"] = "keep"
    column_types: dict[str, Literal["string", "identifier", "integer", "decimal", "boolean", "date"]] = Field(default_factory=dict)
    currencies: dict[str, str] = Field(default_factory=dict)
    units: dict[str, str] = Field(default_factory=dict)


class FieldProfile(Contract):
    name: str
    type: str
    missing_count: int
    distinct_count: int
    samples: list[Any]
    warnings: list[str] = Field(default_factory=list)


class DataProfile(Contract):
    row_count: int
    duplicate_count: int
    fields: list[FieldProfile]
    warnings: list[str] = Field(default_factory=list)
    rejected_rows: list[dict] = Field(default_factory=list)
    source_hash: str


class Transformation(Contract):
    operation: Literal["trim", "rename", "fill_missing"]
    field: str
    value: Any = None


class TransformationPlan(Contract):
    revision: int = 1
    parsing: ParseOptions = Field(default_factory=ParseOptions)
    operations: list[Transformation] = Field(default_factory=list)


class SemanticField(Contract):
    name: str
    semantic_name: str
    type: Literal["string", "identifier", "integer", "decimal", "boolean", "date"]
    role: Literal["identifier", "dimension", "measure", "time", "attribute"]
    aliases: list[str] = Field(default_factory=list)
    description: str = ""
    unit: str | None = None
    currency: str | None = None
    aggregations: list[Aggregation] = Field(default_factory=lambda: ["COUNT", "COUNT_DISTINCT"])
    default_aggregation: Aggregation | None = None
    evidence: str = "User review required"

    @model_validator(mode="after")
    def permitted_aggregation(self):
        if self.default_aggregation and self.default_aggregation not in self.aggregations:
            raise ValueError("Default aggregation must be permitted")
        if self.role == "identifier" and set(self.aggregations) - {"COUNT", "COUNT_DISTINCT"}:
            raise ValueError("Identifiers cannot be summed or averaged")
        if set(self.aggregations) - {"COUNT", "COUNT_DISTINCT"} and self.type not in ("integer", "decimal"):
            raise ValueError("Arithmetic aggregation requires a numeric field")
        return self


class Relationship(Contract):
    id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,40}$")
    right_dataset_id: str
    right_version: int = Field(ge=1)
    right_semantic_revision: int = Field(ge=1)
    left_keys: list[str] = Field(min_length=1)
    right_keys: list[str] = Field(min_length=1)
    cardinality: Literal["many_to_one", "one_to_one"]
    evidence: dict = Field(default_factory=dict)


class DerivedMetric(Contract):
    name: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,80}$")
    expression: str = Field(min_length=1, max_length=1000)
    dependencies: dict[str, Measure]
    description: str
    unit: str | None = None
    currency: str | None = None


class SemanticModel(Contract):
    dataset_id: str
    data_version: int = Field(ge=1)
    revision: int = Field(ge=1)
    domain: str = "unknown"
    table_id: str = "main"
    grain: str = "Unconfirmed: one source row"
    fields: list[SemanticField]
    relationships: list[Relationship] = Field(default_factory=list)
    derived_metrics: list[DerivedMetric] = Field(default_factory=list)
    status: Literal["proposed", "approved", "rejected"] = "proposed"
    reviewer: str | None = None
    reviewed_at: str | None = None


class AnalyticsItem(Contract):
    id: str
    title: str
    kind: Literal["kpi", "table", "bar", "line", "scatter", "pie", "area", "donut", "horizontal_bar", "gauge", "funnel", "radar"]
    revision: int = Field(ge=1)
    semantic_revision: int = Field(ge=1)
    query_plan: QueryPlan
    explanation: str
    dependencies: list[str]
    status: Literal["proposed", "approved", "rejected"] = "proposed"
    reviewer: str | None = None
    reviewed_at: str | None = None


class AnalyticsPlan(Contract):
    dataset_id: str
    data_version: int
    semantic_revision: int
    items: list[AnalyticsItem]
