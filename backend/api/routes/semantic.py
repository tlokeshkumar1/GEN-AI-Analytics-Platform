"""Dataset review and approved analytical definitions, used by the existing screens."""
from typing import Literal
from fastapi import APIRouter, File, HTTPException, UploadFile, Form
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.models.execution_context import current_selection, require_dataset_access, current_identity, is_admin
from api.models.query_plan import QueryPlan
from api.platform.contracts import AnalyticsItem, SemanticModel, TransformationPlan
from api.platform.ingestion import ingestion_service
from api.platform.semantic import semantic_registry
from api.platform.workflow import workflow_orchestrator
from api.services.analytics_engine import analytics_engine
from api.services.dataset_service import dataset_service

router = APIRouter(tags=["Semantic Analytics"])


def dataset_version(dataset_id, version):
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id)
    return entry, dataset_service._snapshot(entry, version)


class Review(BaseModel):
    decision: Literal["approved", "rejected"]


class ReuseDefinitions(BaseModel):
    source_version: int = Field(ge=1)
    semantic_revision: int = Field(ge=1)


@router.post("/api/datasets/{dataset_id}/versions/{version}/reuse")
def reuse_definitions(dataset_id: str, version: int, body: ReuseDefinitions):
    entry, snapshot = dataset_version(dataset_id, version)
    source = dataset_service._snapshot(entry, body.source_version)
    return semantic_registry.reuse(entry, body.source_version, version, body.semantic_revision, source, snapshot)


