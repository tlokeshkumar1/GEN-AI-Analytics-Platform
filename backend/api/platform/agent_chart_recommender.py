"""
Agent 3: Open-Domain Visualization & Chart Recommendation Agent
===============================================================
Analyzes the first 5 sample rows, semantic model, statistical column profiles,
and already-existing definitions via zero-shot LLM reasoning (with dynamic
data-driven fallback when offline) to propose meaningful, non-repetitive KPIs
and charts without any hardcoded business assumptions.
"""

import json
import os
import re
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd

from api.models.query_plan import QueryPlan
from api.platform.agent_domain_classifier import _inspect_numeric_series, _split_identifier_tokens
from api.platform.contracts import SemanticField, SemanticModel
from api.services.ai_core_service import ai_core_service
from api.services.analytics_engine import analytics_engine
from api.utils.logger import get_logger

logger = get_logger("agent.chart_recommender")

ALLOWED_CHART_KINDS = {
    "kpi",
    "bar",
    "line",
    "area",
    "donut",
    "pie",
    "horizontal_bar",
    "scatter",
    "gauge",
    "funnel",
    "radar",
}

AGG_ALIASES = {
    "TOTAL": "SUM",
    "MEAN": "AVG",
    "AVERAGE": "AVG",
    "DISTINCT_COUNT": "COUNT_DISTINCT",
    "UNIQUE": "COUNT_DISTINCT",
    "UNIQUE_COUNT": "COUNT_DISTINCT",
}

LLM_RECOMMENDATION_PROMPT = """You are an expert BI data analyst and visualization architect.
Analyze the dataset context, column statistics, and the FIRST 5 SAMPLE ROWS below to design up to {max_items} MEANINGFUL, HIGH-VALUE, NON-REPETITIVE KPIs and Charts tailored strictly to this specific dataset.

DATASET CONTEXT:
- Dataset Name: {dataset_name}
- Domain: {domain}
- Row Grain (1 row represents): {grain}
- Total Rows: {row_count}

COLUMN PROFILES (exact column names, roles, allowed aggregations, and observed data stats):
{profiles_summary}

FIRST 5 SAMPLE ROWS:
{sample_rows_json}

ALREADY EXISTING KPIs & CHARTS (STRICTLY DO NOT REPEAT OR DUPLICATE ANY OF THESE):
{existing_summary}

REQUIREMENTS:
1. 100% Data-Grounded: Use ONLY exact column names and allowed aggregations from COLUMN PROFILES. Inspect the FIRST 5 SAMPLE ROWS to understand what actually matters in this domain (avoid constant columns with nunique <= 1, mostly-null columns, or summing raw IDs/codes).
2. Strictly Different From Existing: Every recommendation you output MUST explore a DIFFERENT metric, aggregation (e.g. AVG, MIN, MAX, COUNT_DISTINCT, SUM), dimension, temporal axis, or multi-measure correlation than ALL items listed in ALREADY EXISTING KPIs & CHARTS. Never propose the same (measure, aggregation, dimension) under a different chart kind or title.
3. Diverse & Meaningful Mix:
   - "kpi": scalar executive indicator (set "dimension": null, "time_grouping": null). Prefer business-relevant totals, averages/rates, or unique entity counts not yet covered.
   - "line" or "area": temporal progression over a time/date field (use "time_grouping": {{"field": "<date_col>", "period": "month"|"quarter"|"year"}} ONLY when parseable_date=true and nunique > 12; otherwise use "dimension": "<time_col>").
   - "bar": categorical comparison across a readable dimension (3 to 15 categories).
   - "donut" or "pie": proportional composition across a low-cardinality dimension (2 to 6 categories).
   - "horizontal_bar": Top-N ranking across a medium/high-cardinality dimension (include "limit": 10 and "sort" DESC).
   - "scatter": correlation between 2 distinct numeric measures grouped by a dimension (use "measures": [{{"field": "<m1>", "aggregation": "<agg1>"}}, {{"field": "<m2>", "aggregation": "<agg2>"}}], "dimension": "<dim>", and omit "metric"/"aggregation").
4. Output ONLY a valid JSON object (no <think> blocks, no prose outside JSON):
{{
  "recommendations": [
    {{
      "title": "Concise domain-specific title",
      "kind": "kpi",
      "explanation": "1-sentence business insight explaining why this matters for this dataset",
      "selected_by_default": true,
      "query_plan": {{
        "intent": "analytical",
        "metric": "<exact_column_or_*>",
        "aggregation": "SUM",
        "dimension": null,
        "sort": null,
        "limit": null
      }}
    }}
  ]
}}
"""


