"""Dataset review and approved analytical definitions, used by the existing screens."""

from typing import Literal
from fastapi import APIRouter, File, HTTPException, UploadFile, Form
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.models.execution_context import current_selection, require_dataset_access
from api.models.query_plan import QueryPlan
from api.platform.contracts import AnalyticsItem, SemanticModel, TransformationPlan
from api.platform.ingestion import ingestion_service
from api.platform.semantic import semantic_registry
from api.platform.workflow import workflow_orchestrator
from api.services.analytics_engine import analytics_engine
from api.services.dataset_service import dataset_service

router = APIRouter(tags=["Semantic Analytics"])


def dataset_version(dataset_id, version, for_chat: bool = False):
    entry = dataset_service._entry(
        dataset_service._catalog(), dataset_id, for_chat=for_chat
    )
    return entry, dataset_service._snapshot(entry, version)


class Review(BaseModel):
    decision: Literal["approved", "rejected"]


class ReuseDefinitions(BaseModel):
    source_version: int = Field(ge=1)
    semantic_revision: int = Field(ge=1)


class DeleteDefinitionRef(BaseModel):
    id: str
    revision: int = Field(ge=1)


class DeleteDefinitionsRequest(BaseModel):
    items: list[DeleteDefinitionRef]


@router.post("/api/datasets/{dataset_id}/versions/{version}/reuse")
def reuse_definitions(dataset_id: str, version: int, body: ReuseDefinitions):
    entry, snapshot = dataset_version(dataset_id, version)
    source = dataset_service._snapshot(entry, body.source_version)
    return semantic_registry.reuse(
        entry, body.source_version, version, body.semantic_revision, source, snapshot
    )


