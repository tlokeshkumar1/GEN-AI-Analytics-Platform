import contextvars
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from api.models.execution_context import current_selection
from api.platform.semantic import semantic_registry, now
from api.platform.contracts import AnalyticsItem
from api.platform.agent_chart_recommender import chart_recommender_agent
from api.services.analytics_engine import analytics_engine
from api.services.dataset_service import dataset_service
from api.utils.logger import get_logger

logger = get_logger("routes.dashboard")

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"])

_DASHBOARD_CACHE: Dict[Any, Dict[str, Any]] = {}
_DASHBOARD_CACHE_LOCK = threading.Lock()
_DASHBOARD_CACHE_TTL = 120.0  # seconds


def clear_dashboard_cache():
    with _DASHBOARD_CACHE_LOCK:
        _DASHBOARD_CACHE.clear()


class PublishRecommendedRequest(BaseModel):
    items: List[Dict[str, Any]]
    title: Optional[str] = "Executive Analytics Dashboard"


@router.post("/publish-recommended")
def publish_recommended_charts(req: PublishRecommendedRequest):
    with semantic_registry.store.transaction():
        return _publish_recommended_charts(req)


def _publish_recommended_charts(req: PublishRecommendedRequest):
    """
    Publish user-selected recommended charts directly to the Executive Dashboard.
    """
    selection = current_selection.get()
    if selection is None:
        raise HTTPException(409, "Select an active dataset version.")

    context = selection.context
    entry = selection.entry
    version = context.version
    semantic_revision = context.semantic_revision
    state = next((v.get("ingestionStatus", entry.get("ingestionStatus")) for v in entry.get("versions", [])
                  if v["version"] == version), entry.get("ingestionStatus"))
    if state == "partial":
        raise HTTPException(409, "Complete the failed ingestion stages before publishing this dataset.")

    # Auto-approve semantic model if currently proposed
    model = None
    try:
        model = semantic_registry.get(entry, version, semantic_revision)
        if model.status != "approved":
            import os
            if os.getenv("PLATFORM_AUTO_APPROVE_SEMANTICS", "true").lower() != "true":
                raise HTTPException(409, "Review and approve the semantic model before publishing.")
            model = semantic_registry.review(entry, version, semantic_revision, "approved")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"Semantic model auto-approval note: {exc}")

    from api.models.query_plan import QueryPlan
    from api.platform.agent_chart_recommender import extract_query_dependencies

    analytics_ns = semantic_registry.namespace(entry, version, f"analytics:{semantic_revision}")
    published_refs = []
    from api.platform.widget_contract import widget_signature
    known = {widget_signature(doc['value']): doc['value']
             for doc in semantic_registry.store.list(analytics_ns)}

    for item_data in req.items:
        item_id = item_data.get("id") or ("rec_" + uuid.uuid4().hex[:12])
        query_plan = QueryPlan.model_validate(item_data.get("query_plan", {}))
        candidate = {**item_data, 'query_plan': query_plan.model_dump(exclude_none=True)}
        signature = widget_signature(candidate)
        if signature in known:
            original = known[signature]
            if original.get('status') != 'approved':
                validation = analytics_engine.execute(query_plan.model_dump(mode='json', exclude_none=True))
                if not validation.success:
                    raise HTTPException(422, validation.error or 'Widget calculation validation failed.')
                key = f"{original['id']}:{original.get('revision', 1)}"
                saved = semantic_registry.store.get(analytics_ns, key)
                original = {**original, 'status': 'approved', 'reviewer': 'system', 'reviewed_at': now()}
                semantic_registry.store.put(analytics_ns, key, original, expected_revision=saved['revision'])
                known[signature] = original
            published_refs.append({'id': original['id'], 'revision': original.get('revision', 1)})
            continue
        collision = semantic_registry.store.get(analytics_ns, f'{item_id}:1')
        if collision:
            # Generated plans often reuse IDs such as kpi_1; retain the published calculation.
            import hashlib
            item_id = 'widget_' + hashlib.sha256(repr(signature).encode('utf-8')).hexdigest()[:20]
        validation = analytics_engine.execute(query_plan.model_dump(mode='json', exclude_none=True))
        if not validation.success:
            raise HTTPException(422, validation.error or 'Widget calculation validation failed.')
        title = item_data.get("title", "Metric Chart")
        kind = item_data.get("kind", "bar")
        explanation = item_data.get("explanation", "Recommended analytical chart.")
        deps = item_data.get("dependencies") or extract_query_dependencies(model, query_plan)

        item = AnalyticsItem(
            id=item_id,
            title=title,
            kind=kind,
            revision=1,
            semantic_revision=semantic_revision,
            query_plan=query_plan,
            dependencies=deps,
            explanation=explanation,
            status="approved",
            reviewer="system",
            reviewed_at=now(),
        )
        existing_item = semantic_registry.store.get(analytics_ns, f"{item.id}:1")
        semantic_registry.store.put(
            analytics_ns,
            f"{item.id}:1",
            item.model_dump(mode="json"),
            expected_revision=existing_item["revision"] if existing_item else 0,
        )
        published_refs.append({"id": item.id, "revision": 1})
        known[signature] = item.model_dump(mode='json')

    # Preserve existing published items on this dataset and append/update newly selected ones
    dashboard_ns = semantic_registry.namespace(entry, version, f"dashboard:{semantic_revision}")
    existing_pub = semantic_registry.store.get(dashboard_ns, "published")
    merged_refs = []
    seen_refs = set()
    for ref in (existing_pub["value"].get("items", []) if existing_pub else []) + published_refs:
        ref_key = (ref.get("id"), ref.get("revision"))
        if ref_key not in seen_refs:
            seen_refs.add(ref_key)
            merged_refs.append(ref)

    publication_payload = {
        "title": req.title or "Executive Analytics Dashboard",
        "items": merged_refs,
    }
    semantic_registry.store.put(
        dashboard_ns,
        "published",
        publication_payload,
        expected_revision=existing_pub["revision"] if existing_pub else 0,
    )

    clear_dashboard_cache()
    semantic_registry._invalidate_cache()
    logger.info(f"Published {len(published_refs)} widgets to dashboard namespace: {dashboard_ns}")

    return {
        "status": "success",
        "message": f"Successfully published {len(published_refs)} widgets to the Executive Dashboard.",
        "published_count": len(published_refs),
        "title": req.title
    }