def _normalize_query_plan_dict(raw_plan: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize legacy/UI QueryPlan variants before validation."""
    cleaned = {k: v for k, v in raw_plan.items() if v is not None and v != ""}
    if cleaned.get("metric") and not cleaned.get("aggregation") and not cleaned.get("measures"):
        cleaned["aggregation"] = "COUNT" if cleaned["metric"] == "*" else "SUM"
    if isinstance(cleaned.get("aggregation"), str):
        agg_u = cleaned["aggregation"].strip().upper()
        cleaned["aggregation"] = AGG_ALIASES.get(agg_u, agg_u)
    if isinstance(cleaned.get("measures"), list):
        norm_measures = []
        for m in cleaned["measures"]:
            m_dict = m.model_dump(exclude_none=True) if hasattr(m, "model_dump") else m
            if isinstance(m_dict, dict) and m_dict.get("field"):
                agg_u = str(m_dict.get("aggregation") or "SUM").strip().upper()
                norm_measures.append({**m_dict, "aggregation": AGG_ALIASES.get(agg_u, agg_u)})
        if norm_measures:
            cleaned["measures"] = norm_measures
            cleaned.pop("metric", None)
            cleaned.pop("aggregation", None)
        else:
            cleaned.pop("measures", None)
    # Drop keys not defined on QueryPlan (extra="forbid")
    allowed_fields = set(QueryPlan.model_fields.keys())
    return {k: v for k, v in cleaned.items() if k in allowed_fields}


def recommendation_signature(item: Any) -> Tuple[Any, ...]:
    """
    Canonical semantic signature for a KPI or chart definition.
    Normalizes metric/aggregation vs measures/dimensions so equivalent plans
    always match regardless of syntax or UI metadata.
    """
    if isinstance(item, dict):
        kind = str(item.get("kind") or "bar").lower()
        raw_plan = item.get("query_plan") or {}
    else:
        kind = str(getattr(item, "kind", "bar")).lower()
        raw_plan = getattr(item, "query_plan", {}) or {}
    if hasattr(raw_plan, "model_dump"):
        raw_plan = raw_plan.model_dump(exclude_none=True, by_alias=True)

    kind_group = "kpi" if kind == "kpi" else "chart"
    try:
        plan = QueryPlan.model_validate(_normalize_query_plan_dict(dict(raw_plan)))
    except Exception:
        metric = str(raw_plan.get("metric") or "").lower()
        agg = str(raw_plan.get("aggregation") or ("COUNT" if metric == "*" else "SUM")).upper()
        dim = str(raw_plan.get("dimension") or "").lower()
        dims = tuple(str(d).lower() for d in (raw_plan.get("dimensions") or ([dim] if dim else [])))
        measures = tuple(sorted([(metric, agg)])) if metric else ()
        return (kind_group, measures, dims, None, (), (), ())

    measures = tuple(sorted((m.field.lower(), m.aggregation.upper()) for m in plan.measures))
    dimensions = tuple(d.lower() for d in plan.dimensions)
    time_group = (
        (plan.time_grouping.field.lower(), plan.time_grouping.period)
        if plan.time_grouping
        else None
    )
    derived = tuple(sorted(d.lower() for d in plan.derived_metrics))
    filters = tuple(sorted((f.column.lower(), f.operator, str(f.value)) for f in plan.filters))
    joins = tuple(
        sorted(
            (j.relationship or "", j.right_dataset_id or "", j.right_table or "")
            for j in plan.joins
        )
    )
    return (kind_group, measures, dimensions, time_group, derived, filters, joins)


def concept_signature(item: Any) -> Tuple[Any, ...]:
    """Core analytical angle `(kind_group, measures, dimensions, time_group)` ignoring sort/limit."""
    sig = recommendation_signature(item)
    return sig[:4]


def extract_query_dependencies(model: Optional[SemanticModel], query: QueryPlan) -> List[str]:
    """Extract sorted semantic and join dependencies from a validated QueryPlan."""
    dependencies = (
        {measure.field for measure in query.measures if measure.field != "*"}
        | set(query.dimensions)
        | {condition.column for condition in query.filters}
    )
    for date_spec in (query.date_filter, query.comparison):
        if date_spec:
            dependencies.add(date_spec.column)
    if query.time_grouping:
        dependencies.add(query.time_grouping.field)
    for name in query.derived_metrics:
        dependencies.add(name)
        if model is not None:
            definition = next((m for m in model.derived_metrics if m.name == name), None)
            if definition:
                dependencies.update(dep.field for dep in definition.dependencies.values())
    for join in query.joins:
        if join.relationship:
            dependencies.add("relationship:" + join.relationship)
        elif join.right_dataset_id or join.right_table:
            target_ref = join.right_dataset_id or join.right_table
            dependencies.add(f"join:{target_ref}:{join.left_key or ''}:{join.right_key or ''}")
    return sorted(dependencies)


class ChartRecommenderAgent:
    """
    Autonomous visualization recommendation agent.
    Uses the first 5 sample rows + column stats via LLM reasoning to produce
    meaningful, non-repetitive KPIs & charts, with dynamic data-driven fallback.
    """

    def recommend(
        self,
        df: pd.DataFrame,
        model: SemanticModel,
        existing_items: Optional[Iterable[Any]] = None,
        max_items: int = 6,
        dataset_name: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Generate up to `max_items` meaningful, non-repetitive chart and KPI definitions,
        excluding anything semantically equivalent to `existing_items`.
        """
        if df is None or df.empty or not model or not model.fields:
            return []

        existing_list = list(existing_items or [])
        seen_signatures = set()
        seen_concepts = set()
        seen_titles = set()
        for existing in existing_list:
            seen_signatures.add(recommendation_signature(existing))
            seen_concepts.add(concept_signature(existing))
            title = existing.get("title") if isinstance(existing, dict) else getattr(existing, "title", "")
            if title:
                seen_titles.add(str(title).strip().lower())

        profiles = self._profile_columns(df, model)
        recommendations: List[Dict[str, Any]] = []

        # 1. Primary path: 5-row LLM reasoning (zero hardcoding)
        llm_available = False
        llm_candidates, llm_available = self._generate_llm_candidates(
            df=df,
            model=model,
            profiles=profiles,
            existing_items=existing_list,
            max_items=max_items,
            dataset_name=dataset_name,
        )

        rejected_as_duplicate: List[str] = []
        for cand in llm_candidates:
            if len(recommendations) >= max_items:
                break
            validated, reason = self._validate_and_preview(
                cand, df, model, profiles, seen_signatures, seen_concepts, seen_titles
            )
            if validated is not None:
                recommendations.append(validated)
            elif reason == "duplicate":
                rejected_as_duplicate.append(str(cand.get("title") or cand.get("query_plan")))

        # If LLM ran but collided with existing definitions, ask once more explicitly avoiding collisions
        if llm_available and not recommendations and rejected_as_duplicate:
            retry_candidates, _ = self._generate_llm_candidates(
                df=df,
                model=model,
                profiles=profiles,
                existing_items=existing_list,
                max_items=max_items,
                dataset_name=dataset_name,
                extra_avoid_notes=rejected_as_duplicate,
            )
            for cand in retry_candidates:
                if len(recommendations) >= max_items:
                    break
                validated, _ = self._validate_and_preview(
                    cand, df, model, profiles, seen_signatures, seen_concepts, seen_titles
                )
                if validated is not None:
                    recommendations.append(validated)

        # 2. Only when LLM is offline/unavailable (no valid LLM candidates produced at all),
        #    derive non-duplicate recommendations dynamically from observed distributions.
        if not llm_available and not recommendations:
            stat_candidates = self._generate_dynamic_statistical_candidates(df, model, profiles)
            for cand in stat_candidates:
                if len(recommendations) >= max_items:
                    break
                validated, _ = self._validate_and_preview(
                    cand, df, model, profiles, seen_signatures, seen_concepts, seen_titles
                )
                if validated is not None:
                    recommendations.append(validated)

        logger.info(
            f"[ChartRecommenderAgent] Generated {len(recommendations)} meaningful, non-duplicate recommendations."
        )
        return recommendations

    def _resolve_df_column(self, df: pd.DataFrame, name: str) -> Optional[str]:
        if name in df.columns:
            return name
        lower = name.lower()
        for col in df.columns:
            if str(col).lower() == lower:
                return col
        return None

    def _profile_columns(self, df: pd.DataFrame, model: SemanticModel) -> Dict[str, Dict[str, Any]]:
        """Compute statistical quality, cardinality, variance, and date-span metrics per field."""
        profiles: Dict[str, Dict[str, Any]] = {}
        total_rows = max(1, len(df))

        for field in model.fields:
            col_name = self._resolve_df_column(df, field.name)
            if col_name is None:
                continue
            series = df[col_name]
            non_null = series.dropna()
            non_null_count = len(non_null)
            null_ratio = 1.0 - (non_null_count / total_rows)
            nunique = int(non_null.nunique()) if non_null_count > 0 else 0
            uniqueness_ratio = (nunique / non_null_count) if non_null_count > 0 else 0.0
            is_empty = non_null_count == 0
            is_constant = nunique <= 1

            profile: Dict[str, Any] = {
                "field": field,
                "col": col_name,
                "non_null_count": non_null_count,
                "null_ratio": round(null_ratio, 3),
                "nunique": nunique,
                "uniqueness_ratio": round(uniqueness_ratio, 3),
                "is_empty": is_empty,
                "is_constant": is_constant,
                "useful": not is_empty and not is_constant and null_ratio < 0.9,
            }

            is_num, _ = _inspect_numeric_series(non_null)
            if field.role == "measure" or (is_num and field.role not in ("identifier", "time", "dimension")):
                numeric_series = pd.to_numeric(non_null, errors="coerce").dropna()
                if numeric_series.empty or numeric_series.nunique() <= 1:
                    profile["useful"] = False
                    profile["preferred_agg"] = field.default_aggregation or "AVG"
                    profile["cv"] = 0.0
                else:
                    mean_val = float(numeric_series.mean())
                    std_val = float(numeric_series.std(ddof=0))
                    min_val = float(numeric_series.min())
                    max_val = float(numeric_series.max())
                    cv = (std_val / abs(mean_val)) if abs(mean_val) > 1e-9 else (1.0 if std_val > 0 else 0.0)
                    tokens = _split_identifier_tokens(field.name)
                    token_set = set(tokens)
                    looks_like_code = bool(
                        (tokens and tokens[-1] in {"id", "code", "key", "zip", "postal", "phone", "mobile", "ssn", "serial"})
                        or ("year" in token_set and 1900 <= min_val <= max_val <= 2150)
                    )
                    is_rate = (
                        field.unit == "%"
                        or bool(token_set & {"percent", "percentage", "pct", "ratio", "rate", "margin", "discount", "score", "rating", "avg", "mean"})
                        or field.default_aggregation == "AVG"
                    )
                    preferred_agg = field.default_aggregation
                    if not preferred_agg:
                        if is_rate and "AVG" in field.aggregations:
                            preferred_agg = "AVG"
                        elif "SUM" in field.aggregations and not looks_like_code:
                            preferred_agg = "SUM"
                        elif "AVG" in field.aggregations:
                            preferred_agg = "AVG"
                        elif field.aggregations:
                            preferred_agg = field.aggregations[0]
                    profile.update(
                        {
                            "min": round(min_val, 3),
                            "max": round(max_val, 3),
                            "mean": round(mean_val, 3),
                            "std": round(std_val, 3),
                            "cv": round(cv, 3),
                            "looks_like_code": looks_like_code,
                            "is_rate": is_rate,
                            "preferred_agg": preferred_agg,
                            "useful": profile["useful"] and not looks_like_code,
                        }
                    )
            elif field.role == "time":
                parsed = (
                    pd.to_datetime(non_null, errors="coerce", format="mixed")
                    if not pd.api.types.is_numeric_dtype(non_null)
                    else pd.Series(dtype="datetime64[ns]")
                )
                valid_dates = parsed.dropna()
                is_parseable_date = non_null_count > 0 and (len(valid_dates) / non_null_count) >= 0.7
                time_period = None
                if is_parseable_date and nunique > 12:
                    span_days = (valid_dates.max() - valid_dates.min()).days
                    if span_days > 1095:
                        time_period = "year"
                    elif span_days > 365:
                        time_period = "quarter"
                    elif span_days > 35:
                        time_period = "month"
                    else:
                        time_period = "day"
                profile.update(
                    {
                        "is_parseable_date": is_parseable_date,
                        "time_period": time_period,
                    }
                )
            elif field.role == "dimension":
                top_vals = [str(k) for k in non_null.value_counts().head(3).index.tolist()]
                is_free_text = uniqueness_ratio > 0.85 and nunique > 25
                profile.update(
                    {
                        "top_values": top_vals,
                        "is_free_text": is_free_text,
                        "useful": profile["useful"] and not is_free_text,
                    }
                )

            profiles[field.name] = profile

        return profiles

    def _generate_llm_candidates(
        self,
        df: pd.DataFrame,
        model: SemanticModel,
        profiles: Dict[str, Dict[str, Any]],
        existing_items: List[Any],
        max_items: int,
        dataset_name: Optional[str] = None,
        extra_avoid_notes: Optional[List[str]] = None,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """
        Send the first 5 rows + column profiles + existing definitions to the LLM.
        Returns (candidates, llm_responded).
        """
        if os.getenv("PYTEST_CURRENT_TEST"):
            return [], False

        try:
            profile_lines = []
            for field in model.fields:
                prof = profiles.get(field.name, {})
                if not prof:
                    continue
                extra = ""
                if field.role == "measure":
                    extra = (
                        f"min={prof.get('min')}, max={prof.get('max')}, mean={prof.get('mean')}, "
                        f"preferred_agg={prof.get('preferred_agg')}"
                    )
                elif field.role == "dimension":
                    extra = f"top_values={prof.get('top_values', [])}"
                elif field.role == "time":
                    extra = f"parseable_date={prof.get('is_parseable_date')}, suggested_period={prof.get('time_period')}"
                profile_lines.append(
                    f"- {field.name} (label='{field.semantic_name}', role={field.role}, type={field.type}, "
                    f"allowed_aggs={field.aggregations}, nunique={prof.get('nunique')}, "
                    f"null_ratio={prof.get('null_ratio')}, useful={prof.get('useful')}; {extra})"
                )

            existing_lines = []
            for item in existing_items:
                title = item.get("title") if isinstance(item, dict) else getattr(item, "title", "")
                kind = item.get("kind") if isinstance(item, dict) else getattr(item, "kind", "")
                sig = recommendation_signature(item)
                existing_lines.append(
                    f"- [{kind}] '{title}' -> measures={sig[1]}, dimensions={sig[2]}, time_grouping={sig[3]}"
                )
            for note in extra_avoid_notes or []:
                existing_lines.append(f"- [DUPLICATE_COLLISION_AVOID]: {note}")

            sample_rows = df.head(5).to_dict(orient="records")
            prompt = LLM_RECOMMENDATION_PROMPT.format(
                max_items=max_items,
                dataset_name=dataset_name or model.table_id or model.domain,
                domain=model.domain,
                grain=model.grain,
                row_count=len(df),
                profiles_summary="\n".join(profile_lines),
                sample_rows_json=json.dumps(sample_rows, indent=2, default=str),
                existing_summary="\n".join(existing_lines) if existing_lines else "None yet.",
            )

            response = ai_core_service.generate_structured_completion(prompt, max_tokens=1800, temperature=0.15)
            if not response:
                return [], False

            parsed = self._extract_json(response)
            if isinstance(parsed, dict) and isinstance(parsed.get("recommendations"), list):
                return parsed["recommendations"], True
            return [], False
        except Exception as exc:
            logger.warning(f"[ChartRecommenderAgent] LLM recommendation pass failed: {exc}")
            return [], False

    @staticmethod
    def _extract_json(text: str) -> Optional[Dict[str, Any]]:
        cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE).strip()
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
        code_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", cleaned)
        if code_match:
            try:
                parsed = json.loads(code_match.group(1))
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass
        brace_match = re.search(r"\{[\s\S]*\}", cleaned)
        if brace_match:
            try:
                parsed = json.loads(brace_match.group(0))
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass
        return None

    def _generate_dynamic_statistical_candidates(
        self,
        df: pd.DataFrame,
        model: SemanticModel,
        profiles: Dict[str, Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Purely distribution-driven fallback when LLM is offline/unconfigured.
        Derives candidate metrics & visualizations from observed column stats without
        hardcoded domain names or generic filler records.
        """
        candidates: List[Dict[str, Any]] = []

        measures = [
            f
            for f in model.fields
            if f.role == "measure" and profiles.get(f.name, {}).get("useful", False)
        ]
        measures.sort(
            key=lambda f: (
                1 if f.default_aggregation else 0,
                1 - profiles[f.name].get("null_ratio", 1.0),
                min(profiles[f.name].get("cv", 0.0), 5.0),
            ),
            reverse=True,
        )

        dimensions = [
            f
            for f in model.fields
            if f.role == "dimension" and profiles.get(f.name, {}).get("useful", False)
        ]
        time_fields = [
            f
            for f in model.fields
            if f.role == "time" and profiles.get(f.name, {}).get("nunique", 0) >= 2
        ]
        identifiers = [
            f
            for f in model.fields
            if f.role == "identifier" and profiles.get(f.name, {}).get("nunique", 0) >= 1
        ]

        # Measure KPIs (primary preferred aggregation, then AVG for additive measures)
        for m in measures[:3]:
            prof = profiles[m.name]
            agg = prof.get("preferred_agg") or "SUM"
            candidates.append(
                {
                    "id": f"rec_kpi_{m.name.lower()}_{agg.lower()}",
                    "title": self._kpi_title(m, agg),
                    "kind": "kpi",
                    "explanation": f"Tracks {agg.lower()} {m.semantic_name} across {model.domain}.",
                    "selected_by_default": True,
                    "query_plan": {"intent": "analytical", "metric": m.name, "aggregation": agg, "filters": []},
                }
            )
            if agg == "SUM" and "AVG" in m.aggregations and len(df) > 1:
                candidates.append(
                    {
                        "id": f"rec_kpi_{m.name.lower()}_avg",
                        "title": self._kpi_title(m, "AVG"),
                        "kind": "kpi",
                        "explanation": f"Measures average {m.semantic_name} per {model.grain}.",
                        "selected_by_default": False,
                        "query_plan": {"intent": "analytical", "metric": m.name, "aggregation": "AVG", "filters": []},
                    }
                )

        if identifiers:
            ranked_ids = sorted(
                identifiers,
                key=lambda f: (1 if profiles[f.name]["nunique"] < len(df) else 0, profiles[f.name]["nunique"]),
                reverse=True,
            )
            id_field = ranked_ids[0]
            candidates.append(
                {
                    "id": f"rec_kpi_count_{id_field.name.lower()}",
                    "title": f"Unique {id_field.semantic_name}s",
                    "kind": "kpi",
                    "explanation": f"Distinct count of {id_field.semantic_name} in {model.domain}.",
                    "selected_by_default": True,
                    "query_plan": {
                        "intent": "analytical",
                        "metric": id_field.name,
                        "aggregation": "COUNT_DISTINCT",
                        "filters": [],
                    },
                }
            )

        # Temporal trends
        if time_fields:
            t_field = time_fields[0]
            t_prof = profiles[t_field.name]
            for idx, m in enumerate(measures[:2] if measures else [None]):
                metric_name = m.name if m else "*"
                metric_label = m.semantic_name if m else "Volume"
                agg = (profiles[m.name].get("preferred_agg") or "SUM") if m else "COUNT"
                if t_prof.get("time_period"):
                    qplan: Dict[str, Any] = {
                        "intent": "analytical",
                        "metric": metric_name,
                        "aggregation": agg,
                        "time_grouping": {"field": t_field.name, "period": t_prof["time_period"]},
                        "sort": {"column": "period", "direction": "ASC"},
                        "limit": 24,
                        "filters": [],
                    }
                    title = f"{t_prof['time_period'].title()}ly {metric_label}"
                else:
                    qplan = {
                        "intent": "analytical",
                        "metric": metric_name,
                        "aggregation": agg,
                        "dimension": t_field.name,
                        "sort": {"column": t_field.name, "direction": "ASC"},
                        "limit": 24,
                        "filters": [],
                    }
                    title = f"{metric_label} by {t_field.semantic_name}"
                candidates.append(
                    {
                        "id": f"rec_trend_{t_field.name.lower()}_{metric_name.lower().replace('*', 'count')}",
                        "title": title,
                        "kind": "line" if idx == 0 else "area",
                        "explanation": f"Trend of {metric_label} over {t_field.semantic_name}.",
                        "selected_by_default": idx == 0,
                        "query_plan": qplan,
                    }
                )

        # Categorical comparisons across diverse dimensions & measures
        for m in (measures if measures else [None]):
            m_name = m.name if m else "*"
            m_label = m.semantic_name if m else "Volume"
            agg = (profiles[m.name].get("preferred_agg") or "SUM") if m else "COUNT"
            sorted_dims = sorted(
                dimensions,
                key=lambda d: (abs(profiles[d.name]["nunique"] - 6), profiles[d.name]["null_ratio"]),
            )
            for d in sorted_dims:
                card = profiles[d.name]["nunique"]
                chart_kind = "donut" if 2 <= card <= 5 else "horizontal_bar" if card > 12 else "bar"
                candidates.append(
                    {
                        "id": f"rec_{chart_kind}_{d.name.lower()}_{m_name.lower().replace('*', 'count')}",
                        "title": f"{m_label} by {d.semantic_name}",
                        "kind": chart_kind,
                        "explanation": f"Compares {m_label} across {d.semantic_name}.",
                        "selected_by_default": len(candidates) < 4,
                        "query_plan": {
                            "intent": "ranking" if chart_kind == "horizontal_bar" else "analytical",
                            "metric": m_name,
                            "aggregation": agg,
                            "dimension": d.name,
                            "sort": {"column": m_name, "direction": "DESC"},
                            "limit": 6 if chart_kind == "donut" else 10,
                            "filters": [],
                        },
                    }
                )

        # Two-measure scatter plot
        if len(measures) >= 2 and dimensions:
            dim = min(dimensions, key=lambda d: abs(profiles[d.name]["nunique"] - 8))
            m1, m2 = measures[0], measures[1]
            a1 = profiles[m1.name].get("preferred_agg") or "SUM"
            a2 = profiles[m2.name].get("preferred_agg") or "SUM"
            candidates.append(
                {
                    "id": f"rec_scatter_{m1.name.lower()}_{m2.name.lower()}_{dim.name.lower()}",
                    "title": f"{m1.semantic_name} vs {m2.semantic_name} by {dim.semantic_name}",
                    "kind": "scatter",
                    "explanation": f"Relationship between {m1.semantic_name} and {m2.semantic_name} across {dim.semantic_name}.",
                    "selected_by_default": False,
                    "query_plan": {
                        "intent": "analytical",
                        "measures": [
                            {"field": m1.name, "aggregation": a1},
                            {"field": m2.name, "aggregation": a2},
                        ],
                        "dimensions": [dim.name],
                        "limit": 25,
                        "filters": [],
                    },
                }
            )

        return candidates

    @staticmethod
    def _kpi_title(field: SemanticField, agg: str) -> str:
        label = field.semantic_name
        agg_u = agg.upper()
        if agg_u == "SUM":
            return f"Total {label}"
        if agg_u == "AVG":
            return f"Average {label}"
        if agg_u == "MIN":
            return f"Minimum {label}"
        if agg_u == "MAX":
            return f"Maximum {label}"
        if agg_u == "COUNT_DISTINCT":
            return f"Unique {label}s"
        return f"{agg_u} {label}"

    def _validate_and_preview(
        self,
        candidate: Dict[str, Any],
        df: pd.DataFrame,
        model: SemanticModel,
        profiles: Dict[str, Dict[str, Any]],
        seen_signatures: set,
        seen_concepts: set,
        seen_titles: set,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        """
        Validate candidate against SemanticModel + QueryPlan, check strict deduplication,
        execute against `df` to verify non-empty meaningful output, and attach preview data.
        """
        try:
            kind = str(candidate.get("kind") or "bar").lower()
            if kind not in ALLOWED_CHART_KINDS:
                return None, "invalid"

            raw_plan = dict(candidate.get("query_plan") or {})
            raw_plan = self._normalize_raw_plan_fields(raw_plan, model, profiles)
            plan = QueryPlan.model_validate(raw_plan)
            normalized_plan = plan.model_dump(exclude_none=True, by_alias=True)

            if kind not in ("kpi", "gauge") and not plan.dimensions and not plan.time_grouping:
                return None, "invalid"

            sig = recommendation_signature({"kind": kind, "query_plan": normalized_plan})
            concept = concept_signature({"kind": kind, "query_plan": normalized_plan})
            title = str(candidate.get("title") or "").strip()
            if not title:
                return None, "invalid"
            if sig in seen_signatures or concept in seen_concepts or title.lower() in seen_titles:
                return None, "duplicate"

            exec_result = analytics_engine.execute(
                normalized_plan,
                dataframe=df,
                semantic_model=model,
            )
            if not exec_result.success or not exec_result.data:
                return None, "execution_empty"

            if kind not in ("kpi", "gauge") and len(exec_result.data) < 2:
                return None, "trivial_chart"

            rec_id = str(candidate.get("id") or f"rec_{kind}_{uuid.uuid4().hex[:10]}")
            item: Dict[str, Any] = {
                "id": rec_id,
                "title": title,
                "kind": kind,
                "revision": 1,
                "semantic_revision": model.revision,
                "query_plan": normalized_plan,
                "dependencies": extract_query_dependencies(model, plan),
                "explanation": str(candidate.get("explanation") or f"Analytical view of {title}."),
                "selected_by_default": bool(candidate.get("selected_by_default", False)),
                "status": "proposed",
            }

            if kind == "kpi":
                val = exec_result.summary.get("value")
                field_obj = next((f for f in model.fields if f.name == plan.measures[0].field), None) if plan.measures else None
                prefix = "$" if field_obj and field_obj.currency == "USD" else ""
                suffix = "%" if field_obj and field_obj.unit == "%" else ""
                if isinstance(val, (int, float)):
                    item["preview_value"] = (
                        f"{prefix}{val:,.2f}{suffix}"
                        if isinstance(val, float) and not val.is_integer()
                        else f"{prefix}{int(val):,}{suffix}"
                    )
                else:
                    item["preview_value"] = str(exec_result.summary.get("formatted_value") or val or "0")
            else:
                item["preview_rows"] = exec_result.data[:15]

            seen_signatures.add(sig)
            seen_concepts.add(concept)
            seen_titles.add(title.lower())
            return item, "ok"
        except Exception as exc:
            logger.debug(f"[ChartRecommenderAgent] Rejected candidate '{candidate.get('title')}': {exc}")
            return None, "error"

    def _normalize_raw_plan_fields(
        self,
        raw_plan: Dict[str, Any],
        model: SemanticModel,
        profiles: Dict[str, Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Resolve case-insensitive field names and sanitize LLM JSON placeholders."""
        field_map = {f.name.lower(): f.name for f in model.fields}
        field_map["*"] = "*"

        def _res(name: Optional[str]) -> Optional[str]:
            if not name:
                return None
            return field_map.get(str(name).strip().lower(), name)

        cleaned: Dict[str, Any] = {}
        for k, v in raw_plan.items():
            if v is None or v == "" or v == "null":
                continue
            if isinstance(v, str) and v.startswith("<") and v.endswith(">"):
                continue
            cleaned[k] = v

        if "metric" in cleaned:
            cleaned["metric"] = _res(cleaned["metric"])
            agg_raw = str(cleaned.get("aggregation") or "").strip().upper()
            agg_norm = AGG_ALIASES.get(agg_raw, agg_raw)
            if not agg_norm:
                f_obj = next((f for f in model.fields if f.name == cleaned["metric"]), None)
                agg_norm = "COUNT" if cleaned["metric"] == "*" else ((f_obj.default_aggregation or "SUM") if f_obj else "COUNT")
            cleaned["aggregation"] = agg_norm
        if "dimension" in cleaned:
            cleaned["dimension"] = _res(cleaned["dimension"])
        if isinstance(cleaned.get("dimensions"), list):
            cleaned["dimensions"] = [_res(d) for d in cleaned["dimensions"] if d]
        if isinstance(cleaned.get("measures"), list):
            norm_measures = []
            for m in cleaned["measures"]:
                if isinstance(m, dict) and m.get("field"):
                    agg_raw = str(m.get("aggregation") or "SUM").strip().upper()
                    norm_measures.append({**m, "field": _res(m["field"]), "aggregation": AGG_ALIASES.get(agg_raw, agg_raw)})
            if norm_measures:
                cleaned["measures"] = norm_measures
                cleaned.pop("metric", None)
                cleaned.pop("aggregation", None)
            else:
                cleaned.pop("measures", None)
        if isinstance(cleaned.get("time_grouping"), dict) and cleaned["time_grouping"].get("field"):
            tg_field = _res(cleaned["time_grouping"]["field"])
            tg_period = str(cleaned["time_grouping"].get("period") or "month").lower()
            if tg_period not in ("year", "quarter", "month", "day"):
                tg_period = "month"
            if profiles.get(tg_field, {}).get("is_parseable_date"):
                cleaned["time_grouping"] = {"field": tg_field, "period": tg_period}
                cleaned.pop("dimension", None)
                cleaned.pop("dimensions", None)
            else:
                # Non-datetime discrete time column (e.g. Year integer or Month label) -> group directly as dimension
                cleaned.pop("time_grouping", None)
                cleaned["dimension"] = tg_field
        if isinstance(cleaned.get("sort"), dict) and cleaned["sort"].get("column"):
            sort_col = cleaned["sort"]["column"]
            if sort_col != "period":
                cleaned["sort"]["column"] = _res(sort_col)
            out_cols = set()
            if cleaned.get("metric"):
                out_cols.add(cleaned["metric"])
            for m in cleaned.get("measures") or []:
                out_cols.add(m.get("alias") or m.get("field"))
            if cleaned.get("dimension"):
                out_cols.add(cleaned["dimension"])
            for d in cleaned.get("dimensions") or []:
                out_cols.add(d)
            if cleaned.get("time_grouping"):
                out_cols.add("period")
            if cleaned["sort"]["column"] not in out_cols:
                cleaned.pop("sort", None)

        allowed_fields = set(QueryPlan.model_fields.keys())
        return {k: v for k, v in cleaned.items() if k in allowed_fields}


chart_recommender_agent = ChartRecommenderAgent()
