"""Validated, domain-independent deterministic execution with decimal arithmetic."""
import operator
import time
from decimal import Decimal, InvalidOperation, localcontext
import pandas as pd
from api.models.query_plan import Filter, QueryPlan
from api.utils.logger import get_logger

logger = get_logger("services.analytics_engine")


def missing(value):
    return value is None or bool(pd.isna(value))


def decimal(value):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("A numeric operation contains a non-numeric value") from None
    if not result.is_finite():
        raise ValueError("Non-finite numeric values are unsupported")
    return result


TEMPORAL_DIMENSIONS = {
    "year", "quarter", "month", "monthname", "monthlabel", "monthnum",
    "date", "period", "day", "time", "created_at", "updated_at"
}


def is_temporal_dimension(name: str) -> bool:
    if not name:
        return False
    clean = str(name).lower().replace("_", "").replace(" ", "")
    return clean in TEMPORAL_DIMENSIONS or any(t in clean for t in ("year", "month", "date", "quarter", "period"))


def json_value(value):
    if missing(value):
        return None
    if isinstance(value, Decimal):
        try:
            return int(value) if value % 1 == 0 else float(value)
        except Exception:
            return float(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "item"):
        return value.item()
    return value


class AnalyticsResult:
    def __init__(self):
        self.success = False
        self.status = "execution_error"
        self.data = []
        self.summary = {}
        self.records_matched = 0
        self.records_total = 0
        self.execution_time_ms = 0
        self.error = None
        self.warnings = []
        self.execution_backend = "pandas"
        self.context = None
        self.data_complete = True

    def to_dict(self):
        return dict(success=self.success, status=self.status, data=self.data, summary=self.summary,
                    records_matched=self.records_matched, records_total=self.records_total,
                    execution_time_ms=round(self.execution_time_ms, 3), error=self.error,
                    warnings=self.warnings, execution_backend=self.execution_backend,
                    context=self.context, data_complete=self.data_complete)


