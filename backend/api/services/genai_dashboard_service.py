"""
GenAI Dashboard Service
=======================
Implements the 10-step Dynamic Query-to-Dashboard Workflow (Analysis-First):
  Step 1  – Understand: Natural language query interpretation, intent, metrics, dimensions, filters.
  Step 2  – Explore: Dynamic schema exploration across datasets, tables, columns, types, metadata.
  Step 3  – Identify: Determine required tables, columns, metrics, dimensions, aggregations.
  Step 4  – Relate: Intelligent JOIN detection (INNER, LEFT, RIGHT, FULL OUTER) and key matching.
  Step 5  – Generate & Execute: Dynamic SQL query generation and execution against data sources.
  Step 6  – Validate: Data consistency, record count validation, join integrity, calculation safety.
  Step 7  – Analyze: Statistical analysis, pattern discovery, trend extraction, executive insights.
  Step 8  – Recommend: Proactive AI-powered widget recommendations based on actual analysis results.
  Step 9  – Render: Prepare selected KPIs, charts, and dashboard widget structures.
  Step 10 – Visualize: Interactive visual widgets and Python Matplotlib/Seaborn generation.
"""

import os
import json
import re
import time
import base64
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Generator
import pandas as pd
import numpy as np

from api.services.dataset_service import dataset_service
from api.platform.join_service import join_service
from api.services.ai_core_service import ai_core_service
from api.utils.logger import get_logger

logger = get_logger("services.genai_dashboard_service")


def _match_column_name(target_phrase: str, available_columns: List[str]) -> Optional[str]:
    """Fuzzy/semantic token matcher to map raw dumped lines to schema columns."""
    if not target_phrase or not available_columns:
        return None
    clean_target = re.sub(r'[^a-zA-Z0-9]', '', target_phrase).lower()
    if not clean_target:
        return None

    # 1. Exact clean match
    for c in available_columns:
        if re.sub(r'[^a-zA-Z0-9]', '', c).lower() == clean_target:
            return c

    # 2. Substring match
    for c in available_columns:
        c_clean = re.sub(r'[^a-zA-Z0-9]', '', c).lower()
        if clean_target in c_clean or c_clean in clean_target:
            return c

    # 3. Keyword token overlap
    target_words = set(re.findall(r'[a-zA-Z0-9]+', target_phrase.lower()))
    target_words.discard('yes')
    target_words.discard('no')
    target_words.discard('kpi')
    target_words.discard('the')
    target_words.discard('of')

    best_match = None
    best_score = 0
    for c in available_columns:
        c_words = set(re.findall(r'[a-zA-Z0-9]+', c.lower()))
        overlap = len(target_words & c_words)
        if overlap > best_score:
            best_score = overlap
            best_match = c

    if best_score > 0:
        return best_match
    return None


