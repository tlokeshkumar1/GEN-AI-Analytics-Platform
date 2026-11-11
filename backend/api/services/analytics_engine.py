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
    "orderdate", "date", "period", "day", "time", "created_at", "updated_at"
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

    def to_dict(self):
        return dict(success=self.success, status=self.status, data=self.data, summary=self.summary,
                    records_matched=self.records_matched, records_total=self.records_total,
                    execution_time_ms=round(self.execution_time_ms, 3), error=self.error,
                    warnings=self.warnings, execution_backend="pandas")


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
        """Execute analytical query directly on SAP HANA Cloud table(s), supporting dynamic joins."""
        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            selection = current_selection.get()

            # 1. Resolve base (left) table
            target_table = getattr(plan, "table_name", None)
            if not target_table and getattr(plan, "left_dataset_id", None):
                from api.services.dataset_service import dataset_service
                cat = dataset_service._catalog()
                left_entry = dataset_service._entry(cat, plan.left_dataset_id, for_chat=True)
                if left_entry:
                    target_table = left_entry.get("physical_table_name") or left_entry.get("name")
            if not target_table and getattr(plan, "dataset_id", None):
                from api.services.dataset_service import dataset_service
                cat = dataset_service._catalog()
                left_entry = dataset_service._entry(cat, plan.dataset_id, for_chat=True)
                if left_entry:
                    target_table = left_entry.get("physical_table_name") or left_entry.get("name")
            if not target_table and selection and selection.entry:
                target_table = selection.entry.get("physical_table_name") or selection.entry.get("name")
            target_table = datasets_metadata_repo._resolve_physical_table(target_table)

            # 2. Process joins if present
            join_clauses = []
            right_schemas = []
            if plan.joins:
                from api.platform.join_service import join_service
                from api.services.dataset_service import dataset_service
                cat = dataset_service._catalog()
                left_id = getattr(plan, "left_dataset_id", None) or getattr(plan, "dataset_id", None) or (selection.entry["id"] if selection and selection.entry else None)
                for idx, j in enumerate(plan.joins):
                    r_table = j.right_table
                    r_key = j.right_key
                    l_key = j.left_key
                    if not r_table and j.right_dataset_id:
                        r_entry = dataset_service._entry(cat, j.right_dataset_id, for_chat=True)
                        if r_entry:
                            r_table = datasets_metadata_repo._resolve_physical_table(
                                r_entry.get("physical_table_name") or r_entry.get("name")
                            )
                    if (not l_key or not r_key) and j.right_dataset_id and left_id:
                        res = join_service.resolve_join(left_id, j.right_dataset_id)
                        if res.get("joinable"):
                            l_key = res["left_key"]
                            r_key = res["right_key"]
                            if not r_table:
                                r_table = res.get("right_table")

                    if r_table and l_key and r_key:
                        r_alias = f"R{idx + 1}"
                        r_schema_cols = {c["name"].upper(): c["name"] for c in datasets_metadata_repo.load_schema_from_hana(r_table)}
                        right_schemas.append((r_alias, r_schema_cols))
                        join_type = "LEFT JOIN" if j.how == "left" else "INNER JOIN"
                        join_clauses.append(f'{join_type} "{r_table}" {r_alias} ON L."{l_key.upper()}" = {r_alias}."{r_key.upper()}"')

            has_joins = bool(join_clauses)
            left_schema_cols = {c["name"].upper(): c["name"] for c in datasets_metadata_repo.load_schema_from_hana(target_table)}

            def qualify_col(col_name: str) -> str:
                if not has_joins:
                    return f'"{col_name.upper()}"'
                c_up = col_name.upper()
                for r_alias, r_cols in right_schemas:
                    if c_up in r_cols:
                        return f'{r_alias}."{c_up}"'
                if c_up in left_schema_cols:
                    return f'L."{c_up}"'
                return f'"{c_up}"'

            dim_cols = [f'{qualify_col(d)} AS "{d.upper()}"' for d in plan.dimensions] if has_joins else [f'"{d.upper()}"' for d in plan.dimensions]
            measure_exprs = []
            for m in plan.measures:
                col = qualify_col(m.field) if m.field != '*' else '*'
                agg = m.aggregation.upper()
                alias = m.alias or m.field
                if agg == 'COUNT_DISTINCT':
                    measure_exprs.append(f'COUNT(DISTINCT {col}) AS "{alias}"')
                elif agg == 'COUNT' and col == '*':
                    measure_exprs.append(f'COUNT(*) AS "{alias}"')
                else:
                    measure_exprs.append(f'{agg}({col}) AS "{alias}"')

            select_parts = dim_cols + measure_exprs
            select_clause = ', '.join(select_parts)

            where_parts = []
            params = []
            for f in (plan.filters or []):
                col = qualify_col(f.column)
                op = f.operator.upper()
                if op == 'IS_NULL':
                    where_parts.append(f'{col} IS NULL')
                elif op == 'NOT_NULL':
                    where_parts.append(f'{col} IS NOT NULL')
                elif op == 'IN':
                    placeholders = ', '.join(['?'] * len(f.value))
                    where_parts.append(f'{col} IN ({placeholders})')
                    params.extend(f.value)
                elif op == 'CONTAINS':
                    where_parts.append(f'{col} LIKE ?')
                    params.append(f'%{f.value}%')
                elif op in ('=', '!=', '>', '<', '>=', '<='):
                    where_parts.append(f'{col} {op} ?')
                    params.append(f.value)

            where_clause = f'WHERE {" AND ".join(where_parts)}' if where_parts else ''
            group_clause = f'GROUP BY {", ".join([qualify_col(d) for d in plan.dimensions])}' if plan.dimensions else ''

            order_clause = ''
            if plan.sort:
                sort_col = plan.sort.column
                matched_alias = next((m.alias for m in plan.measures if m.alias and m.alias.lower() == sort_col.lower()), None)
                if matched_alias:
                    order_clause = f'ORDER BY "{matched_alias}" {plan.sort.direction.upper()}'
                else:
                    order_clause = f'ORDER BY {qualify_col(sort_col)} {plan.sort.direction.upper()}'
            else:
                temporal_dims = [d for d in plan.dimensions if is_temporal_dimension(d)]
                if temporal_dims:
                    order_cols = [f'{qualify_col(td)} ASC' for td in temporal_dims]
                    order_clause = f'ORDER BY {", ".join(order_cols)}'
                elif plan.limit and plan.measures:
                    order_col = plan.measures[0].alias or plan.measures[0].field
                    order_clause = f'ORDER BY "{order_col}" DESC'

            limit_clause = f'LIMIT {plan.limit}' if plan.limit else ''

            from_clause = f'FROM "{target_table}" L {" ".join(join_clauses)}' if has_joins else f'FROM "{target_table}"'
            sql = ' '.join(filter(None, ['SELECT', select_clause, from_clause, where_clause, group_clause, order_clause, limit_clause]))
            raw_rows = hana_client.execute_query(sql, tuple(params))
            if raw_rows is None:
                return None

            result = AnalyticsResult()
            clean_rows = []
            for r in raw_rows:
                row_dict = {}
                for d in plan.dimensions:
                    val = r.get(d)
                    if val is None:
                        val = r.get(d.upper())
                    if val is None:
                        d_lower = d.lower()
                        for k, v in r.items():
                            if k.lower() == d_lower:
                                val = v
                                break
                    row_dict[d] = json_value(val)
                for m in plan.measures:
                    alias = m.alias or m.field
                    val = r.get(alias)
                    if val is None:
                        val = r.get(alias.upper())
                    if val is None:
                        alias_lower = alias.lower()
                        for k, v in r.items():
                            if k.lower() == alias_lower:
                                val = v
                                break
                    row_dict[alias] = json_value(val)
                clean_rows.append(row_dict)

            # Determine actual records in target HANA table dynamically
            count_rows = hana_client.execute_query(f'SELECT COUNT(*) AS CNT FROM "{target_table}"')
            total_in_db = int(count_rows[0].get("CNT") or 0) if count_rows else len(clean_rows)

            result.records_total = total_in_db
            result.records_matched = len(clean_rows) if plan.dimensions else total_in_db
            result.data = clean_rows
            result.success = True
            result.status = "success"
            result.execution_time_ms = (time.perf_counter() - start) * 1000

            if not plan.dimensions and len(plan.measures) == 1 and clean_rows:
                measure = plan.measures[0]
                val = clean_rows[0].get(measure.alias or measure.field)
                result.summary = {
                    "metric": measure.field,
                    "aggregation": measure.aggregation,
                    "value": val,
                    "formatted_value": self._format_value(val, measure.field)
                }
                result.data = [{"metric": measure.field, "aggregation": measure.aggregation, "value": val}]
            return result
        except Exception:
            return None

    def execute(self, query_plan, dataframe=None, semantic_fields=None, semantic_model=None):
        result = AnalyticsResult()
        start = time.perf_counter()
        try:
            if isinstance(query_plan, dict) and not query_plan.get("aggregation") and not query_plan.get("measures"):
                query_plan = dict(query_plan)
                query_plan["aggregation"] = "SUM"
            plan = QueryPlan.model_validate(query_plan)
            if not plan.measures and not plan.derived_metrics:
                raise ValueError("Specify the metric and aggregation; no business metric is selected automatically.")
            if dataframe is None and not plan.derived_metrics and not plan.comparison:
                hana_res = self._execute_on_hana(plan, start)
                if hana_res is not None and hana_res.success:
                    return hana_res
            if dataframe is None:
                from api.services.data_service import data_service
                target_ds_id = getattr(plan, "left_dataset_id", None) or getattr(plan, "dataset_id", None)
                if target_ds_id:
                    from api.services.dataset_service import dataset_service
                    cat = dataset_service._catalog()
                    entry = dataset_service._entry(cat, target_ds_id, for_chat=True)
                    if entry:
                        snap = dataset_service._snapshot(entry, entry.get("currentVersion", 1))
                        dataframe = dataset_service._frame(snap["rows"], snap["columns"])
                if dataframe is None:
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
                semantic_model = semantic_registry.get(selection.entry, selection.context.version, selection.context.semantic_revision, approved=True)
            if semantic_fields is None:
                if semantic_model is not None:
                    semantic_fields = {field.name: field.aggregations for field in semantic_model.fields}
            if plan.joins:
                for join in plan.joins:
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
                        df = join_service.load_joined_dataframe(
                            left_dataset_id=l_id,
                            right_dataset_id=join.right_dataset_id,
                            left_key=l_k,
                            right_key=r_k,
                            how=join.how
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
                    raise ValueError("Time grouping requires an approved date field")
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
        finally:
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