class DashboardPublication(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    items: list[dict] = Field(max_length=50)


def _resolve_semantic_rev(entry: dict, version_obj: dict | None = None) -> int:
    """Safely resolve the active semantic revision for a dataset version.
    Handles None or missing values in catalog and falls back to latest approved revision or 1."""
    if version_obj is not None:
        rev = version_obj.get("semanticRevision")
        if rev is not None:
            try:
                return int(rev)
            except (ValueError, TypeError):
                pass
    cur_v = entry.get("currentVersion", 1)
    try:
        models = semantic_registry.list(entry, cur_v)
        approved = [m["revision"] for m in models if m.get("status") == "approved"]
        if approved:
            return max(approved)
        if models:
            return max(m["revision"] for m in models)
    except Exception:
        pass
    return 1


@router.get("/api/insights/dashboard")
def get_dashboard_publication(all: bool = False):
    if all:
        catalog = dataset_service._catalog()
        all_published_items = []
        for entry in catalog.get("datasets", {}).values():
            try:
                require_dataset_access(entry)
            except HTTPException:
                continue
            cur_v = entry.get("currentVersion", 1)
            v_obj = next(
                (v for v in entry.get("versions", []) if v.get("version") == cur_v), {}
            )
            s_rev = _resolve_semantic_rev(entry, v_obj)
            ns = semantic_registry.namespace(entry, cur_v, f"dashboard:{s_rev}")
            pub = semantic_registry.store.get(ns, "published")
            if pub and "items" in pub.get("value", {}):
                all_published_items.extend(
                    {
                        **reference,
                        "dataset_id": entry["id"],
                        "version": cur_v,
                        "semantic_revision": s_rev,
                    }
                    for reference in pub["value"]["items"]
                )
        return {
            "title": "Executive Analytics Dashboard",
            "items": all_published_items,
            "status": "published" if all_published_items else "unpublished",
        }

    value = selected()
    namespace = semantic_registry.namespace(
        value.entry,
        value.context.version,
        f"dashboard:{value.context.semantic_revision}",
    )
    publication = semantic_registry.store.get(namespace, "published")
    if publication is None:
        return {
            "title": "Executive Analytics Dashboard",
            "items": [],
            "status": "unpublished",
        }
    return {
        "title": publication["value"].get("title", "Executive Analytics Dashboard"),
        "items": publication["value"].get("items", []),
        "status": "published",
    }


@router.post("/api/insights/dashboard")
def publish_dashboard(publication: DashboardPublication):
    catalog = dataset_service._catalog()
    selection = current_selection.get()
    item_map = {}
    for entry in catalog.get("datasets", {}).values():
        try:
            require_dataset_access(entry)
        except HTTPException:
            continue
        cur_v = entry.get("currentVersion", 1)
        v_obj = next(
            (v for v in entry.get("versions", []) if v.get("version") == cur_v), {}
        )
        s_rev = _resolve_semantic_rev(entry, v_obj)
        if selection and selection.context.dataset_id == entry["id"]:
            cur_v = selection.context.version
            s_rev = selection.context.semantic_revision
        try:
            for it in semantic_registry.items(entry, cur_v, s_rev):
                item_map[(it.id, it.revision)] = (entry, cur_v, s_rev, it)
        except Exception:
            continue

    grouped = {}
    for reference in publication.items:
        key = (reference.get("id"), reference.get("revision"))
        if key not in item_map:
            raise HTTPException(404, f"Definition {key[0]} not found.")
        entry, v, s_rev, item = item_map[key]
        if item.status != "approved":
            raise HTTPException(
                409,
                f"Only approved definition revisions may be published: '{item.title}' is currently {item.status}.",
            )
        ds_id = entry["id"]
        if ds_id not in grouped:
            grouped[ds_id] = {
                "entry": entry,
                "version": v,
                "semantic_revision": s_rev,
                "items": [],
            }
        grouped[ds_id]["items"].append(reference)

    last_res = None
    for ds_info in grouped.values():
        entry = ds_info["entry"]
        state = next(
            (
                v.get("ingestionStatus", entry.get("ingestionStatus"))
                for v in entry.get("versions", [])
                if v["version"] == ds_info["version"]
            ),
            entry.get("ingestionStatus"),
        )
        if state == "partial":
            raise HTTPException(
                409,
                "Complete the failed ingestion stages before publishing this dataset.",
            )
    for ds_info in grouped.values():
        ns = semantic_registry.namespace(
            ds_info["entry"],
            ds_info["version"],
            f"dashboard:{ds_info['semantic_revision']}",
        )
        prev = semantic_registry.store.get(ns, "published")
        refs = (prev["value"].get("items", []) if prev else []) + ds_info["items"]
        merged = list({(ref["id"], ref["revision"]): ref for ref in refs}.values())
        last_res = semantic_registry.store.put(
            ns,
            "published",
            {"title": publication.title, "items": merged},
            prev["revision"] if prev else 0,
        )

    try:
        from api.routes.dashboard import clear_dashboard_cache

        clear_dashboard_cache()
    except Exception:
        pass
    return last_res or {"status": "success"}


@router.post("/api/upload/discover")
async def discover(file: UploadFile = File(...)):
    return await run_in_threadpool(
        ingestion_service.discover, await file.read(), file.filename
    )


@router.post("/api/upload/preview")
async def preview(file: UploadFile = File(...), plan: str = Form("{}")):
    try:
        transformation = TransformationPlan.model_validate_json(plan)
    except ValueError:
        raise HTTPException(422, "Invalid transformation plan.") from None
    df, profile = await run_in_threadpool(
        ingestion_service.prepare, await file.read(), file.filename, transformation
    )
    return {
        "profile": profile.model_dump(mode="json"),
        "preview": dataset_service._rows(df.head(20)),
        "columns": dataset_service._columns(df),
        "plan": transformation.model_dump(mode="json"),
    }


@router.get("/api/datasets/{dataset_id}/versions/{version}/profile")
def profile(dataset_id: str, version: int):
    _, snapshot = dataset_version(dataset_id, version)
    return {
        "profile": snapshot.get("dataProfile"),
        "transformation_plan": snapshot.get("transformationPlan"),
        "row_count": len(snapshot["rows"]),
        "columns": snapshot["columns"],
    }


@router.get("/api/datasets/{dataset_id}/versions/{version}/semantics")
def semantics(dataset_id: str, version: int):
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id, for_chat=True)
    if not any(item["version"] == version for item in entry.get("versions", [])):
        raise HTTPException(404, "Dataset version not found.")
    return semantic_registry.list(entry, version, for_chat=True)