class AnalyticsEngine:
    def _resolve_column(self, df, column):
        if column in df.columns:
            return column
        col_lower = str(column).lower()
        for c in df.columns:
            if str(c).lower() == col_lower:
                return c
        import re
        norm = re.sub(r'[\s_\-]+', '', str(column)).lower()
        for c in df.columns:
            if re.sub(r'[\s_\-]+', '', str(c)).lower() == norm:
                return c
        return None

    def _column(self, df, column):
        resolved = self._resolve_column(df, column)
        if resolved is None:
            raise ValueError(f"Unknown field '{column}'. Review the dataset semantic model.")
        return df[resolved]

    def _apply_single_filter(self, df, condition, result=None):
        f = condition if isinstance(condition, Filter) else Filter.model_validate(condition)
        series = self._column(df, f.column)
        if f.operator == "IS_NULL":
            return df[series.isna()]
        if f.operator == "NOT_NULL":
            return df[series.notna()]
        clean = series.dropna()
        numeric = pd.api.types.is_numeric_dtype(series) or (len(clean) > 0 and isinstance(clean.iloc[0], Decimal))
        temporal = pd.api.types.is_datetime64_any_dtype(series)
        boolean = pd.api.types.is_bool_dtype(series) or (len(clean) > 0 and isinstance(clean.iloc[0], bool))
        def coerce(value):
            if boolean:
                if value not in (True, False, "true", "false"):
                    raise ValueError("Boolean filters require true or false")
                return str(value).lower() == "true"
            if numeric:
                return decimal(value)
            if temporal:
                return pd.Timestamp(value)
            return str(value).casefold()
        comparable = series.map(lambda x: None if missing(x) else coerce(x))
        if f.operator == "IN":
            mask = comparable.isin([coerce(v) for v in f.value]) & series.notna()
        elif f.operator == "CONTAINS":
            if numeric or temporal:
                raise ValueError("CONTAINS requires a textual field")
            mask = series.astype("string").str.contains(str(f.value), case=False, na=False, regex=False)
        else:
            compare = {"=": operator.eq, "!=": operator.ne, ">": operator.gt, "<": operator.lt,
                       ">=": operator.ge, "<=": operator.le}[f.operator]
            operand = coerce(f.value)
            mask = comparable.map(lambda x: False if missing(x) else compare(x, operand))
        return df[mask]

    def _apply_filters(self, df, plan, result=None):
        filtered = df.copy()
        for condition in plan.get("filters", []):
            filtered = self._apply_single_filter(filtered, condition, result)
        date_range = plan.get("date_filter")
        if date_range:
            col = date_range.get("column")
            series = self._column(filtered, col)
            numeric = pd.api.types.is_numeric_dtype(series)
            temporal = pd.api.types.is_datetime64_any_dtype(series)
            for key, compare in (("from", operator.ge), ("to", operator.le)):
                value = date_range.get(key)
                if value is not None:
                    if numeric:
                        mask = compare(series, float(value)) & series.notna()
                    elif temporal:
                        mask = compare(series, pd.Timestamp(value)) & series.notna()
                    else:
                        raise ValueError("Date ranges require a typed date or numeric time field")
                    filtered = filtered[mask]
                    series = filtered[col]
        return filtered

    def _scalar_aggregate(self, df, metric, aggregation):
        if metric == "*":
            if aggregation != "COUNT":
                raise ValueError("Only COUNT may use the row identifier '*'")
            return len(df)
        series = self._column(df, metric).dropna()
        if aggregation == "COUNT":
            return len(series)
        if aggregation == "COUNT_DISTINCT":
            return int(series.nunique())
        if aggregation not in {"SUM", "AVG", "MIN", "MAX"}:
            raise ValueError("Unsupported aggregation")
        if series.empty:
            return None
        with localcontext() as ctx:
            ctx.prec = 38
            values = [decimal(v) for v in series]
            if aggregation == "SUM":
                return sum(values, Decimal(0))
            if aggregation == "AVG":
                return sum(values, Decimal(0)) / Decimal(len(values))
            return min(values) if aggregation == "MIN" else max(values)

    def _execute_on_hana(self, plan: QueryPlan, start: float):
        """Compile a validated single-table plan; complex plans use pinned snapshots."""
        from api.models.execution_context import current_selection
        from api.platform.data_resolution import current_table, quote_identifier
        selection = current_selection.get()
        if selection is None or plan.joins:
            return None
        table = current_table(selection.entry, selection.context.version)
        if not table:
            return None
        if plan.table_name and plan.table_name.casefold() != table.casefold():
            raise ValueError("The requested table does not belong to the selected dataset version")
        from api.database.hana_client import hana_client
        from api.platform.datasets_metadata_repository import datasets_metadata_repo
        try:
            schema = datasets_metadata_repo.load_schema_from_hana(table)
        except (ValueError, RuntimeError):
            logger.warning("HANA schema unavailable for the registered table; using the pinned snapshot", exc_info=True)
            return None
        if not schema:
            return None
        columns = {c["name"].casefold(): c for c in schema}

        def field(name):
            match = columns.get(name.casefold())
            if match is None:
                raise ValueError(f"Unknown field '{name}'. Review the dataset semantic model.")
            return quote_identifier(match["name"])

        def textual(name):
            return str(columns[name.casefold()].get("type", "string")).lower() in (
                "string", "identifier", "nvarchar", "varchar", "text", "nclob", "clob")

        measures = []
        for measure in plan.measures:
            if measure.field == "*" and measure.aggregation != "COUNT":
                raise ValueError("Only COUNT may use the row identifier '*'")
            column = "*" if measure.field == "*" else field(measure.field)
            aggregate = (f"COUNT(DISTINCT {column})" if measure.aggregation == "COUNT_DISTINCT"
                         else f"{measure.aggregation}({column})")
            measures.append(f'{aggregate} AS {quote_identifier(measure.alias or measure.field)}')
        dimensions = [f'{field(d)} AS {quote_identifier(d)}' for d in plan.dimensions]
        predicates, params = [], []
        for condition in plan.filters:
            column = field(condition.column)
            op, value = condition.operator, condition.value
            if op in ("IS_NULL", "NOT_NULL"):
                predicates.append(f"{column} IS {'NOT ' if op == 'NOT_NULL' else ''}NULL")
                continue
            is_text = textual(condition.column)
            if is_text:
                column = f"LOWER({column})"
            normalize = lambda v: str(v).casefold() if is_text else v
            if op == "IN":
                predicates.append(f"{column} IN ({', '.join('?' for _ in value)})" if value else "1=0")
                params.extend(normalize(v) for v in value)
            elif op == "CONTAINS":
                if not is_text:
                    raise ValueError("CONTAINS requires a textual field")
                literal = normalize(value).replace("!", "!!").replace("%", "!%").replace("_", "!_")
                predicates.append(f"{column} LIKE ? ESCAPE '!' ")
                params.append(f"%{literal}%")
            else:
                predicates.append(f"{column} {op} ?")
                params.append(normalize(value))
        if plan.date_filter:
            column = field(plan.date_filter.column)
            if textual(plan.date_filter.column):
                raise ValueError("Date ranges require a typed date or numeric time field")
            for op, value in ((">=", plan.date_filter.start), ("<=", plan.date_filter.end)):
                if value is not None:
                    predicates.append(f"{column} {op} ?")
                    params.append(value)
        where = "WHERE " + " AND ".join(predicates) if predicates else ""
        source = f"FROM {quote_identifier(table)}"
        group = "GROUP BY " + ", ".join(field(d) for d in plan.dimensions) if plan.dimensions else ""
        outputs = {m.alias or m.field for m in plan.measures} | set(plan.dimensions)
        order = ""
        if plan.sort:
            if plan.sort.column not in outputs:
                raise ValueError("Sort field must be a grouping or output field")
            order = f"ORDER BY {quote_identifier(plan.sort.column)} {plan.sort.direction}"
        else:
            temporal = [d for d in plan.dimensions if is_temporal_dimension(d)]
            if temporal:
                order = "ORDER BY " + ", ".join(quote_identifier(d) + " ASC" for d in temporal)
            elif plan.limit and plan.measures:
                order = f"ORDER BY {quote_identifier(plan.measures[0].alias or plan.measures[0].field)} DESC"
        limit = f"LIMIT {plan.limit}" if plan.limit else ""
        sql = " ".join(part for part in ("SELECT " + ", ".join(dimensions + measures), source, where, group, order, limit) if part)
        result = AnalyticsResult()
        try:
            rows = hana_client.execute_query(sql, tuple(params), native_types=True)
            if rows is None:
                raise RuntimeError("HANA returned no query result")
            counts = hana_client.execute_query(f"SELECT COUNT(*) AS CNT {source} {where}", tuple(params))
            totals = hana_client.execute_query(f"SELECT COUNT(*) AS CNT {source}") if predicates else counts
            if not counts or not totals:
                raise RuntimeError("HANA row counts are unavailable")
            result.records_matched = int(counts[0]["CNT"])
            result.records_total = int(totals[0]["CNT"])
            result.data = [{name: json_value(next((v for k, v in row.items() if k.casefold() == name.casefold()), None))
                            for name in [*plan.dimensions, *(m.alias or m.field for m in plan.measures)]} for row in rows]
            result.success, result.status = True, "success" if result.records_matched else "empty"
            result.execution_backend = "hana"
            result.context = selection.context.model_dump()
            if not result.records_matched:
                result.data = []
            elif not plan.dimensions and len(plan.measures) == 1 and result.data:
                measure = plan.measures[0]
                value = result.data[0][measure.alias or measure.field]
                result.summary = dict(metric=measure.field, aggregation=measure.aggregation,
                                      value=value, formatted_value=self._format_value(value, measure.field))
                result.data = [dict(metric=measure.field, aggregation=measure.aggregation, value=value)]
            result.execution_time_ms = (time.perf_counter() - start) * 1000
            return result
        except Exception as exc:
            logger.warning("HANA analytics failed; attempting the pinned snapshot (%s)", type(exc).__name__, exc_info=True)
            result.warnings.append("HANA execution failed; results were calculated from the selected dataset snapshot.")
            return result

    def execute(self, query_plan, dataframe=None, semantic_fields=None, semantic_model=None):
        result = AnalyticsResult()
        start = time.perf_counter()
        selection_token = None
        try:
            if isinstance(query_plan, dict) and not query_plan.get("aggregation") and not query_plan.get("measures"):
                query_plan = dict(query_plan)
                query_plan["aggregation"] = "SUM"
            plan = QueryPlan.model_validate(query_plan)
            if not plan.measures and not plan.derived_metrics:
                raise ValueError("Specify the metric and aggregation; no business metric is selected automatically.")
            if plan.intent == "comparison" and plan.comparison is None:
                raise ValueError("Specify current and previous comparison periods explicitly")
            from api.models.execution_context import current_selection
            from api.platform.data_resolution import selected_dataset, current_table
            selection = current_selection.get()
            if dataframe is None:
                target = plan.left_dataset_id or plan.dataset_id
                resolved = selected_dataset(target, for_chat=True)
                if resolved is not selection:
                    selection_token = current_selection.set(resolved)
                    semantic_model = semantic_fields = None
                selection = resolved
            if selection is not None:
                if semantic_model is None:
                    from api.platform.semantic import semantic_registry
                    semantic_model = semantic_registry.get(selection.entry, selection.context.version,
                                                           selection.context.semantic_revision, approved=True, for_chat=True)
                result.context = selection.context.model_dump()
                if plan.table_name:
                    table = current_table(selection.entry, selection.context.version)
                    if not table or table.casefold() != plan.table_name.casefold():
                        raise ValueError("The requested table does not belong to the selected dataset version")
            elif plan.table_name:
                raise ValueError("Physical table selection requires an authorized dataset")
            if semantic_fields is None and semantic_model is not None:
                semantic_fields = {f.name: f.aggregations for f in semantic_model.fields}
            if not plan.joins and semantic_fields is not None:
                for measure in plan.measures:
                    if measure.field != "*" and measure.aggregation not in semantic_fields.get(measure.field, []):
                        raise ValueError(f"{measure.aggregation} is not approved for '{measure.field}'.")
                fields = [*plan.dimensions, *(f.column for f in plan.filters)]
                if plan.date_filter:
                    fields.append(plan.date_filter.column)
                if plan.time_grouping:
                    fields.append(plan.time_grouping.field)
                for name in fields:
                    if name not in semantic_fields:
                        raise ValueError(f"Unknown field '{name}'. Review the dataset semantic model.")
            if dataframe is None and not plan.derived_metrics and not plan.comparison and not plan.time_grouping:
                hana_res = self._execute_on_hana(plan, start)
                if hana_res is not None and hana_res.success:
                    return hana_res
                if hana_res is not None:
                    result.warnings.extend(hana_res.warnings)
            if dataframe is None:
                from api.services.data_service import data_service
                dataframe = data_service.get_dataframe()
            df = dataframe.copy()
            # Normalize column names in df if they match plan dimensions/measures case-insensitively
            col_map = {}
            for col in list(plan.dimensions) + [m.field for m in plan.measures if m.field != "*"]:
                resolved = self._resolve_column(df, col)
                if resolved and resolved != col:
                    col_map[resolved] = col
            if col_map:
                df.rename(columns=col_map, inplace=True)
            result.records_total = len(df)
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            if semantic_model is None and selection is not None:
                from api.platform.semantic import semantic_registry
                semantic_model = semantic_registry.get(selection.entry, selection.context.version, selection.context.semantic_revision, approved=True, for_chat=True)
            if semantic_fields is None:
                if semantic_model is not None:
                    semantic_fields = {field.name: field.aggregations for field in semantic_model.fields}
            if plan.joins:
                for join in plan.joins:
                    if join.right_table and not join.right_dataset_id:
                        from api.platform.join_service import join_service
                        join.right_dataset_id = join_service.dataset_for_table(join.right_table)
                    if join.right_dataset_id or (join.left_key and join.right_key):
                        from api.platform.join_service import join_service
                        l_id = getattr(plan, "left_dataset_id", None) or getattr(plan, "dataset_id", None) or (selection.entry["id"] if selection and selection.entry else None)
                        l_k = join.left_key
                        r_k = join.right_key
                        if not l_k or not r_k:
                            res = join_service.resolve_join(l_id, join.right_dataset_id)
                            if not res.get("joinable"):
                                raise ValueError(res.get("reason", "Tables cannot be joined."))
                            l_k = res["left_key"]
                            r_k = res["right_key"]
                        if semantic_fields is not None:
                            from api.services.dataset_service import dataset_service
                            from api.platform.semantic import semantic_registry
                            right_entry = dataset_service._entry(dataset_service._catalog(), join.right_dataset_id, for_chat=True)
                            right_version = right_entry["currentVersion"]
                            models = semantic_registry.list(right_entry, right_version, for_chat=True)
                            revisions = [m["revision"] for m in models if m.get("status") == "approved"]
                            if not revisions:
                                import os
                                if os.getenv("PLATFORM_AUTO_APPROVE_SEMANTICS", "true").lower() == "true":
                                    revisions = [m["revision"] for m in models if m.get("status") == "proposed"]
                            if not revisions:
                                raise ValueError("The joined dataset has no approved semantic model")
                            right_model = semantic_registry.get(right_entry, right_version, max(revisions), approved=True, for_chat=True)
                            suffix = "_" + join_service._normalize_name(right_entry.get("name", "right"))[:6]
                            right_fields = {}
                            for field in right_model.fields:
                                output = field.name + suffix if field.name in df.columns and field.name != r_k else field.name
                                if output not in semantic_fields:
                                    right_fields[output] = field.aggregations
                            semantic_fields = {**semantic_fields, **right_fields}
                        df = join_service.load_joined_dataframe(
                            left_dataset_id=l_id,
                            right_dataset_id=join.right_dataset_id,
                            left_key=l_k,
                            right_key=r_k,
                            how=join.how, left_frame=df
                        )
                    elif join.relationship:
                        if selection is None or semantic_model is None:
                            raise ValueError("Joins require a selected approved semantic model")
                        from api.platform.formulas import validated_join
                        from api.platform.semantic import semantic_registry
                        from api.services.dataset_service import dataset_service
                        relationship = next((r for r in semantic_model.relationships if r.id == join.relationship), None)
                        if relationship is None:
                            raise ValueError("The requested relationship is not approved")
                        entry = dataset_service._entry(dataset_service._catalog(), relationship.right_dataset_id)
                        snapshot = dataset_service._snapshot(entry, relationship.right_version)
                        right_model = semantic_registry.get(entry, relationship.right_version, relationship.right_semantic_revision, approved=True)
                        df = validated_join(df, dataset_service._frame(snapshot["rows"], snapshot["columns"]), relationship, join.how)
                        if semantic_fields is not None:
                            semantic_fields = {**semantic_fields, **{f"{relationship.id}__{field.name}": field.aggregations for field in right_model.fields}}
            derived = []
            for name in plan.derived_metrics:
                metric = next((m for m in semantic_model.derived_metrics if m.name == name), None) if semantic_model is not None else None
                if metric is None:
                    raise ValueError("The derived metric is not approved")
                for dependency in metric.dependencies.values():
                    self._column(df, dependency.field)
                    if dependency.aggregation not in semantic_fields.get(dependency.field, []):
                        raise ValueError("Derived metric uses an unapproved aggregation")
                derived.append(metric)
            for measure in plan.measures:
                if measure.field != "*":
                    self._column(df, measure.field)
                    if semantic_fields is not None and measure.aggregation not in semantic_fields.get(measure.field, []):
                        raise ValueError(f"{measure.aggregation} is not approved for '{measure.field}'.")
            for dim in plan.dimensions:
                self._column(df, dim)
            if plan.comparison:
                return self._compare(plan, df, semantic_fields, semantic_model, start)
            if plan.intent == "comparison":
                raise ValueError("Specify current and previous comparison periods explicitly")
            filtered = self._apply_filters(df, plan.model_dump(by_alias=True))
            result.records_matched = len(filtered)
            if filtered.empty:
                result.success, result.status = True, "empty"
                return result
            dimensions = list(plan.dimensions)
            if plan.time_grouping:
                grouping = plan.time_grouping
                series = self._column(filtered, grouping.field)
                if not pd.api.types.is_datetime64_any_dtype(series):
                    if pd.api.types.is_numeric_dtype(series):
                        raise ValueError("Time grouping requires an approved date field")
                    parsed = pd.to_datetime(series, errors="coerce")
                    non_null = int(series.notna().sum())
                    if non_null == 0 or int(parsed.notna().sum()) < max(1, int(non_null * 0.7)):
                        raise ValueError("Time grouping requires an approved date field")
                    series = parsed
                period = {"year": "Y", "quarter": "Q", "month": "M", "day": "D"}[grouping.period]
                filtered = filtered.copy()
                filtered["period"] = series.dt.to_period(period).astype("string")
                dimensions.append("period")
            groups = filtered.groupby(dimensions, dropna=False, sort=False) if dimensions else [((), filtered)]
            rows = []
            for key, frame in groups:
                keys = key if isinstance(key, tuple) else (key,)
                row = {dim: json_value(v) for dim, v in zip(dimensions, keys)}
                for measure in plan.measures:
                    row[measure.alias or measure.field] = json_value(self._scalar_aggregate(frame, measure.field, measure.aggregation))
                for metric in derived:
                    from api.platform.formulas import formula
                    dependencies = {name: self._scalar_aggregate(frame, dependency.field, dependency.aggregation) for name, dependency in metric.dependencies.items()}
                    row[metric.name] = json_value(formula(metric.expression, dependencies))
                    if row[metric.name] is None:
                        result.warnings.append(f"{metric.name} is undefined because a dependency is missing or its denominator is zero.")
                rows.append(row)
            if plan.sort:
                if plan.sort.column not in rows[0]:
                    raise ValueError("Sort field must be a grouping or output field")
                col = plan.sort.column
                present = [r for r in rows if r[col] is not None]
                absent = [r for r in rows if r[col] is None]
                rows = sorted(present, key=lambda r: r[col], reverse=plan.sort.direction == "DESC") + absent
            else:
                temporal_dims = [d for d in dimensions if is_temporal_dimension(d)]
                if temporal_dims and rows:
                    def _temporal_sort_key(row):
                        keys = []
                        for d in temporal_dims:
                            v = row.get(d)
                            if v is None:
                                keys.append((2, 0.0, ""))
                            elif isinstance(v, (int, float)):
                                keys.append((0, float(v), ""))
                            else:
                                s = str(v).strip()
                                try:
                                    keys.append((0, float(s), ""))
                                except ValueError:
                                    keys.append((1, 0.0, s))
                        return tuple(keys)
                    rows = sorted(rows, key=_temporal_sort_key)
                elif plan.limit and rows:
                    # Default sorting for ranking queries (e.g. top N) by primary aggregated measure descending
                    measure_cols = [c for c in rows[0] if c not in (dimensions or [])]
                    if measure_cols:
                        col = measure_cols[0]
                        rows = sorted(
                            rows,
                            key=lambda r: float(r.get(col) or 0) if isinstance(r.get(col), (int, float, str)) and str(r.get(col)).replace('.', '', 1).replace('-', '', 1).isdigit() else 0,
                            reverse=True
                        )
            if plan.limit:
                rows = rows[:plan.limit]
            result.data = [{k: json_value(v) for k, v in row.items()} for row in rows]
            if not dimensions and len(plan.measures) == 1 and not derived:
                measure = plan.measures[0]
                value = rows[0][measure.alias or measure.field]
                result.summary = dict(metric=measure.field, aggregation=measure.aggregation,
                                      value=json_value(value), formatted_value=self._format_value(value, measure.field))
                result.data = [{"metric": measure.field, "aggregation": measure.aggregation, "value": json_value(value)}]
            result.success, result.status = True, "success"
        except (ValueError, TypeError, KeyError, InvalidOperation) as exc:
            result.error, result.status = str(exc), "invalid_query"
        except RuntimeError as exc:
            logger.warning("Complete dataset execution failed (%s)", type(exc).__name__, exc_info=True)
            result.error, result.status = "The complete selected dataset is unavailable. Retry the query.", "execution_failed"
        finally:
            if selection_token is not None:
                current_selection.reset(selection_token)
            result.execution_time_ms = (time.perf_counter() - start) * 1000
        return result

    def _compare(self, plan, dataframe, semantic_fields, semantic_model, start):
        comparison = plan.comparison
        if plan.date_filter or plan.time_grouping:
            raise ValueError("Comparison periods replace date_filter and time_grouping; specify one time strategy")
        current = (pd.Timestamp(comparison.current_start), pd.Timestamp(comparison.current_end))
        previous = (pd.Timestamp(comparison.previous_start), pd.Timestamp(comparison.previous_end))
        if current[0] > current[1] or previous[0] > previous[1] or max(current[0], previous[0]) <= min(current[1], previous[1]):
            raise ValueError("Comparison periods must be ordered and non-overlapping")
        base = plan.model_dump(by_alias=True, exclude_none=True)
        base.update(intent="analytical", joins=[], comparison=None, sort=None, limit=None)
        results = []
        for begin, end in (current, previous):
            subplan = {**base, "date_filter": {"column": comparison.column, "from": begin.isoformat(), "to": end.isoformat()}}
            result = self.execute(subplan, dataframe, semantic_fields, semantic_model)
            if not result.success:
                raise ValueError(result.error)
            results.append(result)
        dimensions = plan.dimensions
        def rows(result):
            if not dimensions and result.summary:
                return {(): {plan.measures[0].alias or plan.measures[0].field: result.summary["value"]}}
            return {tuple(row.get(field) for field in dimensions): row for row in result.data}
        current_rows, previous_rows = [rows(result) for result in results]
        fields = [m.alias or m.field for m in plan.measures] + plan.derived_metrics
        output = AnalyticsResult()
        output.records_total = len(dataframe)
        output.records_matched = sum(result.records_matched for result in results)
        for key in dict.fromkeys([*current_rows, *previous_rows]):
            row = dict(zip(dimensions, key))
            for field in fields:
                a = current_rows.get(key, {}).get(field)
                b = previous_rows.get(key, {}).get(field)
                a = None if a is None else decimal(a)
                b = None if b is None else decimal(b)
                with localcontext() as precision:
                    precision.prec = 38
                    row.update({f"current_{field}": json_value(a), f"previous_{field}": json_value(b),
                                f"difference_{field}": json_value(a - b) if a is not None and b is not None else None,
                                f"change_percent_{field}": json_value((a - b) / b * 100) if a is not None and b not in (None, 0) else None})
            output.data.append(row)
        if plan.sort:
            column = plan.sort.column
            if output.data and column not in output.data[0]:
                raise ValueError("Comparison sort field does not exist")
            present = [row for row in output.data if row.get(column) is not None]
            absent = [row for row in output.data if row.get(column) is None]
            output.data = sorted(present, key=lambda row: str(row[column]) if column in dimensions else decimal(row[column]), reverse=plan.sort.direction == "DESC") + absent
        if plan.limit:
            output.data = output.data[:plan.limit]
        output.success = True
        output.status = "success" if output.data else "empty"
        output.execution_time_ms = (time.perf_counter() - start) * 1000
        return output

    def _format_value(self, value, column):
        if missing(value):
            return "N/A"
        try:
            return f"{decimal(value):,f}"
        except ValueError:
            return str(value)


analytics_engine = AnalyticsEngine()
