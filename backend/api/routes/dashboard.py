import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from api.models.execution_context import current_selection
from api.platform.semantic import semantic_registry
from api.platform.contracts import AnalyticsItem
from api.platform.agent_chart_recommender import chart_recommender_agent
from api.services.analytics_engine import analytics_engine
from api.services.dataset_service import dataset_service
from api.utils.logger import get_logger

logger = get_logger("routes.dashboard")

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"])

_DASHBOARD_CACHE = {}
_DASHBOARD_CACHE_LOCK = threading.Lock()


def clear_dashboard_cache():
    with _DASHBOARD_CACHE_LOCK:
        _DASHBOARD_CACHE.clear()


class PublishRecommendedRequest(BaseModel):
    items: List[Dict[str, Any]]
    title: Optional[str] = "Executive Analytics Dashboard"


@router.post("/publish-recommended")
def publish_recommended_charts(req: PublishRecommendedRequest):
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

    # Auto-approve semantic model if currently proposed
    try:
        model = semantic_registry.get(entry, version, semantic_revision)
        if model.status != "approved":
            semantic_registry.review(entry, version, semantic_revision, "approved")
    except Exception as exc:
        logger.warning(f"Semantic model auto-approval note: {exc}")

    analytics_ns = semantic_registry.namespace(entry, version, f"analytics:{semantic_revision}")
    published_refs = []

    for item_data in req.items:
        item_id = item_data.get("id") or ("rec_" + uuid.uuid4().hex[:12])
        query_plan = item_data.get("query_plan", {})
        title = item_data.get("title", "Metric Chart")
        kind = item_data.get("kind", "bar")
        explanation = item_data.get("explanation", "Recommended analytical chart.")

        item = AnalyticsItem(
            id=item_id,
            title=title,
            kind=kind,
            revision=1,
            semantic_revision=semantic_revision,
            query_plan=query_plan,
            dependencies=[],
            explanation=explanation,
            status="approved"
        )
        semantic_registry.store.put(analytics_ns, f"{item.id}:1", item.model_dump(mode="json"))
        published_refs.append({"id": item.id, "revision": 1})

    # Save published dashboard configuration
    dashboard_ns = semantic_registry.namespace(entry, version, f"dashboard:{semantic_revision}")
    publication_payload = {
        "title": req.title or "Executive Analytics Dashboard",
        "items": published_refs
    }
    semantic_registry.store.put(dashboard_ns, "published", publication_payload)

    clear_dashboard_cache()
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

    selection = current_selection.get()
    if selection is None:
        raise HTTPException(409, "Select a dataset version.")

    context = selection.context
    cache_key = (
        context.workspace_id,
        context.dataset_id,
        context.version,
        context.semantic_revision,
    )

    if not refresh:
        with _DASHBOARD_CACHE_LOCK:
            if cache_key in _DASHBOARD_CACHE:
                return _DASHBOARD_CACHE[cache_key]

    # Ensure model exists
    try:
        model = semantic_registry.get(selection.entry, context.version, context.semantic_revision)
    except Exception:
        model = None

    namespace = semantic_registry.namespace(selection.entry, context.version, f"dashboard:{context.semantic_revision}")
    publication = semantic_registry.store.get(namespace, "published")

    # If already published, execute published widgets
    if publication is not None and publication.get("value", {}).get("items"):
        items_to_compute = publication["value"]["items"]
        definitions = semantic_registry.items(selection.entry, context.version, context.semantic_revision)

        def _execute_widget(reference):
            item = next((i for i in definitions if i.id == reference["id"] and i.revision == reference["revision"]), None)
            if item is None:
                return None
            res = analytics_engine.execute(item.query_plan.model_dump(exclude_none=True, by_alias=True))
            return {"definition": item.model_dump(mode="json"), "result": res.to_dict()}

        with ThreadPoolExecutor(max_workers=min(16, max(1, len(items_to_compute)))) as executor:
            widgets = [w for w in executor.map(_execute_widget, items_to_compute) if w is not None]

        response_data = {
            "title": publication["value"].get("title", "Executive Analytics Dashboard"),
            "widgets": widgets,
            "context": context.model_dump(),
            "status": "published",
        }
        with _DASHBOARD_CACHE_LOCK:
            _DASHBOARD_CACHE[cache_key] = response_data
        return response_data

    # Fallback auto-recommendations if unpublished: generate from model so dashboard is never empty
    if model:
        try:
            snapshot = dataset_service._snapshot(selection.entry, context.version)
            df = dataset_service._frame(snapshot["rows"], snapshot["columns"])
            recs = chart_recommender_agent.recommend(df, model)

            auto_widgets = []
            for r in recs:
                if r.get("selected_by_default"):
                    res = analytics_engine.execute(r["query_plan"])
                    definition = {
                        "id": r["id"],
                        "title": r["title"],
                        "kind": r["kind"],
                        "revision": 1,
                        "semantic_revision": context.semantic_revision,
                        "query_plan": r["query_plan"],
                        "explanation": r["explanation"],
                        "status": "approved"
                    }
                    auto_widgets.append({"definition": definition, "result": res.to_dict()})

            if auto_widgets:
                response_data = {
                    "title": f"{model.domain.title()} Executive Dashboard",
                    "widgets": auto_widgets,
                    "context": context.model_dump(),
                    "status": "auto_recommended",
                }
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