@router.post("/api/datasets/{dataset_id}/versions/{version}/semantics/propose")
def propose(dataset_id: str, version: int):
    entry, snapshot = dataset_version(dataset_id, version)
    return workflow_orchestrator.propose_semantics(entry, version, snapshot)


@router.post("/api/datasets/{dataset_id}/versions/{version}/semantics")
def revise(dataset_id: str, version: int, model: SemanticModel):
    entry, snapshot = dataset_version(dataset_id, version)
    return workflow_orchestrator.propose_semantics(
        entry, version, snapshot, model.model_dump(mode="json")
    )


@router.post(
    "/api/datasets/{dataset_id}/versions/{version}/semantics/{revision}/review"
)
def review(dataset_id: str, version: int, revision: int, body: Review):
    entry, _ = dataset_version(dataset_id, version)
    result = semantic_registry.review(entry, version, revision, body.decision)
    workflow_orchestrator.save(
        entry,
        version,
        "semantic_review",
        "completed" if body.decision == "approved" else "awaiting_review",
        {"semantic_revision": revision, "semantic_decision": body.decision},
    )
    if body.decision == "approved":
        try:
            with dataset_service._writer():
                cat = dataset_service._catalog()
                rentry = dataset_service._entry(cat, dataset_id)
                for v in rentry.get("versions", []):
                    if v.get("version") == version:
                        v["semanticRevision"] = revision
                dataset_service._write_json(dataset_service.catalog_path, cat)
        except Exception:
            pass
    return result


class ResolveJoinRequest(BaseModel):
    left_dataset_id: str
    right_dataset_id: str


@router.post("/api/analytics/resolve-join")
def resolve_join_endpoint(body: ResolveJoinRequest):
    from api.platform.join_service import join_service

    return join_service.resolve_join(body.left_dataset_id, body.right_dataset_id)


@router.get("/api/analytics/join-graph")
def join_graph_endpoint():
    from api.platform.join_service import join_service

    return {"edges": join_service.get_workspace_join_graph()}


def selected():
    value = current_selection.get()
    if value is None:
        raise HTTPException(409, "Select a dataset version.")
    return value


@router.post("/api/insights/execute")
def execute(plan: QueryPlan):
    value = selected()
    result = analytics_engine.execute(plan.model_dump(exclude_none=True, by_alias=True))
    return {
        **result.to_dict(),
        "context": value.context.model_dump(),
        "query_plan": plan.model_dump(exclude_none=True, by_alias=True),
    }