@router.get("")
def get_dashboard(refresh: bool = False):
    if refresh:
        clear_dashboard_cache()

    catalog = dataset_service._catalog()
    datasets_map = catalog.get("datasets", {})

    # If no datasets exist in the catalog (e.g. all were deleted), return clean empty state
    if not datasets_map:
        clear_dashboard_cache()
        return {
            "title": "Executive Analytics Dashboard",
            "widgets": [],
            "status": "empty",
            "message": "No datasets available. Upload a dataset to view analytics."
        }

    selection = current_selection.get()
    if selection is None:
        # Auto-bind to the active or first available dataset
        active_ds = next((d for d in datasets_map.values() if d.get("isActive")), None) or next(iter(datasets_map.values()), None)
        if active_ds:
            from api.models.execution_context import DatasetSelection, ExecutionContext
            ds_version = active_ds.get("currentVersion") or 1
            try:
                ds_snapshot = dataset_service._snapshot(active_ds, ds_version)
                ds_models = semantic_registry.list(active_ds, ds_version, for_chat=True)
                approved_models = [m for m in ds_models if m.get("status") == "approved"]
                ds_sem_rev = max([m["revision"] for m in approved_models], default=None) or (
                    max([m["revision"] for m in ds_models], default=1) if ds_models else 1
                )
                ctx = ExecutionContext(
                    workspace_id=active_ds.get("workspaceId") or "default",
                    dataset_id=active_ds["id"],
                    version=ds_version,
                    semantic_revision=ds_sem_rev,
                    user_id="system"
                )
                selection = DatasetSelection(ctx, active_ds, ds_snapshot)
            except Exception as auto_bind_exc:
                logger.warning(f"Could not auto-bind default dataset selection: {auto_bind_exc}")

    if selection is None:
        clear_dashboard_cache()
        return {
            "title": "Executive Analytics Dashboard",
            "widgets": [],
            "status": "empty",
            "message": "No active dataset selected."
        }

    context = selection.context

    # Collect published dashboards across all datasets in the workspace so uploading a new file
    # never removes KPIs and charts published from earlier datasets.
    dataset_publications = []
    pub_revisions = []
    for ds_id, ds_entry in datasets_map.items():
        if ds_entry.get("workspaceId") and ds_entry.get("workspaceId") != context.workspace_id:
            continue
        ds_version = ds_entry.get("currentVersion") or 1
        try:
            ds_models = semantic_registry.list(ds_entry, ds_version, for_chat=True)
            approved_models = [m for m in ds_models if m.get("status") == "approved"]
            ds_sem_rev = max([m["revision"] for m in approved_models], default=None) or (
                max([m["revision"] for m in ds_models], default=1) if ds_models else 1
            )
            ds_pub_ns = semantic_registry.namespace(ds_entry, ds_version, f"dashboard:{ds_sem_rev}")
            ds_pub = semantic_registry.store.get(ds_pub_ns, "published")
            if ds_pub and ds_pub.get("value", {}).get("items"):
                pub_revisions.append((ds_id, ds_version, ds_sem_rev, ds_pub.get("revision", 0)))
                dataset_publications.append((ds_entry, ds_version, ds_sem_rev, ds_pub["value"]))
        except Exception as exc:
            logger.warning(f"Skipping dashboard lookup for dataset {ds_id}: {exc}")

    cache_key = (
        context.workspace_id,
        context.dataset_id,
        context.version,
        context.semantic_revision,
        tuple(sorted(pub_revisions)),
    )

    now = time.time()
    if not refresh:
        with _DASHBOARD_CACHE_LOCK:
            if cache_key in _DASHBOARD_CACHE:
                cached_entry = _DASHBOARD_CACHE[cache_key]
                if now - cached_entry.get("timestamp", 0) < _DASHBOARD_CACHE_TTL:
                    return cached_entry["data"]

    if dataset_publications:
        from api.models.execution_context import DatasetSelection, ExecutionContext

        dataset_publications.sort(key=lambda x: 0 if x[0].get("id") == context.dataset_id else 1)
        tasks = []
        seen_widget_keys = set()
        for ds_entry, ds_version, ds_sem_rev, pub_val in dataset_publications:
            ds_id = ds_entry["id"]
            ds_name = ds_entry.get("displayName") or ds_entry.get("name") or ds_entry.get("folder") or ds_id
            definitions = semantic_registry.items(ds_entry, ds_version, ds_sem_rev, allow_chat_member=True)
            ds_snapshot = dataset_service._snapshot(ds_entry, ds_version)
            ds_context = ExecutionContext(
                workspace_id=context.workspace_id,
                dataset_id=ds_id,
                version=ds_version,
                semantic_revision=ds_sem_rev,
                user_id=context.user_id,
            )
            ds_selection = DatasetSelection(ds_context, ds_entry, ds_snapshot)
            for ref in pub_val.get("items", []):
                item = next((i for i in definitions if i.id == ref.get("id") and i.revision == ref.get("revision")), None)
                if item is None:
                    continue
                dedupe_key = (ds_id, item.id, item.revision)
                if dedupe_key in seen_widget_keys:
                    continue
                seen_widget_keys.add(dedupe_key)
                tasks.append((ds_selection, ds_id, ds_name, item))

        def _execute_widget(task):
            ds_sel, ds_id, ds_name, item = task
            tok = current_selection.set(ds_sel)
            try:
                res = analytics_engine.execute(item.query_plan.model_dump(exclude_none=True, by_alias=True))
                defn = item.model_dump(mode="json")
                defn["dataset_id"] = ds_id
                defn["dataset_name"] = ds_name
                return {"definition": defn, "result": res.to_dict()}
            except Exception as exc:
                logger.warning(f"Error executing dashboard widget {item.id} ({item.title}): {exc}")
                return None
            finally:
                current_selection.reset(tok)

        widgets = []
        if tasks:
            with ThreadPoolExecutor(max_workers=min(16, len(tasks))) as executor:
                futures = [executor.submit(contextvars.copy_context().run, _execute_widget, t) for t in tasks]
                widgets = [w for w in (f.result() for f in futures) if w is not None]

        active_pub_title = next(
            (pub_val.get("title") for ds_entry, _, _, pub_val in dataset_publications if ds_entry["id"] == context.dataset_id),
            None,
        )
        response_data = {
            "title": active_pub_title or "Executive Analytics Dashboard",
            "widgets": widgets,
            "context": context.model_dump(),
            "status": "published",
        }
        with _DASHBOARD_CACHE_LOCK:
            _DASHBOARD_CACHE[cache_key] = {"data": response_data, "timestamp": time.time()}
        return response_data

    # Ensure model exists for auto-recommendation fallback
    try:
        model = semantic_registry.get(selection.entry, context.version, context.semantic_revision)
    except Exception:
        model = None

    # Fallback auto-recommendations if unpublished: generate from model so dashboard is never empty
    if model:
        try:
            snapshot = dataset_service._snapshot(selection.entry, context.version)
            df = dataset_service._frame(snapshot["rows"], snapshot["columns"])
            recs = chart_recommender_agent.recommend(df, model, fast_only=True)

            default_recs = [r for r in recs if r.get("selected_by_default")]

            ds_name = selection.entry.get("displayName") or selection.entry.get("name") or selection.entry.get("folder") or context.dataset_id

            def _execute_auto_widget(r):
                res = analytics_engine.execute(r["query_plan"])
                definition = {
                    "id": r["id"],
                    "title": r["title"],
                    "kind": r["kind"],
                    "revision": 1,
                    "semantic_revision": context.semantic_revision,
                    "query_plan": r["query_plan"],
                    "explanation": r["explanation"],
                    "status": "approved",
                    "dataset_id": context.dataset_id,
                    "dataset_name": ds_name,
                }
                return {"definition": definition, "result": res.to_dict()}

            auto_widgets = []
            if default_recs:
                with ThreadPoolExecutor(max_workers=min(8, len(default_recs))) as executor:
                    futures = [executor.submit(contextvars.copy_context().run, _execute_auto_widget, r) for r in default_recs]
                    auto_widgets = [f.result() for f in futures]

            if auto_widgets:
                response_data = {
                    "title": f"{model.domain.title()} Executive Dashboard",
                    "widgets": auto_widgets,
                    "context": context.model_dump(),
                    "status": "auto_recommended",
                }
                with _DASHBOARD_CACHE_LOCK:
                    _DASHBOARD_CACHE[cache_key] = {"data": response_data, "timestamp": time.time()}
                return response_data
        except Exception as exc:
            logger.warning(f"Auto-dashboard recommendation error: {exc}")

    return {
        "title": "Analytics dashboard",
        "widgets": [],
        "context": context.model_dump(),
        "status": "unpublished"
    }


clear_dashboard_cache()