class DashboardPublication(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    items: list[dict] = Field(max_length=50)


@router.get("/api/insights/dashboard")
def get_dashboard_publication():
    value = selected()
    namespace = semantic_registry.namespace(value.entry, value.context.version, f"dashboard:{value.context.semantic_revision}")
    publication = semantic_registry.store.get(namespace, "published")
    if publication is None:
        return {"title": "Executive Analytics Dashboard", "items": [], "status": "unpublished"}
    return {
        "title": publication["value"].get("title", "Executive Analytics Dashboard"),
        "items": publication["value"].get("items", []),
        "status": "published",
    }


@router.post("/api/insights/dashboard")
def publish_dashboard(publication: DashboardPublication):
    identity = current_identity.get()
    if identity and not is_admin(identity):
        raise HTTPException(403, "Only Admin accounts can publish widgets to the dashboard.")
    value = selected()
    require_dataset_access(value.entry, write=True)
    items = semantic_registry.items(value.entry, value.context.version, value.context.semantic_revision)
    for reference in publication.items:
        item = next((i for i in items if i.id == reference.get("id") and i.revision == reference.get("revision")), None)
        if item is None or item.status != "approved":
            raise HTTPException(409, "Only approved definition revisions may be published.")
    namespace = semantic_registry.namespace(value.entry, value.context.version, f"dashboard:{value.context.semantic_revision}")
    previous = semantic_registry.store.get(namespace, "published")
    try:
        from api.routes.dashboard import clear_dashboard_cache
        clear_dashboard_cache()
    except Exception:
        pass
    return semantic_registry.store.put(namespace, "published", publication.model_dump(), previous["revision"] if previous else 0)


@router.post("/api/upload/discover")
async def discover(file: UploadFile = File(...)):
    return await run_in_threadpool(ingestion_service.discover, await file.read(), file.filename)


@router.post("/api/upload/preview")
async def preview(file: UploadFile = File(...), plan: str = Form("{}")):
    try:
        transformation = TransformationPlan.model_validate_json(plan)
    except ValueError:
        raise HTTPException(422, "Invalid transformation plan.") from None
    df, profile = await run_in_threadpool(ingestion_service.prepare, await file.read(), file.filename, transformation)
    return {"profile": profile.model_dump(mode="json"), "preview": dataset_service._rows(df.head(20)),
            "columns": dataset_service._columns(df), "plan": transformation.model_dump(mode="json")}


@router.get("/api/datasets/{dataset_id}/versions/{version}/profile")
def profile(dataset_id: str, version: int):
    _, snapshot = dataset_version(dataset_id, version)
    return {"profile": snapshot.get("dataProfile"), "transformation_plan": snapshot.get("transformationPlan"),
            "row_count": len(snapshot["rows"]), "columns": snapshot["columns"]}


@router.get("/api/datasets/{dataset_id}/versions/{version}/semantics")
def semantics(dataset_id: str, version: int):
    entry, _ = dataset_version(dataset_id, version)
    return semantic_registry.list(entry, version)


@router.post("/api/datasets/{dataset_id}/versions/{version}/semantics/propose")
def propose(dataset_id: str, version: int):
    entry, snapshot = dataset_version(dataset_id, version)
    return workflow_orchestrator.propose_semantics(entry, version, snapshot)


@router.post("/api/datasets/{dataset_id}/versions/{version}/semantics")
def revise(dataset_id: str, version: int, model: SemanticModel):
    entry, snapshot = dataset_version(dataset_id, version)
    return workflow_orchestrator.propose_semantics(entry, version, snapshot, model.model_dump(mode="json"))


@router.post("/api/datasets/{dataset_id}/versions/{version}/semantics/{revision}/review")
def review(dataset_id: str, version: int, revision: int, body: Review):
    entry, _ = dataset_version(dataset_id, version)
    result = semantic_registry.review(entry, version, revision, body.decision)
    workflow_orchestrator.save(entry, version, "semantic_review", "completed" if body.decision == "approved" else "awaiting_review",
                               {"semantic_revision": revision, "semantic_decision": body.decision})
    return result


def selected():
    value = current_selection.get()
    if value is None:
        raise HTTPException(409, "Select a dataset version.")
    return value


@router.post("/api/insights/execute")
def execute(plan: QueryPlan):
    value = selected()
    result = analytics_engine.execute(plan.model_dump(exclude_none=True, by_alias=True))
    return {**result.to_dict(), "context": value.context.model_dump(), "query_plan": plan.model_dump(exclude_none=True, by_alias=True)}


@router.get("/api/insights/recommendations")
def recommendations():
    value = selected()
    return semantic_registry.items(value.entry, value.context.version, value.context.semantic_revision)


@router.post("/api/insights/recommendations")
def propose_analytics():
    value = selected()
    return workflow_orchestrator.propose_analytics(value.entry, value.context.version, value.context.semantic_revision, value.snapshot)


@router.get("/api/datasets/{dataset_id}/versions/{version}/workflow")
def workflow_status(dataset_id: str, version: int):
    entry, _ = dataset_version(dataset_id, version)
    return workflow_orchestrator.state(entry, version)


@router.post("/api/insights/definitions")
def revise_item(item: AnalyticsItem):
    value = selected()
    result = analytics_engine.execute(item.query_plan.model_dump(exclude_none=True, by_alias=True))
    if not result.success:
        raise HTTPException(422, result.error)
    return semantic_registry.save_item(value.entry, value.context.version, value.context.semantic_revision, item.model_dump(mode="json"))


@router.post("/api/insights/definitions/{item_id}/{revision}/review")
def review_item(item_id: str, revision: int, body: Review):
    identity = current_identity.get()
    if identity and not is_admin(identity):
        raise HTTPException(403, "Only Admin accounts can approve or reject definitions.")
    value = selected()
    items = semantic_registry.items(value.entry, value.context.version, value.context.semantic_revision)
    item = next((i for i in items if i.id == item_id and i.revision == revision), None)
    if item is None:
        raise HTTPException(404, "Definition not found.")
    if body.decision == "approved":
        result = analytics_engine.execute(item.query_plan.model_dump(exclude_none=True, by_alias=True))
        if not result.success:
            raise HTTPException(422, result.error)
    reviewed = semantic_registry.review_item(value.entry, value.context.version, value.context.semantic_revision,
                                             item_id, revision, body.decision)
    remaining = any(item.status == "proposed" for item in semantic_registry.items(value.entry, value.context.version, value.context.semantic_revision))
    workflow_orchestrator.save(value.entry, value.context.version, "analytics_review", "awaiting_review" if remaining else "completed",
                               {"last_reviewed_item": {"id": item_id, "revision": revision, "decision": body.decision}})
    return reviewed