@router.get("/api/insights/recommendations")
def recommendations(all: bool = False, dataset_id: str | None = None):
    if all:
        catalog = dataset_service._catalog()
        all_items = []
        for entry in catalog.get("datasets", {}).values():
            try:
                require_dataset_access(entry)
            except HTTPException:
                continue
            cur_version = entry.get("currentVersion", 1)
            version_obj = next(
                (
                    v
                    for v in entry.get("versions", [])
                    if v.get("version") == cur_version
                ),
                entry.get("versions", [{}])[-1] if entry.get("versions") else {},
            )
            semantic_rev = _resolve_semantic_rev(entry, version_obj)
            source_file = (
                entry.get("sourceFilename")
                or entry.get("source_filename")
                or entry.get("sourceFile")
                or version_obj.get("sourceFilename")
                or entry.get("name")
            )
            display_name = (
                entry.get("displayName")
                or entry.get("display_name")
                or entry.get("name")
            )
            table_name = entry.get("tableName") or entry.get("table_name")

            try:
                items = semantic_registry.items(entry, cur_version, semantic_rev)
                for it in items:
                    it_dict = (
                        it.model_dump()
                        if hasattr(it, "model_dump")
                        else (it.dict() if hasattr(it, "dict") else dict(it))
                    )
                    it_dict["dataset_id"] = entry["id"]
                    it_dict["dataset_name"] = display_name
                    it_dict["source_file"] = source_file
                    it_dict["table_name"] = table_name
                    it_dict["version"] = cur_version
                    it_dict["semantic_revision"] = semantic_rev
                    all_items.append(it_dict)
            except Exception:
                continue
        return all_items

    if dataset_id:
        catalog = dataset_service._catalog()
        entry = dataset_service._entry(catalog, dataset_id)
        require_dataset_access(entry)
        cur_version = entry.get("currentVersion", 1)
        version_obj = next(
            (v for v in entry.get("versions", []) if v.get("version") == cur_version),
            entry.get("versions", [{}])[-1] if entry.get("versions") else {},
        )
        semantic_rev = _resolve_semantic_rev(entry, version_obj)
        source_file = (
            entry.get("sourceFilename")
            or entry.get("source_filename")
            or entry.get("sourceFile")
            or version_obj.get("sourceFilename")
            or entry.get("name")
        )
        display_name = (
            entry.get("displayName") or entry.get("display_name") or entry.get("name")
        )
        table_name = entry.get("tableName") or entry.get("table_name")
        items = semantic_registry.items(entry, cur_version, semantic_rev)
        result_items = []
        for it in items:
            it_dict = (
                it.model_dump()
                if hasattr(it, "model_dump")
                else (it.dict() if hasattr(it, "dict") else dict(it))
            )
            it_dict["dataset_id"] = entry["id"]
            it_dict["dataset_name"] = display_name
            it_dict["source_file"] = source_file
            it_dict["table_name"] = table_name
            it_dict["version"] = cur_version
            it_dict["semantic_revision"] = semantic_rev
            result_items.append(it_dict)
        return result_items

    value = selected()
    items = semantic_registry.items(
        value.entry, value.context.version, value.context.semantic_revision
    )
    source_file = (
        value.entry.get("sourceFilename")
        or value.entry.get("source_filename")
        or value.entry.get("sourceFile")
        or value.entry.get("name")
    )
    display_name = (
        value.entry.get("displayName")
        or value.entry.get("display_name")
        or value.entry.get("name")
    )
    table_name = value.entry.get("tableName") or value.entry.get("table_name")
    result_items = []
    for it in items:
        it_dict = (
            it.model_dump()
            if hasattr(it, "model_dump")
            else (it.dict() if hasattr(it, "dict") else dict(it))
        )
        it_dict["dataset_id"] = value.entry.get("id", value.context.dataset_id)
        it_dict["dataset_name"] = display_name
        it_dict["source_file"] = source_file
        it_dict["table_name"] = table_name
        it_dict["version"] = value.context.version
        it_dict["semantic_revision"] = value.context.semantic_revision
        result_items.append(it_dict)
    return result_items


@router.post("/api/insights/recommendations")
def propose_analytics(fast: bool = False):
    value = selected()
    return workflow_orchestrator.propose_analytics(
        value.entry,
        value.context.version,
        value.context.semantic_revision,
        value.snapshot,
        fast_only=fast,
    )


@router.get("/api/datasets/{dataset_id}/versions/{version}/workflow")
def workflow_status(dataset_id: str, version: int):
    entry, _ = dataset_version(dataset_id, version)
    return workflow_orchestrator.state(entry, version)


@router.post("/api/insights/definitions")
def revise_item(item: AnalyticsItem):
    value = selected()
    result = analytics_engine.execute(
        item.query_plan.model_dump(exclude_none=True, by_alias=True)
    )
    if not result.success:
        raise HTTPException(422, result.error)
    return semantic_registry.save_item(
        value.entry,
        value.context.version,
        value.context.semantic_revision,
        item.model_dump(mode="json"),
    )


