"""Allowlisted analytical plans. SQL/Python strings are never execution inputs."""
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

Aggregation = Literal["SUM", "AVG", "MIN", "MAX", "COUNT", "COUNT_DISTINCT"]


class Filter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str
    operator: Literal["=", "!=", ">", "<", ">=", "<=", "IN", "CONTAINS", "IS_NULL", "NOT_NULL"]
    value: Any = None

    @model_validator(mode="after")
    def typed_operand(self):
        if self.operator == "IN" and not isinstance(self.value, list):
            raise ValueError("IN requires an array of values")
        if self.value is None and self.operator not in ("IS_NULL", "NOT_NULL"):
            raise ValueError("Use IS_NULL or NOT_NULL for missing values")
        return self


class Sort(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str
    direction: Literal["ASC", "DESC"] = "DESC"


class DateRange(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    column: str
    start: str | int | None = Field(None, alias="from")
    end: str | int | None = Field(None, alias="to")


class Measure(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str
    aggregation: Aggregation
    alias: str | None = None


class TimeGrouping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str
    period: Literal["year", "quarter", "month", "day"]


class Join(BaseModel):
    model_config = ConfigDict(extra="forbid")
    relationship: str
    how: Literal["left", "inner"] = "left"


class PeriodComparison(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str
    current_start: str
    current_end: str
    previous_start: str
    previous_end: str


class QueryPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent: Literal["analytical", "ranking", "comparison", "graph", "chat"] = "analytical"
    metric: str | None = None
    aggregation: Aggregation | None = None
    dimension: str | None = None
    dimensions: list[str] = Field(default_factory=list, max_length=8)
    measures: list[Measure] = Field(default_factory=list, max_length=20)
    filters: list[Filter] = Field(default_factory=list, max_length=100)
    date_filter: DateRange | None = None
    time_grouping: TimeGrouping | None = None
    joins: list[Join] = Field(default_factory=list, max_length=4)
    derived_metrics: list[str] = Field(default_factory=list, max_length=10)
    comparison: PeriodComparison | None = None
    sort: Sort | None = None
    limit: int | None = Field(None, ge=1, le=10000)
    chart_type: Literal["bar", "line", "scatter", "pie"] | None = None
    requires_vector_search: bool = False
    requires_structured_query: bool = True

    @model_validator(mode="after")
    def normalize_legacy_shape(self):
        if self.comparison and (self.date_filter or self.time_grouping):
            raise ValueError("Use explicit comparison periods without an additional date range or time grouping")
        if self.dimension and self.dimensions and self.dimensions != [d.strip() for d in self.dimension.split(",")]:
            raise ValueError("Specify dimension or dimensions, not both")
        if self.dimension:
            self.dimensions = [d.strip() for d in self.dimension.split(",")]
        if self.metric and self.measures and self.measures != [Measure(field=self.metric, aggregation=self.aggregation)]:
            raise ValueError("Specify metric or measures, not both")
        if self.metric:
            if not self.aggregation:
                raise ValueError("An explicit aggregation is required")
            self.measures = [Measure(field=self.metric, aggregation=self.aggregation)]
        aliases = [m.alias or m.field for m in self.measures]
        outputs = aliases + self.derived_metrics + self.dimensions + (["period"] if self.time_grouping else [])
        if len(outputs) != len(set(outputs)):
            raise ValueError("Output field names must be unique")
        return self