class GenAIDashboardService:
    """Core intelligence engine for Universal Natural Language Generative AI Dashboards."""

    def __init__(self):
        self.temp_dir: Path = Path(tempfile.gettempdir()) / "genai_dashboard_scripts"
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    # ──────────────────────────────────────────────────────────────────────────
    # Step 2: Explore Datasets & Schema
    # ──────────────────────────────────────────────────────────────────────────
    def explore_schemas(self, target_dataset_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Dynamically explore all available datasets, tables, schemas, and columns."""
        catalog = dataset_service._catalog()
        datasets = catalog.get("datasets", {})
        results = []

        for ds_id, entry in datasets.items():
            if target_dataset_id and target_dataset_id != "all" and ds_id != target_dataset_id:
                continue

            from api.models.execution_context import require_dataset_access, current_selection
            from fastapi import HTTPException
            try:
                require_dataset_access(entry)
            except HTTPException:
                continue

            current_ver = entry.get("currentVersion", 1)
            selection = current_selection.get()
            if selection and selection.context.dataset_id == ds_id:
                current_ver = selection.context.version
                snapshot = selection.snapshot
            else:
                snapshot = dataset_service._snapshot(entry, current_ver)
            columns = snapshot.get("columns", []) if snapshot else entry.get("columns", [])
            row_count = entry.get("rowCount", len(snapshot.get("rows", [])) if snapshot else 0)

            results.append({
                "dataset_id": ds_id,
                "table_name": entry.get("name", ds_id),
                "description": entry.get("description", ""),
                "row_count": row_count,
                "columns": [
                    {
                        "name": c.get("name"),
                        "type": c.get("type", "string"),
                        "role": c.get("role", "dimension" if c.get("type") in ("string", "text") else "measure"),
                    }
                    for c in columns
                ],
            })

        return results

    # ──────────────────────────────────────────────────────────────────────────
    # Step 1, 3, 4: Understand, Identify, Relate (LLM Reasoning Layer)
    # ──────────────────────────────────────────────────────────────────────────
    def _interpret_query_with_llm(
        self,
        prompt: str,
        schemas: List[Dict[str, Any]],
        conversation_history: Optional[List[Dict[str, str]]] = None,
        target_dataset_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        LLM understands user intent, explores schemas, selects tables, determines JOIN strategy,
        and generates dynamic SQL. Robustly supports raw dumped field lists.
        """
        history_text = ""
        if conversation_history:
            history_text = "\nPrior Conversation Context:\n" + "\n".join(
                f"- {item.get('role', 'user')}: {item.get('content', '')}" for item in conversation_history[-4:]
            )

        schema_summary = []
        for s in schemas:
            cols = [f"{c['name']} ({c['type']}, {c['role']})" for c in s["columns"][:35]]
            schema_summary.append(
                f"Table '{s['table_name']}' (ID: {s['dataset_id']}, {s['row_count']} rows):\n  Columns: {', '.join(cols)}"
            )
        schemas_str = "\n\n".join(schema_summary)

        llm_prompt = f"""You are the Universal Data Analytics & Dashboard Intelligence Engine.
Understand the user's natural language analytical request, inspect available database schemas, determine if a JOIN is required, and formulate dynamic KPIs, charts, and SQL.

Available Database Tables & Schemas:
{schemas_str}
{history_text}

User Request:
"{prompt}"

CRITICAL INSTRUCTIONS:
1. RAW / DUMPED FIELD LIST HANDLING:
   If the user provides a list of raw metrics, KPIs, or field names (e.g. project start date, project end date, delayed days, overall percentage completion, milestone completion, open issues, weekly comments, current phase, RAG status, escalation required):
   - You MUST identify and map EVERY requested item to an appropriate KPI card or dynamic chart or data table based on the actual columns in the schema.
   - For count of records / items (e.g. "Count of Projects", "Total Projects"): set metric to primary key/identifier (e.g. Project_ID) with aggregation="COUNT", format="integer".
   - For numeric metrics (e.g. "Delayed days", "Open issues", "Overall percentage completion"): create KPI cards with aggregation="AVG" or "SUM" and format="number" or "percent" or "integer".
   - For categorical status fields (e.g. "RAG Status", "Current Phase", "Escalation Required", "Current Stage"): create dynamic charts (donut, bar, or pie) with dimension=Field_Name and metric="Project_ID" (or primary key), aggregation="COUNT".
2. If the user refers to metrics and dimensions across different tables, identify if an INNER JOIN, LEFT JOIN, RIGHT JOIN, or FULL OUTER JOIN is needed.
3. If information is in a single table, do NOT add a join.
4. Generate EXACTLY the requested number of KPIs and charts. For a KPI-only request return charts=[]. For a chart-only request return kpis=[]. Preserve requested fields, filters, calculations and chart types. Never add generic metrics to a specific request.
5. Only use columns present in the schema. Use numeric aggregations only on numeric measures. Infer no currency without explicit evidence. Include filters in the plan.
6. Specify python_visual only when Python, Matplotlib or Seaborn is explicitly requested; otherwise use null.
7. Generate a clean standard SQL query representing the core aggregation.

Respond with ONLY a valid JSON object strictly matching this JSON schema:
{{
  "intent_summary": "Concise 1-sentence summary of user's analytical goal",
  "target_datasets": ["dataset_id_1"],
  "join_required": false,
  "join_type": "LEFT JOIN",
  "join_rationale": "",
  "left_dataset_id": null,
  "right_dataset_id": null,
  "left_key": null,
  "right_key": null,
  "sql_query": "SELECT Dimension, SUM(Metric) AS Total FROM Table GROUP BY Dimension ORDER BY Total DESC",
  "primary_metric": "ColumnName",
  "primary_dimension": "ColumnName",
  "filters": [],
  "kpis": [
    {{
      "id": "kpi_1",
      "title": "Total Metric",
      "metric": "ColumnName",
      "aggregation": "SUM",
      "format": "currency | number | percent | integer",
      "subtitle": "Overview"
    }}
  ],
  "charts": [
    {{
      "id": "chart_1",
      "title": "Metric by Dimension",
      "kind": "bar | donut | line | area",
      "metric": "ColumnName",
      "dimension": "ColumnName",
      "aggregation": "COUNT | SUM | AVG"
    }}
  ],
  "python_visual": {{
    "chart_type": "heatmap | bar | box | countplot",
    "prompt": "Visualization description for Matplotlib/Seaborn"
  }}
}}
JSON:"""

        try:
            raw_response = ai_core_service.generate_structured_completion(
                llm_prompt,
                max_tokens=2500,
                temperature=0.1,
                timeout=18,
            )
            if raw_response:
                clean_json = raw_response.strip()
                if "```json" in clean_json:
                    clean_json = clean_json.split("```json")[1].split("```")[0].strip()
                elif "```" in clean_json:
                    clean_json = clean_json.split("```")[1].split("```")[0].strip()
                parsed = json.loads(clean_json)
                return parsed
        except Exception as exc:
            logger.warning(f"[GenAIDashboardService] LLM parsing failed or timed out: {exc}. Using heuristic engine.")

        # Heuristic / Algorithmic Fallback Engine
        return self._heuristic_query_interpretation(prompt, schemas, target_dataset_id)

    def _heuristic_query_interpretation(
        self,
        prompt: str,
        schemas: List[Dict[str, Any]],
        target_dataset_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Robust deterministic fallback when LLM is unavailable."""
        if not schemas:
            raise ValueError("No datasets available for analysis.")

        # Select primary schema
        primary = schemas[0]
        if target_dataset_id and target_dataset_id != "all":
            matched = next((s for s in schemas if s["dataset_id"] == target_dataset_id), None)
            if matched:
                primary = matched

        cols = primary["columns"]
        all_cols_flat: List[str] = []
        for s in schemas:
            all_cols_flat.extend([c["name"] for c in s.get("columns", [])])

        numeric_cols = [c["name"] for c in cols if c["role"] == "measure" or c["type"] in ("number", "decimal", "integer")]
        dim_cols = [c["name"] for c in cols if c["role"] == "dimension" or c["type"] in ("string", "text", "category")]
        id_cols = [c["name"] for c in cols if c["role"] == "identifier" or "id" in c["name"].lower()]
        time_cols = [c["name"] for c in cols if c["type"] in ("date", "time", "datetime") or "date" in c["name"].lower() or "year" in c["name"].lower()]
        named_numeric = [c for c in numeric_cols if re.search(r'\b' + re.escape(c).replace('_', r'[_\s]') + r'\b', prompt, re.I)]
        named_dimensions = [c for c in dim_cols if re.search(r'\b' + re.escape(c).replace('_', r'[_\s]') + r'\b', prompt, re.I)]
        numeric_cols = named_numeric + [c for c in numeric_cols if c not in named_numeric]
        dim_cols = named_dimensions + [c for c in dim_cols if c not in named_dimensions]

        # Check for multi-table join if multiple datasets exist
        join_required = False
        join_type = "LEFT JOIN"
        join_rationale = ""
        left_ds_id = primary["dataset_id"]
        right_ds_id = None
        left_key = None
        right_key = None

        if len(schemas) > 1 and (target_dataset_id is None or target_dataset_id == "all"):
            for other in schemas:
                if other["dataset_id"] != primary["dataset_id"]:
                    res = join_service.resolve_join(primary["dataset_id"], other["dataset_id"])
                    if res.get("joinable"):
                        join_required = True
                        right_ds_id = other["dataset_id"]
                        left_key = res.get("left_key")
                        right_key = res.get("right_key")
                        join_rationale = f"Joined on key relation {left_key} = {right_key}"
                        for c in other.get("columns", []):
                            if c["name"] not in [x["name"] for x in cols]:
                                cols.append(c)
                        break

        # Check if the prompt is a raw dumped list
        lines = [line.strip() for line in prompt.split("\n") if line.strip() and line.strip().lower() != "kpi"]
        is_dumped = len(lines) >= 3

        kpis = []
        charts = []

        if is_dumped:
            # Map each raw item to columns
            assigned_kpis = 0
            assigned_charts = 0

            for line in lines:
                matched_col = _match_column_name(line, [c["name"] for c in cols])
                if not matched_col:
                    continue

                col_info = next((c for c in cols if c["name"] == matched_col), None)
                col_type = col_info.get("type", "string") if col_info else "string"
                col_role = col_info.get("role", "dimension") if col_info else "dimension"

                # Numeric or percentage -> KPI
                if col_type in ("number", "decimal", "integer") or col_role == "measure" or any(w in line.lower() for w in ("days", "percentage", "completion", "issues", "delay", "count")):
                    agg = "AVG" if any(w in line.lower() for w in ("average", "percentage", "rate", "completion", "delay")) else "SUM"
                    fmt = "percent" if "percentage" in line.lower() or "percent" in line.lower() or "%" in line else ("integer" if "issue" in line.lower() or "count" in line.lower() else "number")
                    kpis.append({
                        "id": f"kpi_{assigned_kpis + 1}",
                        "title": line.title(),
                        "metric": matched_col,
                        "aggregation": agg,
                        "format": fmt,
                        "subtitle": f"{agg} across portfolio"
                    })
                    assigned_kpis += 1
                elif col_role in ("dimension", "category") or col_type in ("string", "text"):
                    id_metric = id_cols[0] if id_cols else "*"
                    charts.append({
                        "id": f"chart_{assigned_charts + 1}",
                        "title": f"Projects by {line.title()}",
                        "kind": "donut" if assigned_charts % 2 == 0 else "bar",
                        "metric": id_metric,
                        "dimension": matched_col,
                        "aggregation": "COUNT"
                    })
                    assigned_charts += 1

            # Ensure portfolio count KPI is included
            if id_cols and not any(k["metric"] == id_cols[0] for k in kpis):
                kpis.insert(0, {
                    "id": f"kpi_total",
                    "title": "Total Projects Count",
                    "metric": id_cols[0],
                    "aggregation": "COUNT",
                    "format": "integer",
                    "subtitle": "Total tracked in portfolio"
                })

        # Fallback if no items matched from dumped or for standard natural language prompts
        if not kpis:
            primary_metric = numeric_cols[0] if numeric_cols else (id_cols[0] if id_cols else cols[0]["name"])
            kpis = [
                {
                    "id": "kpi_1",
                    "title": f"Total {primary_metric}",
                    "metric": primary_metric,
                    "aggregation": "COUNT" if primary_metric in id_cols else "SUM",
                    "format": "integer" if primary_metric in id_cols else "number",
                    "subtitle": f"Portfolio aggregate"
                }
            ]
            if len(numeric_cols) > 1:
                kpis.append({
                    "id": "kpi_2",
                    "title": f"Average {numeric_cols[1]}",
                    "metric": numeric_cols[1],
                    "aggregation": "AVG",
                    "format": "number",
                    "subtitle": "Portfolio mean"
                })

        if not charts:
            primary_dim = dim_cols[0] if dim_cols else (cols[1]["name"] if len(cols) > 1 else cols[0]["name"])
            chart_metric = id_cols[0] if id_cols else (numeric_cols[0] if numeric_cols else cols[0]["name"])
            charts.append({
                "id": "chart_1",
                "title": f"Distribution by {primary_dim}",
                "kind": "bar",
                "metric": chart_metric,
                "dimension": primary_dim,
                "aggregation": "COUNT" if chart_metric in id_cols else "SUM"
            })

        from api.platform.widget_contract import requested_counts
        counts = requested_counts(prompt)
        if counts.get('kpis', 0) > 0 and named_numeric and not is_dumped:
            kpis = []
            for index, column in enumerate(named_numeric):
                position = re.search(re.escape(column).replace('_', r'[_\s]'), prompt, re.I).start()
                preceding = prompt[max(0, position - 24):position].casefold()
                agg = 'AVG' if re.search(r'\b(average|mean|avg)\s*(?:of\s*)?$', preceding) else 'SUM'
                kpis.append({'id': f'kpi_{index + 1}', 'title': f'{agg} {column}', 'metric': column,
                             'aggregation': agg, 'format': 'number'})
        if named_dimensions:
            for chart in charts:
                chart['dimension'] = named_dimensions[0]
                if named_numeric:
                    chart['metric'] = named_numeric[0]
                    chart['aggregation'] = 'AVG' if re.search(r'\b(average|mean|avg)\b', prompt, re.I) else 'SUM'
                kind = re.search(r'\b(bar|line|pie|donut|area)\s+chart', prompt, re.I)
                if kind:
                    chart['kind'] = kind.group(1).lower()
                chart['title'] = f"{chart['aggregation']} {chart['metric']} by {chart['dimension']}"
        table_name = primary["table_name"]
        primary_metric = kpis[0]["metric"]
        primary_dim = charts[0]["dimension"]

        sql_query = f"SELECT {primary_dim}, COUNT(*) AS ProjectCount FROM {table_name} GROUP BY {primary_dim} ORDER BY ProjectCount DESC"

        return {
            "intent_summary": f"Analytical dashboard evaluating {len(kpis)} KPI metrics and {len(charts)} distribution charts across {table_name}",
            "target_datasets": [primary["dataset_id"]] if not right_ds_id else [primary["dataset_id"], right_ds_id],
            "join_required": join_required,
            "join_type": join_type,
            "join_rationale": join_rationale,
            "left_dataset_id": left_ds_id,
            "right_dataset_id": right_ds_id,
            "left_key": left_key,
            "right_key": right_key,
            "sql_query": sql_query,
            "primary_metric": primary_metric,
            "primary_dimension": primary_dim,
            "kpis": kpis[:6],
            "charts": charts[:4],
            "python_visual": {
                "chart_type": "bar",
                "prompt": f"Render distribution analysis across {primary_dim}"
            }
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Step 5 & 6: Generate & Execute, Validate Data
    # ──────────────────────────────────────────────────────────────────────────
    def _load_data_frame(self, plan: Dict[str, Any], schemas: List[Dict[str, Any]]) -> Tuple[pd.DataFrame, int, Optional[Dict[str, Any]]]:
        """Loads single table DataFrame or joined DataFrame based on join decision."""
        catalog = dataset_service._catalog()
        datasets = catalog.get("datasets", {})

        target_ids = plan.get("target_datasets", [])
        primary_id = target_ids[0] if target_ids else schemas[0]["dataset_id"]

        join_info = None
        df: Optional[pd.DataFrame] = None

        if plan.get("join_required") and plan.get("right_dataset_id"):
            l_id = plan.get("left_dataset_id") or primary_id
            r_id = plan.get("right_dataset_id")
            l_k = plan.get("left_key")
            r_k = plan.get("right_key")
            how = "left" if "LEFT" in plan.get("join_type", "LEFT") else ("inner" if "INNER" in plan.get("join_type", "") else "outer")

            try:
                if not l_k or not r_k:
                    res = join_service.resolve_join(l_id, r_id)
                    if res.get("joinable"):
                        l_k = res["left_key"]
                        r_k = res["right_key"]

                if l_k and r_k:
                    df = join_service.load_joined_dataframe(l_id, r_id, l_k, r_k, how=how)
                    join_info = {
                        "left_dataset_id": l_id,
                        "right_dataset_id": r_id,
                        "left_key": l_k,
                        "right_key": r_k,
                        "join_type": plan.get("join_type", "LEFT JOIN"),
                        "row_count": len(df),
                        "joinable": True
                    }
                    logger.info(f"[GenAIDashboardService] Merged {l_id} and {r_id} on {l_k}={r_k} ({len(df)} rows)")
            except Exception as e:
                logger.warning(f"[GenAIDashboardService] Join execution failed: {e}. Falling back to primary dataset.")
                raise ValueError("Requested join could not be executed") from e

        if df is None:
            entry = dataset_service._entry(catalog, primary_id)
            if entry:
                from api.models.execution_context import current_selection
                from api.platform.data_resolution import dataset_frame
                selection = current_selection.get()
                v = selection.context.version if selection and selection.context.dataset_id == primary_id else entry.get("currentVersion", 1)
                snap = selection.snapshot if selection and selection.context.dataset_id == primary_id else dataset_service._snapshot(entry, v)
                if snap:
                    df = dataset_frame(entry, snap, v)

        if df is None:
            raise ValueError('No complete dataset is available for this request')

        records_total = len(df)
        return df, records_total, join_info

    def _execute_aggregations(
        self,
        df: pd.DataFrame,
        kpi_specs: List[Dict[str, Any]],
        chart_specs: List[Dict[str, Any]],
        filters: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        Executes actual metric calculations and chart groupings against the DataFrame.
        Correctly handles non-numeric columns for COUNT and string values with symbols.
        """
        filtered_df = df.copy()
        allowed = {'SUM', 'AVG', 'MEAN', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT', 'DISTINCT'}
        for spec in kpi_specs + chart_specs:
            metric = spec.get('metric', '*')
            if metric != '*' and metric not in df.columns:
                match = next((c for c in df.columns if str(c).casefold() == str(metric).casefold()), None)
                if match is None:
                    raise ValueError(f"Unknown metric: {metric}")
                spec['metric'] = metric = match
            agg = str(spec.get('aggregation', 'SUM')).upper()
            if agg not in allowed or (metric == '*' and agg != 'COUNT'):
                raise ValueError(f"Unsupported aggregation {agg} for {metric}")
            if spec in chart_specs and spec.get('dimension') not in df.columns:
                raise ValueError(f"Unknown chart dimension: {spec.get('dimension')}")
            if agg not in {'COUNT', 'COUNT_DISTINCT', 'DISTINCT'}:
                values = df[metric]
                numeric = pd.to_numeric(values, errors='coerce')
                if (values.notna() & numeric.isna()).any():
                    raise ValueError(f"{agg} requires a numeric metric: {metric}")

        # Apply basic filters if specified
        if filters:
            from api.models.query_plan import Filter
            filters = [Filter.model_validate({**condition, 'operator': {'==': '=', 'eq': '='}.get(condition.get('operator'), condition.get('operator', '='))}).model_dump() for condition in filters]
            for f in filters:
                col = f.get("column")
                op = f.get("operator", "==")
                val = f.get("value")
                if col in filtered_df.columns and (val is not None or op in ('IS_NULL', 'NOT_NULL')):
                    try:
                        if op in ("==", "=", "eq"):
                            filtered_df = filtered_df[filtered_df[col] == val]
                        elif op == "!=":
                            filtered_df = filtered_df[filtered_df[col] != val]
                        elif op == ">":
                            filtered_df = filtered_df[filtered_df[col] > float(val)]
                        elif op == "<":
                            filtered_df = filtered_df[filtered_df[col] < float(val)]
                        elif op == ">=":
                            filtered_df = filtered_df[filtered_df[col] >= float(val)]
                        elif op == "<=":
                            filtered_df = filtered_df[filtered_df[col] <= float(val)]
                        elif op == 'IN':
                            filtered_df = filtered_df[filtered_df[col].isin(val)]
                        elif op == 'CONTAINS':
                            filtered_df = filtered_df[filtered_df[col].astype('string').str.contains(str(val), regex=False, case=False, na=False)]
                        elif op == 'IS_NULL':
                            filtered_df = filtered_df[filtered_df[col].isna()]
                        elif op == 'NOT_NULL':
                            filtered_df = filtered_df[filtered_df[col].notna()]
                        else:
                            raise ValueError(f"Unsupported filter operator: {op}")
                    except Exception as exc:
                        raise ValueError(f"Invalid filter for {col}") from exc
                else:
                    raise ValueError(f"Unknown filter column or missing value: {col}")

        records_matched = len(filtered_df)

        # 1. Compute KPIs
        kpi_results = []
        for spec in kpi_specs:
            metric = spec.get("metric", "*")
            agg = spec.get("aggregation", "SUM").upper()
            title = spec.get("title", metric)
            fmt = spec.get("format", "number")

            # Try case-insensitive matching if metric not found
            if metric != "*" and metric not in filtered_df.columns:
                m_match = next((c for c in filtered_df.columns if c.lower() == str(metric).lower()), None)
                if m_match:
                    metric = m_match

            val: Any = 0
            if metric == "*" or metric not in filtered_df.columns:
                val = len(filtered_df)
            else:
                if agg == "COUNT":
                    # For COUNT: Count non-null rows without converting strings to NaN!
                    val = int(filtered_df[metric].dropna().count())
                elif agg in ("COUNT_DISTINCT", "DISTINCT"):
                    val = int(filtered_df[metric].dropna().nunique())
                else:
                    # Clean currency/percentage formatting before numeric conversion
                    clean_series = filtered_df[metric]
                    if clean_series.dtype == object or str(clean_series.dtype).startswith('string'):
                        clean_series = clean_series.astype(str).str.replace(r'[\$,%]', '', regex=True)
                    series = pd.to_numeric(clean_series, errors="coerce").dropna()

                    if agg == "SUM":
                        val = float(series.sum()) if not series.empty else 0
                    elif agg in ("AVG", "MEAN"):
                        val = float(series.mean()) if not series.empty else 0
                    elif agg == "MIN":
                        val = float(series.min()) if not series.empty else 0
                    elif agg == "MAX":
                        val = float(series.max()) if not series.empty else 0
                    else:
                        val = float(series.sum()) if not series.empty else 0

            kpi_results.append({
                "id": spec.get("id"),
                "title": title,
                "value": round(val, 2) if isinstance(val, float) else val,
                "metric": metric,
                "aggregation": agg,
                "format": fmt,
                "subtitle": spec.get("subtitle", f"{agg} across portfolio"),
                "query_plan": {"metric": metric, "aggregation": agg, "filters": filters or []},
            })

        # 2. Compute Charts
        chart_results = []
        for spec in chart_specs:
            metric = spec.get("metric", "*")
            dim = spec.get("dimension")
            agg = spec.get("aggregation", "COUNT").upper()
            kind = spec.get("kind", "bar")
            title = spec.get("title", f"{metric} by {dim}")

            # Case-insensitive resolution
            if dim not in filtered_df.columns:
                dim_match = next((c for c in filtered_df.columns if c.lower() == str(dim).lower()), None)
                dim = dim_match or (filtered_df.columns[0] if len(filtered_df.columns) > 0 else "Category")

            if metric != "*" and metric not in filtered_df.columns:
                m_match = next((c for c in filtered_df.columns if c.lower() == str(metric).lower()), None)
                metric = m_match or metric

            try:
                data_points = []
                if agg in ("COUNT", "COUNT_DISTINCT", "DISTINCT"):
                    # Frequency distribution by dimension
                    if agg in ("COUNT_DISTINCT", "DISTINCT") and metric != "*" and metric in filtered_df.columns and metric != dim:
                        grouped = filtered_df.groupby(dim, as_index=False)[metric].nunique()
                        grouped.columns = [dim, "count"]
                    elif metric != '*':
                        grouped = filtered_df.groupby(dim, dropna=False)[metric].count().reset_index()
                        grouped.columns = [dim, "count"]
                    else:
                        grouped = filtered_df.groupby(dim, dropna=False).size().reset_index()
                        grouped.columns = [dim, "count"]

                    grouped = grouped.sort_values(by="count", ascending=False).head(15)
                    for _, row in grouped.iterrows():
                        d_val = str(row[dim])
                        if d_val in ("nan", "None", ""):
                            d_val = "Unassigned"
                        m_val = int(row["count"])
                        data_points.append({"label": d_val, "value": m_val, dim: d_val, metric: m_val})
                else:
                    # Numeric aggregation
                    temp_df = filtered_df[[dim, metric]].copy()
                    if temp_df[metric].dtype == object or str(temp_df[metric].dtype).startswith('string'):
                        temp_df[metric] = temp_df[metric].astype(str).str.replace(r'[\$,%]', '', regex=True)
                    temp_df[metric] = pd.to_numeric(temp_df[metric], errors="coerce")
                    temp_df = temp_df.dropna()

                    if agg == "SUM":
                        grouped = temp_df.groupby(dim, as_index=False)[metric].sum()
                    elif agg in ("AVG", "MEAN"):
                        grouped = temp_df.groupby(dim, as_index=False)[metric].mean()
                    elif agg == "MIN":
                        grouped = temp_df.groupby(dim, as_index=False)[metric].min()
                    elif agg == "MAX":
                        grouped = temp_df.groupby(dim, as_index=False)[metric].max()
                    else:
                        grouped = temp_df.groupby(dim, as_index=False)[metric].sum()

                    grouped = grouped.sort_values(by=metric, ascending=False).head(15)
                    for _, row in grouped.iterrows():
                        d_val = str(row[dim])
                        m_val = round(float(row[metric]), 2)
                        data_points.append({"label": d_val, "value": m_val, dim: d_val, metric: m_val})

                chart_results.append({
                    "id": spec.get("id"),
                    "title": title,
                    "kind": kind,
                    "metric": metric,
                    "dimension": dim,
                    "aggregation": agg,
                    "data": data_points,
                    "total_categories": len(data_points),
                    "query_plan": {"metric": metric, "dimension": dim, "aggregation": agg, "filters": filters or []},
                })
            except Exception as e:
                raise ValueError(f"Chart computation failed for {title}") from e

        return {
            "records_matched": records_matched,
            "kpis": kpi_results,
            "charts": chart_results,
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Step 7: Analyze Results & Synthesize Executive Insights
    # ──────────────────────────────────────────────────────────────────────────
    def _synthesize_insights(
        self,
        prompt: str,
        kpis: List[Dict[str, Any]],
        charts: List[Dict[str, Any]],
        records_matched: int,
        records_total: int
    ) -> List[str]:
        """Produces domain-independent data-driven executive findings based on real computed numbers."""
        kpi_summaries = [f"{k['title']}: {k['value']} ({k.get('format', 'number')})" for k in kpis]
        chart_top_items = []
        for c in charts:
            data = c.get("data", [])
            if data:
                top = data[0]
                bottom = data[-1] if len(data) > 1 else top
                chart_top_items.append(
                    f"Chart '{c['title']}': Top category is '{top.get('label')}' with {top.get('value')}; Lowest is '{bottom.get('label')}' with {bottom.get('value')}."
                )

        insights_prompt = f"""You are a Principal Data Analyst and Executive BI Advisor.
Analyze the following actual calculated query results and generate 3 to 4 concise, high-impact analytical takeaways.

User Query: "{prompt}"
Records Matched: {records_matched} of {records_total} total records.
Calculated KPIs: {', '.join(kpi_summaries)}
Chart Distributions:
{chr(10).join(chart_top_items)}

Rules:
- State direct factual observations backed by the numbers above.
- Mention concentration, percentage distribution, top performers, and anomalies where evident.
- Output ONLY a JSON array of strings: ["Insight 1", "Insight 2", "Insight 3"]
JSON:"""

        try:
            raw = ai_core_service.generate_structured_completion(insights_prompt, max_tokens=600, temperature=0.2, timeout=8)
            if raw:
                clean = raw.strip()
                if "```json" in clean:
                    clean = clean.split("```json")[1].split("```")[0].strip()
                elif "```" in clean:
                    clean = clean.split("```")[1].split("```")[0].strip()
                parsed = json.loads(clean)
                if isinstance(parsed, list) and parsed:
                    return [str(p) for p in parsed[:4]]
        except Exception:
            pass

        # Deterministic Insight Synthesis Fallback
        insights = []
        if kpis:
            first_kpi = kpis[0]
            insights.append(f"{first_kpi['title']} reached {first_kpi['value']} across {records_matched:,} validated records.")
        if charts and charts[0].get("data"):
            top = charts[0]["data"][0]
            insights.append(f"Leading category in {charts[0]['dimension']} is '{top.get('label')}' with a count of {top.get('value'):,}.")
        if len(charts) > 1 and charts[1].get("data"):
            c2 = charts[1]
            total_v = sum(d.get("value", 0) for d in c2["data"])
            if total_v > 0:
                top_pct = round((c2["data"][0].get("value", 0) / total_v) * 100, 1)
                insights.append(f"Distribution analysis reveals '{c2['data'][0].get('label')}' accounts for {top_pct}% of evaluated items.")
        if records_matched > 0:
            insights.append(f"Scope verified across {records_matched:,} active records without data multiplication.")

        return insights

    # ──────────────────────────────────────────────────────────────────────────
    # Step 8: Proactive AI-Powered Widget Recommendations
    # ──────────────────────────────────────────────────────────────────────────
    def _generate_proactive_recommendations(
        self,
        prompt: str,
        schemas: List[Dict[str, Any]],
        executed_kpis: List[Dict[str, Any]],
        executed_charts: List[Dict[str, Any]],
        df: pd.DataFrame
    ) -> List[Dict[str, Any]]:
        """
        Analysis-First: Proactively recommends complementary widgets based on the completed analysis
        and remaining dimensions/measures.
        """
        used_dims = {c.get("dimension") for c in executed_charts if c.get("dimension")}
        used_metrics = {k.get("metric") for k in executed_kpis if k.get("metric")} | {c.get("metric") for c in executed_charts if c.get("metric")}

        all_cols = []
        for s in schemas:
            all_cols.extend(s.get("columns", []))

        unused_dims = [c["name"] for c in all_cols if c["role"] == "dimension" and c["name"] not in used_dims and c["name"] in df.columns]
        unused_metrics = [c["name"] for c in all_cols if c["role"] == "measure" and c["name"] not in used_metrics and c["name"] in df.columns]

        rec_prompt = f"""You are the Proactive AI BI Recommendation Advisor.
Based on the completed analysis for: "{prompt}", propose 3 complementary widgets that provide new, valuable analytical angles not yet shown.

Current Active KPIs: {', '.join(k['title'] for k in executed_kpis)}
Current Active Charts: {', '.join(c['title'] for c in executed_charts)}
Available Candidate Dimensions: {', '.join(unused_dims[:10])}
Available Candidate Measures: {', '.join(unused_metrics[:10])}

Output ONLY a JSON array of 3 recommendation objects:
[
  {{
    "id": "rec_1",
    "title": "Widget Title",
    "kind": "bar | donut | line | area | kpi",
    "metric": "ColumnName",
    "dimension": "ColumnName",
    "aggregation": "SUM | AVG | COUNT",
    "rationale": "Why this complementary view is valuable to the user"
  }}
]
JSON:"""

        try:
            raw = ai_core_service.generate_structured_completion(rec_prompt, max_tokens=1000, temperature=0.3, timeout=10)
            if raw:
                clean = raw.strip()
                if "```json" in clean:
                    clean = clean.split("```json")[1].split("```")[0].strip()
                elif "```" in clean:
                    clean = clean.split("```")[1].split("```")[0].strip()
                parsed = json.loads(clean)
                if isinstance(parsed, list) and len(parsed) > 0:
                    for i, r in enumerate(parsed):
                        r["id"] = r.get("id") or f"rec_{i+1}"
                        r["status"] = "recommended"
                    return parsed[:4]
        except Exception:
            pass

        # Deterministic Recommendations Fallback
        recommendations = []
        metric_pool = unused_metrics if unused_metrics else [c["name"] for c in all_cols if c["role"] == "measure"]
        dim_pool = unused_dims if unused_dims else [c["name"] for c in all_cols if c["role"] == "dimension"]

        m1 = metric_pool[0] if metric_pool else "Delay_Days"
        m2 = metric_pool[1] if len(metric_pool) > 1 else m1
        d1 = dim_pool[0] if dim_pool else "RAG_Status"
        d2 = dim_pool[1] if len(dim_pool) > 1 else d1

        recommendations.append({
            "id": "rec_1",
            "title": f"Secondary Breakdown: {m1} by {d1}",
            "kind": "donut",
            "metric": m1,
            "dimension": d1,
            "aggregation": "COUNT" if d1 == m1 else "AVG",
            "rationale": f"Provides proportional composition across {d1} to detect risk concentration.",
            "status": "recommended"
        })
        recommendations.append({
            "id": "rec_2",
            "title": f"Variance Index: Maximum {m2}",
            "kind": "kpi",
            "metric": m2,
            "aggregation": "MAX",
            "rationale": "Highlights peak single-record magnitude across the active dataset.",
            "status": "recommended"
        })
        recommendations.append({
            "id": "rec_3",
            "title": f"Performance Velocity: {m1} across {d2}",
            "kind": "bar",
            "metric": m1,
            "dimension": d2,
            "aggregation": "COUNT",
            "rationale": f"Evaluates milestone distribution across {d2}.",
            "status": "recommended"
        })

        return recommendations

    # ──────────────────────────────────────────────────────────────────────────
    # Step 10: Generate Python Visualization (Seaborn / Matplotlib on Actual DataFrame)
    # ──────────────────────────────────────────────────────────────────────────
    def _generate_python_visualization(
        self,
        py_spec: Dict[str, Any],
        user_prompt: str,
        df: pd.DataFrame,
        dataset_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Render the application-owned Matplotlib/Seaborn template on the actual frame.
        User text remains plotting data and never becomes executable script source.
        """
        if df is None or df.empty:
            return None

        # Render the existing application-owned template directly. Request titles and
        # column names stay data; they are never interpolated into executable Python.
        try:
            import io
            import seaborn as sns
            from matplotlib.figure import Figure
            from matplotlib.backends.backend_agg import FigureCanvasAgg
            chart_type = py_spec.get("chart_type", "bar").lower()
            sub_prompt = py_spec.get("prompt") or f"Visual analysis for: {user_prompt}"
            num_cols = [c for c in df.select_dtypes(include=["number"]).columns if not str(c).lower().endswith("id")]
            cat_cols = [c for c in df.select_dtypes(include=["object", "string"]).columns if not str(c).lower().endswith("id")]
            plot_cat = cat_cols[0] if cat_cols else (df.columns[0] if len(df.columns) else "")
            plot_num = num_cols[0] if num_cols else (cat_cols[1] if len(cat_cols) > 1 else plot_cat)
            for column in df.columns:
                if column.lower() in sub_prompt.lower() or column.lower().replace("_", " ") in sub_prompt.lower():
                    if column in cat_cols:
                        plot_cat = column
                    elif column in num_cols:
                        plot_num = column
            figure = Figure(figsize=(10, 5.2), dpi=150)
            FigureCanvasAgg(figure)
            axis = figure.subplots()
            if (chart_type == "heatmap" or "correlation" in chart_type) and len(num_cols) >= 2:
                sns.heatmap(df[num_cols].corr(numeric_only=True), annot=True, cmap="Blues", fmt=".2f",
                            cbar=True, square=True, ax=axis, linewidths=0.5)
                axis.set_title(f"Correlation Matrix ({user_prompt[:35]})", fontsize=12, fontweight="bold", pad=12)
            elif plot_cat and plot_cat in df.columns:
                top = df[plot_cat].value_counts().head(10)
                bars = axis.bar([str(x) for x in top.index], top.values, color=sns.color_palette("Blues_r", len(top)),
                                edgecolor="#1e3a8a", linewidth=0.8)
                for bar in bars:
                    height = bar.get_height()
                    axis.annotate(str(int(height)), (bar.get_x() + bar.get_width() / 2, height), ha="center",
                                  va="bottom", fontsize=9, fontweight="bold", xytext=(0, 3), textcoords="offset points")
                axis.set_title(sub_prompt[:60], fontsize=11, fontweight="bold", pad=12)
                axis.set_xlabel(plot_cat, fontweight="bold", fontsize=10)
                axis.set_ylabel("Count of Records", fontweight="bold", fontsize=10)
                axis.tick_params(axis="x", rotation=25)
            elif plot_num and plot_num in df.columns:
                sns.histplot(df[plot_num].dropna(), kde=True, color="#2563eb", ax=axis)
                axis.set_title(sub_prompt[:60], fontsize=11, fontweight="bold", pad=12)
                axis.set_xlabel(plot_num, fontweight="bold", fontsize=10)
            else:
                raise ValueError('No supported columns are available for this visualization')
            figure.tight_layout()
            output = io.BytesIO()
            figure.savefig(output, format="png", dpi=150, bbox_inches="tight")
            return {"image_base64": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"),
                    "chart_type": chart_type, "prompt": sub_prompt, "verified": True,
                    "insights": f"Visual distribution rendered via Seaborn on {len(df)} validated dataset records."}
        except Exception as exc:
            logger.warning("[GenAIDashboardService] Visualization failed (%s)", type(exc).__name__, exc_info=True)
            return None

    # ──────────────────────────────────────────────────────────────────────────
    # SSE Stream Generator: Real-time Step-by-Step Execution
    # ──────────────────────────────────────────────────────────────────────────
    def generate_dashboard_stream(
        self,
        prompt: str,
        target_dataset_id: Optional[str] = None,
        conversation_history: Optional[List[Dict[str, str]]] = None,
    ) -> Generator[Dict[str, Any], None, None]:
        """Yields real-time step events (1-10) for streaming loaders."""
        start_time = time.time()
        workflow_steps = []

        def step_event(num: int, name: str, detail: str) -> Dict[str, Any]:
            event = {
                "type": "step",
                "step": num,
                "name": name,
                "detail": detail,
                "timestamp": round((time.time() - start_time) * 1000, 1),
            }
            workflow_steps.append({**event, 'status': 'completed'})
            return event

        # Step 1
        yield step_event(1, "Understand", f"Interpreting conversational intent and requested metrics for '{prompt[:45]}...'")

        # Step 2
        schemas = self.explore_schemas(target_dataset_id)
        yield step_event(2, "Explore", f"Dynamically inspected {len(schemas)} dataset schema(s) and metadata.")

        # Step 3
        plan = self._interpret_query_with_llm(prompt, schemas, conversation_history, target_dataset_id)
        from api.platform.widget_contract import requested_counts, widget_signature
        for key, count in requested_counts(prompt).items():
            candidates = plan.get(key) or []
            if len(candidates) < count:
                raise ValueError(f"Could not resolve all {count} requested {key}. Specify the missing fields or calculation.")
            plan[key] = candidates[:count]

        # Read persisted definitions before proposing another equivalent widget.
        from api.platform.semantic import semantic_registry
        from api.models.execution_context import current_selection
        selection = current_selection.get()
        known = set()
        if selection:
            namespace = semantic_registry.namespace(selection.entry, selection.context.version,
                                                    f"analytics:{selection.context.semantic_revision}")
            known = {widget_signature(doc['value']) for doc in semantic_registry.store.list(namespace)}
        regenerate = bool(re.search(r'\b(regenerate|replace|recreate)\b', prompt, re.I))
        for key, default_kind in [('kpis', 'kpi'), ('charts', 'bar')]:
            unique = []
            for item in plan.get(key) or []:
                signature = widget_signature({**item, 'kind': item.get('kind', default_kind)})
                if signature not in known or regenerate:
                    unique.append(item)
                    known.add(signature)
            plan[key] = unique
        yield step_event(3, "Identify", f"Identified primary metrics & {len(plan.get('kpis', []))} KPI measures.")

        # Step 4
        if plan.get("join_required"):
            yield step_event(4, "Relate", f"Cross-table JOIN resolved: {plan.get('join_type', 'LEFT JOIN')} between {plan.get('left_dataset_id')} and {plan.get('right_dataset_id')}.")
        else:
            yield step_event(4, "Relate", "Single-table scope verified. Unnecessary JOIN avoided.")

        # Step 5
        df, records_total, join_info = self._load_data_frame(plan, schemas)
        sql_query = plan.get("sql_query", f"SELECT * FROM {schemas[0]['table_name']} LIMIT 10")
        yield step_event(5, "Generate & Execute", "Prepared SQL and loaded the complete dataset for DataFrame execution.")

        # Step 6
        exec_results = self._execute_aggregations(
            df=df,
            kpi_specs=plan.get("kpis", []),
            chart_specs=plan.get("charts", []),
            filters=plan.get("filters"),
        )
        records_matched = exec_results["records_matched"]
        yield step_event(6, "Validate", f"Validated calculations over {records_matched:,} matching rows.")

        # Step 7
        insights = self._synthesize_insights(
            prompt=prompt,
            kpis=exec_results["kpis"],
            charts=exec_results["charts"],
            records_matched=records_matched,
            records_total=records_total
        )
        yield step_event(7, "Analyze", f"Analyzed actual metrics & synthesized {len(insights)} executive findings.")

        # Step 8
        recommendations = self._generate_proactive_recommendations(
            prompt=prompt,
            schemas=schemas,
            executed_kpis=exec_results["kpis"],
            executed_charts=exec_results["charts"],
            df=df
        )
        recommendations = [item for item in recommendations if widget_signature(item) not in known]
        yield step_event(8, "Recommend", f"Generated {len(recommendations)} proactive AI widget recommendations.")

        # Step 9
        dashboard_id = f"genai_dash_{int(time.time())}"
        yield step_event(9, "Render", f"Structured {len(exec_results['kpis'])} KPI cards and {len(exec_results['charts'])} chart widgets.")

        # Step 10
        py_visual = None
        if re.search(r'\b(python|matplotlib|seaborn)\b', prompt, re.I):
            from api.services.python_graph_agent import python_graph_agent
            charts = exec_results.get("charts") or []
            if not charts:
                raise ValueError("No validated chart specification was produced.")
            chart_plan = dict(charts[0]["query_plan"])
            chart_plan["chart_type"] = python_graph_agent._infer_chart_type(prompt)
            py_visual = python_graph_agent.generate_custom_graph(prompt, chart_plan, prepared_frame=df)
            if py_visual.get('status') == 'error' or not py_visual.get('image_base64'):
                raise ValueError(py_visual.get('message') or 'Python chart execution did not produce an image')
        yield step_event(10, "Visualize", "Rendered validated widgets." + (" Executed Python visualization." if py_visual else ""))

        total_elapsed_ms = round((time.time() - start_time) * 1000, 1)

        result_payload = {
            "status": "success",
            "dashboard_id": dashboard_id,
            "context": selection.context.model_dump() if selection else None,
            "prompt": prompt,
            "intent_summary": plan.get("intent_summary", "Dynamic analytical dashboard"),
            "execution_time_ms": total_elapsed_ms,
            "workflow_steps": workflow_steps,
            "sql_info": {
                "sql_query": sql_query,
                "join_required": plan.get("join_required", False),
                "join_type": plan.get("join_type"),
                "join_rationale": plan.get("join_rationale"),
                "join_info": join_info,
                "records_matched": records_matched,
                "records_total": records_total,
                "execution_backend": "dataframe",
                "sql_executed": False,
            },
            "kpi_cards": exec_results["kpis"],
            "charts": exec_results["charts"],
            "python_visual": py_visual,
            "executive_insights": insights,
            "recommendations": recommendations,
        }

        yield {"type": "result", "data": result_payload}

    # ──────────────────────────────────────────────────────────────────────────
    # Synchronous Orchestrator
    # ──────────────────────────────────────────────────────────────────────────
    def generate_dashboard(
        self,
        prompt: str,
        target_dataset_id: Optional[str] = None,
        conversation_history: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """Synchronous version that runs the generator and returns the final result."""
        final_result = None
        for chunk in self.generate_dashboard_stream(prompt, target_dataset_id, conversation_history):
            if chunk.get("type") == "result":
                final_result = chunk.get("data")
        return final_result or {"status": "error", "message": "Dashboard generation failed."}

    # ──────────────────────────────────────────────────────────────────────────
    # Execute a Single Recommended / Modified Widget
    # ──────────────────────────────────────────────────────────────────────────
    def execute_single_widget(
        self,
        widget_spec: Dict[str, Any],
        target_dataset_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Calculates and returns execution data for an accepted recommended widget."""
        schemas = self.explore_schemas(target_dataset_id)
        if not schemas:
            raise ValueError('No accessible datasets are available for widget execution')
        plan = {
            "target_datasets": [target_dataset_id] if target_dataset_id and target_dataset_id != "all" else [schemas[0]["dataset_id"]],
            "join_required": False
        }
        df, records_total, _ = self._load_data_frame(plan, schemas)

        kind = widget_spec.get("kind", "bar")
        if kind == "kpi":
            res = self._execute_aggregations(df, [widget_spec], [], filters=(widget_spec.get('query_plan') or {}).get('filters'))
            return {"kind": "kpi", "widget": res["kpis"][0] if res["kpis"] else widget_spec}
        else:
            res = self._execute_aggregations(df, [], [widget_spec], filters=(widget_spec.get('query_plan') or {}).get('filters'))
            return {"kind": kind, "widget": res["charts"][0] if res["charts"] else widget_spec}


genai_dashboard_service = GenAIDashboardService()
