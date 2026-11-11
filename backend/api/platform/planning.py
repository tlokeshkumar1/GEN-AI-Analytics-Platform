"""Semantic-only intent planning. Proposals are validated before any execution."""
import json
import re

from fastapi import HTTPException
from api.models.execution_context import current_selection
from api.models.query_plan import QueryPlan
from api.platform.semantic import semantic_registry
import copy
import threading

_INTENT_CACHE = {}
_INTENT_CACHE_LOCK = threading.Lock()


def clear_intent_cache():
    with _INTENT_CACHE_LOCK:
        _INTENT_CACHE.clear()


def classify_request(prompt):
    selection = current_selection.get()
    model = semantic_registry.get(selection.entry, selection.context.version, selection.context.semantic_revision, approved=True)
    cache_key = (
        selection.context.dataset_id,
        selection.context.version,
        selection.context.semantic_revision,
        re.sub(r"\s+", " ", prompt.strip().casefold()),
    )
    with _INTENT_CACHE_LOCK:
        if cache_key in _INTENT_CACHE:
            return copy.deepcopy(_INTENT_CACHE[cache_key])
    text = prompt.casefold()

    # Discover any joinable datasets dynamically in the current workspace
    from api.platform.join_service import join_service
    current_ds_id = selection.context.dataset_id
    join_edges = join_service.get_workspace_join_graph()
    joined_dims_map = {}  # dim_lower -> (c_name, edge, other_id)
    for edge in join_edges:
        if edge.get("joinable"):
            other_id = edge["right_dataset_id"] if edge["left_dataset_id"] == current_ds_id else (edge["left_dataset_id"] if edge["right_dataset_id"] == current_ds_id else None)
            if other_id:
                for c in join_service.get_dataset_columns(other_id):
                    if c.get("role") in ("dimension", "identifier", "time"):
                        joined_dims_map[c["name"]] = (c["name"], edge, other_id)

    # Pre-flight check: if prompt asks for a dimension (by X / per X) belonging to an unjoinable table
    joinable_other_ids = set()
    for edge in join_edges:
        if edge.get("joinable"):
            if edge.get("left_dataset_id") == current_ds_id:
                joinable_other_ids.add(edge.get("right_dataset_id"))
            elif edge.get("right_dataset_id") == current_ds_id:
                joinable_other_ids.add(edge.get("left_dataset_id"))

    from api.services.dataset_service import dataset_service
    catalog = dataset_service._catalog()
    for ds_id, ds_entry in catalog.get("datasets", {}).items():
        if ds_id == current_ds_id or ds_id in joinable_other_ids:
            continue
        for c in join_service.get_dataset_columns(ds_id):
            c_name = c.get("name", "")
            if not c_name or any(k.casefold() == c_name.casefold() for k in joined_dims_map):
                continue
            c_pattern = re.escape(c_name.casefold()).replace("_", r"[\s_]+")
            if re.search(r"\b(by|per)\s+" + c_pattern, text):
                raise HTTPException(422, f"The field '{c_name}' belongs to dataset '{ds_entry.get('name', ds_id)}' which cannot be joined with the active dataset because they do not share common keys or matching data.")

    numerical = bool(re.search(r"\b(total|sum|average|avg|count|how many|how much|top|bottom|highest|lowest|compare|chart|graph|plot|min|max|minimum|maximum|trend|trends)\b", text))
    if not re.search(r"\b(meaning|definition|describe|explain)\b", text):
        numerical = numerical or any(f.role == "measure" and any(re.search(r"(?<!\w)" + re.escape(alias.casefold()) + r"(?!\w)", text) for alias in [f.name, f.semantic_name, *f.aliases]) for f in model.fields)
    if not numerical:
        return QueryPlan(intent="chat", requires_structured_query=False, requires_vector_search=True).model_dump(exclude_none=True)
    from api.config import settings
    if settings.NVIDIA_API_KEY:
        from api.services.ai_core_service import ai_core_service
        from api.services.intent_engine import intent_engine
        measures_names = [f.name for f in model.fields if f.role == "measure"]
        dimensions_names = [f.name for f in model.fields if f.role in ("dimension", "identifier", "time")]
        instruction = (
            "You are a precise analytical query planner for enterprise business intelligence. Return ONLY a valid JSON object.\n"
            f"Dataset Domain: {model.domain}\n"
            f"Approved Measures (Numerical): {measures_names}\n"
            f"Approved Dimensions (Categorical / Temporal): {dimensions_names}\n"
            "Format:\n"
            '{"intent": "analytical"|"graph"|"chat"|"ranking", "requires_structured_query": true|false, '
            f'"metric": "{measures_names[0] if measures_names else "null"}", "aggregation": "SUM"|"AVG"|"COUNT", '
            '"dimensions": [], "chart_type": null, "limit": null}\n'
            "Rules:\n"
            "- If the user asks for an overall total or average of a metric without a breakdown dimension (e.g. 'what is the total', 'overall sum'), select the matching measure from Approved Measures, aggregation='SUM' (or 'AVG'), dimensions=[], chart_type=null, limit=null.\n"
            "- If the user asks for ranking, top/bottom items, use the matching metric from Approved Measures, appropriate dimension from Approved Dimensions, and limit=number requested or 5.\n"
            "- For trend requests explicitly asking for trends over time, select the primary metric, pair with the temporal dimension, and set chart_type='line'.\n"
            "- If the user asks to calculate or chart specific metrics by dimensions, return intent='analytical' or 'graph' with requires_structured_query=true.\n"
            "- If the user asks a broad semantic question, overview, explanation, or general knowledge, return {\"intent\": \"chat\", \"requires_structured_query\": false}.\n"
            f"User request: {prompt}"
        )
        response = ai_core_service.generate_nvidia_completion(instruction)
        proposal = intent_engine._parse_json_response(response)
        if proposal and proposal.get("intent") == "chat":
            return QueryPlan(intent="chat", requires_structured_query=False, requires_vector_search=True).model_dump(exclude_none=True)
        if proposal and "measures" in proposal and isinstance(proposal["measures"], list):
            for m in proposal["measures"]:
                if isinstance(m, dict) and "metric" in m and "field" not in m:
                    m["field"] = m.pop("metric")
        if not proposal or proposal.get("clarification"):
            clarif = proposal.get("clarification") if proposal else None
            if not clarif or clarif.strip().lower() in ("question", "none", "null"):
                sample_m = ", ".join(measures_names[:2]) or "a numeric measure"
                sample_d = ", ".join(dimensions_names[:2]) or "a grouping dimension"
                clarif = f"Please specify which metric (e.g. {sample_m}) and dimension (e.g. {sample_d}) you would like to analyze."
            raise HTTPException(422, clarif)
        try:
            plan = QueryPlan.model_validate(proposal)
        except Exception:
            return QueryPlan(intent="chat", requires_structured_query=False, requires_vector_search=True).model_dump(exclude_none=True)
        if plan.intent == "chat" or not plan.measures:
            return QueryPlan(intent="chat", requires_structured_query=False, requires_vector_search=True).model_dump(exclude_none=True)
        out = plan.model_dump(exclude_none=True, by_alias=True)
        with _INTENT_CACHE_LOCK:
            if len(_INTENT_CACHE) > 200:
                _INTENT_CACHE.pop(next(iter(_INTENT_CACHE)), None)
            _INTENT_CACHE[cache_key] = out
        return out
    # Conservative offline support: exact approved names/aliases and explicit aggregation.
    matched = []
    for field in model.fields:
        aliases = [field.name, field.semantic_name, *field.aliases]
        if any(re.search(r"(?<!\w)" + re.escape(alias.casefold()) + r"(?!\w)", text) for alias in aliases):
            matched.append(field)
    measures = [f for f in matched if f.role == "measure"]
    dimensions = [f for f in matched if f.role in ("dimension", "identifier", "time") and re.search(r"\b(by|per)\s+" + re.escape(f.name.casefold()), text)]
    selected_dims = [f.name for f in dimensions]
    joined_joins = []

    # Check joinable tables for cross-table dimensions if none found locally
    if not selected_dims and joined_dims_map:
        for raw_name, (actual_name, edge, other_id) in joined_dims_map.items():
            pattern = re.escape(raw_name.casefold()).replace("_", r"[\s_]+")
            if re.search(r"\b(by|per)\s+" + pattern, text) or re.search(r"(?<!\w)" + pattern + r"(?!\w)", text):
                from api.models.query_plan import Join
                selected_dims.append(actual_name)
                joined_joins.append(Join(
                    right_dataset_id=other_id,
                    left_key=edge["left_key"],
                    right_key=edge["right_key"],
                    how="left"
                ))
                break

    # If still not found, check if user requested a field from an unjoinable dataset
    if not selected_dims:
        from api.services.dataset_service import dataset_service
        catalog = dataset_service._catalog()
        for ds_id, ds_entry in catalog.get("datasets", {}).items():
            if ds_id == current_ds_id:
                continue
            cols = join_service.get_dataset_columns(ds_id)
            for c in cols:
                c_name = c["name"]
                c_pattern = re.sub(r"[_\\s]+", r"[\\s_]+", re.escape(c_name.casefold()))
                if re.search(r"\b(by|per)\s+" + c_pattern, text) or re.search(r"(?<!\w)" + c_pattern + r"(?!\w)", text):
                    is_joinable = any(e.get("joinable") and (e["right_dataset_id"] == ds_id or e["left_dataset_id"] == ds_id) for e in join_edges)
                    if not is_joinable:
                        raise HTTPException(422, f"The field '{c_name}' belongs to dataset '{ds_entry.get('name', ds_id)}' which cannot be joined with the active dataset because they do not share common keys or matching data.")

    aggregation = None
    for pattern, agg in [(r"count distinct|unique", "COUNT_DISTINCT"), (r"\b(count|how many)\b", "COUNT"),
                         (r"\b(average|avg)\b", "AVG"), (r"\b(minimum|min|lowest)\b", "MIN"),
                         (r"\b(maximum|max|highest)\b", "MAX"), (r"\b(total|sum)\b", "SUM")]:
        if re.search(pattern, text):
            aggregation = agg
            break
    metric = measures[0].name if len(measures) == 1 else None
    if aggregation in ("COUNT", "COUNT_DISTINCT"):
        targets = [f for f in matched if f not in dimensions]
        metric = targets[0].name if len(targets) == 1 else "*" if re.search(r"\b(rows|records)\b", text) else None
    if metric is None:
        raise HTTPException(422, "Specify one approved metric or use 'count records'. Multiple or missing metrics require clarification.")
    if not aggregation:
        aggregation = next((f.default_aggregation for f in model.fields if f.name == metric), None)
    if not aggregation:
        raise HTTPException(422, "Specify an aggregation or approve a default for this metric.")
    if re.search(r"\b(where|between|during|since|until|for|in|compare|versus|vs)\b", text):
        raise HTTPException(422, "This request needs an explicit filtered query plan. Configure AI planning or use the structured editor.")
    out = QueryPlan(
        intent="graph" if re.search(r"\b(chart|plot|graph)\b", text) else "analytical",
        left_dataset_id=current_ds_id if joined_joins else None,
        metric=metric,
        aggregation=aggregation,
        dimensions=selected_dims,
        joins=joined_joins,
    ).model_dump(exclude_none=True)
    with _INTENT_CACHE_LOCK:
        if len(_INTENT_CACHE) > 200:
            _INTENT_CACHE.pop(next(iter(_INTENT_CACHE)), None)
        _INTENT_CACHE[cache_key] = out
    return out