@router.post("/api/insights/definitions/{item_id}/{revision}/review")
def review_item(item_id: str, revision: int, body: Review):
    value = selected()
    require_dataset_access(value.entry)
    target_entry = value.entry
    target_version = value.context.version
    target_sem_rev = value.context.semantic_revision

    items = semantic_registry.items(target_entry, target_version, target_sem_rev)
    item = next((i for i in items if i.id == item_id and i.revision == revision), None)
    if item is None:
        # Search other datasets in catalog if item belongs to a different uploaded file
        catalog = dataset_service._catalog()
        for e in catalog.get("datasets", {}).values():
            if e.get("id") == value.entry.get("id"):
                continue
            cur_v = e.get("currentVersion", 1)
            v_obj = next(
                (v for v in e.get("versions", []) if v.get("version") == cur_v), {}
            )
            s_rev = _resolve_semantic_rev(e, v_obj)
            try:
                candidate_items = semantic_registry.items(e, cur_v, s_rev)
                found = next(
                    (
                        i
                        for i in candidate_items
                        if i.id == item_id and i.revision == revision
                    ),
                    None,
                )
                if found is not None:
                    require_dataset_access(e)
                    item = found
                    target_entry = e
                    target_version = cur_v
                    target_sem_rev = s_rev
                    break
            except Exception:
                continue

    if item is None:
        raise HTTPException(404, "Definition not found.")
    if body.decision == "approved":
        result = analytics_engine.execute(
            item.query_plan.model_dump(exclude_none=True, by_alias=True)
        )
        if not result.success:
            raise HTTPException(422, result.error)
    reviewed = semantic_registry.review_item(
        target_entry, target_version, target_sem_rev, item_id, revision, body.decision
    )
    remaining = any(
        item.status == "proposed"
        for item in semantic_registry.items(
            target_entry, target_version, target_sem_rev
        )
    )
    workflow_orchestrator.save(
        target_entry,
        target_version,
        "analytics_review",
        "awaiting_review" if remaining else "completed",
        {
            "last_reviewed_item": {
                "id": item_id,
                "revision": revision,
                "decision": body.decision,
            }
        },
    )
    from api.routes.dashboard import clear_dashboard_cache

    clear_dashboard_cache()
    return reviewed


@router.delete("/api/insights/definitions/{item_id}/{revision}")
def delete_item(item_id: str, revision: int):
    value = selected()
    deleted = semantic_registry.delete_items(
        value.entry,
        value.context.version,
        value.context.semantic_revision,
        [(item_id, revision)],
    )
    if deleted == 0:
        catalog = dataset_service._catalog()
        for e in catalog.get("datasets", {}).values():
            if e.get("id") == value.entry.get("id"):
                continue
            cur_v = e.get("currentVersion", 1)
            v_obj = next(
                (v for v in e.get("versions", []) if v.get("version") == cur_v), {}
            )
            s_rev = _resolve_semantic_rev(e, v_obj)
            try:
                del_count = semantic_registry.delete_items(
                    e, cur_v, s_rev, [(item_id, revision)]
                )
                if del_count > 0:
                    deleted = del_count
                    break
            except Exception:
                continue

    if deleted == 0:
        raise HTTPException(404, "Definition not found.")
    from api.routes.dashboard import clear_dashboard_cache

    clear_dashboard_cache()
    return {"deleted": deleted}


@router.post("/api/insights/definitions/delete")
def delete_items_bulk(body: DeleteDefinitionsRequest):
    value = selected()
    targets = [(item.id, item.revision) for item in body.items]
    deleted = semantic_registry.delete_items(
        value.entry, value.context.version, value.context.semantic_revision, targets
    )
    if deleted < len(targets):
        catalog = dataset_service._catalog()
        for e in catalog.get("datasets", {}).values():
            if e.get("id") == value.entry.get("id"):
                continue
            cur_v = e.get("currentVersion", 1)
            v_obj = next(
                (v for v in e.get("versions", []) if v.get("version") == cur_v), {}
            )
            s_rev = _resolve_semantic_rev(e, v_obj)
            try:
                extra_del = semantic_registry.delete_items(e, cur_v, s_rev, targets)
                deleted += extra_del
            except Exception:
                continue
    if deleted > 0:
        from api.routes.dashboard import clear_dashboard_cache

        clear_dashboard_cache()
    return {"deleted": deleted}
