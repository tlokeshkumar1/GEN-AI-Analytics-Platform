"""Dashboard revision, layout and page operations."""

import contextvars
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import HTTPException
from api.models.content import (
    FilterEdit,
    NewFile,
    PageEdit,
    PlacementEdit,
    ResourceId,
    Revision,
)
from api.platform.content import ContentWorkspace, file_name, new_id
from api.platform.content_publication import CalculationBatch, calculate
from api.utils.logger import get_logger

logger = get_logger(__name__)
# One bounded pool per API process, shared across dashboard requests.
_widget_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="my-files-widget")


def save_dashboard(body):
    """Checkpoint a saved layout or append approved sources to a named destination."""
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        if body.dashboard_id:
            workspace = workspace.resolve(body.dashboard_id, write=True)
            doc = workspace.get(body.dashboard_id)
            if doc["kind"] != "dashboard":
                raise HTTPException(422, "Select a dashboard.")
            if doc["revision"] != body.revision:
                raise HTTPException(409, "Dashboard changed. Reload before saving.")
        else:
            if not body.name or not body.parent_id or body.revision:
                raise HTTPException(422, "Choose a folder and enter a dashboard name.")
            doc = workspace.create("dashboard", body.name, parent_id=body.parent_id)
        refs = [source.model_dump() for source in body.sources]
        if len({tuple(sorted(ref.items())) for ref in refs}) != len(refs):
            raise HTTPException(422, "Select each definition once.")
        for ref in refs:
            digest = calculate(workspace, ref, publishing=True)["digest"]
            # Saving never replaces the user's existing placements or layout.
            if any(w["source"] == ref for p in doc["pages"] for w in p["widgets"]):
                continue
            if sum(len(p["widgets"]) for p in doc["pages"]) >= 100:
                raise HTTPException(409, "Dashboard placement limit reached.")
            doc["pages"][0]["widgets"].append(
                dict(id=new_id(), source=ref, digest=digest, width=1, title="")
            )
        if refs:
            doc["publication_status"] = "published"
        return public_document(workspace.save(doc, doc["revision"], "save"))


def public_document(doc):
    """Filter values are returned only with an authorized source execution."""
    doc.pop("filter_groups", None)
    for page in doc.get("pages", []):
        page.pop("filter_groups", None)
        for widget in page["widgets"]:
            widget.pop("filter_groups", None)
    return doc


def copy_placement(workspace, widget):
    calculate(
        workspace, widget["source"], publishing=True, expected_digest=widget["digest"]
    )
    return dict(widget, id=new_id())


def restore_revision(resource_id: ResourceId, previous: int, body: Revision):
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        doc = workspace.get(resource_id)
        row = workspace.store.get(
            workspace.ns + ":history:" + resource_id, str(previous)
        )
        if not row or doc["kind"] != "dashboard":
            raise HTTPException(404, "Dashboard revision unavailable.")
        old = row["value"]["document"]
        # History is immutable; reject a restore whose sources were deleted.
        for page in old.get("pages", []):
            for widget in page.get("widgets", []):
                calculate(workspace, widget["source"], expected_digest=widget["digest"])
        for key in ("name", "description", "pages", "publication_status"):
            doc[key] = old[key]
        doc["filter_groups"] = old.get("filter_groups", [])
        return workspace.save(doc, body.revision, "restore revision")


def duplicate(resource_id: ResourceId, body: NewFile):
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        source = workspace.get(resource_id)
        if source["kind"] != "dashboard" or body.kind != "dashboard":
            raise HTTPException(422, "Select a dashboard to duplicate.")
        doc = workspace.create(**body.model_dump())
        doc["pages"] = source["pages"]
        doc["filter_groups"] = source.get("filter_groups", [])
        for page in doc["pages"]:
            page["id"] = new_id()
            page["widgets"] = [
                copy_placement(workspace, widget) for widget in page["widgets"]
            ]
        return workspace.save(doc, doc["revision"], "duplicate")


def prepare_refresh(resource_id: ResourceId, page_id: ResourceId):
    workspace = ContentWorkspace().resolve(resource_id)
    doc = workspace.get(resource_id)
    page = next((p for p in doc.get("pages", []) if p["id"] == page_id), None)
    if page is None:
        raise HTTPException(404, "Page unavailable.")
    return workspace, doc, page


def refresh_events(workspace, doc, page, force=False):
    batch = CalculationBatch(widget["source"] for widget in page["widgets"])
    started = time.monotonic()

    def execute(widget):
        widget_started = time.monotonic()
        try:
            value = calculate(
                workspace,
                widget["source"],
                expected_digest=widget["digest"],
                filters=effective_filters(doc, page, widget),
                batch=batch,
                cache_results=True,
                force=force,
            )
            value["filters"] = scoped_filters(doc, page, widget)
        except HTTPException as exc:
            value = {"error": exc.detail}
        except Exception:
            logger.exception(
                "Dashboard widget execution failed | widget=%s", widget["id"]
            )
            value = {"error": "Widget execution failed. Refresh to retry."}
        logger.info(
            "Dashboard widget finished | widget=%s | status=%s | elapsed=%.3fs",
            widget["id"],
            "error" if "error" in value else "ready",
            time.monotonic() - widget_started,
        )
        return {
            "type": "widget",
            "id": widget["id"],
            "value": value,
            "revision": doc["revision"],
        }

    yield {"type": "start", "revision": doc["revision"], "total": len(page["widgets"])}
    futures = []
    try:
        for widget in page["widgets"]:
            futures.append(
                _widget_pool.submit(contextvars.copy_context().run, execute, widget)
            )
        for future in as_completed(futures):
            yield future.result()
        logger.info(
            "Dashboard refresh complete | dashboard=%s | widgets=%s | cache_hits=%s | elapsed=%.3fs",
            doc["id"],
            len(futures),
            batch.cache_hits,
            time.monotonic() - started,
        )
        yield {"type": "complete", "revision": doc["revision"]}
    finally:
        for future in futures:
            future.cancel()


def refresh(resource_id: ResourceId, page_id: ResourceId, force=False):
    workspace, doc, page = prepare_refresh(resource_id, page_id)
    results = {}
    for event in refresh_events(workspace, doc, page, force):
        if event["type"] == "widget":
            results[event["id"]] = event["value"]
    return {"revision": doc["revision"], "widgets": results}


def source_context(widget):
    source = widget["source"]
    return {k: source[k] for k in ("dataset_id", "version", "semantic_revision")}


def effective_filters(doc, page, widget):
    return [
        f for filters in scoped_filters(doc, page, widget).values() for f in filters
    ]


def scoped_filters(doc, page, widget):
    ctx = source_context(widget)
    return {
        scope: [
            f
            for group in container.get("filter_groups", [])
            if group["source"] == ctx
            for f in group["filters"]
        ]
        for scope, container in (("dashboard", doc), ("page", page), ("widget", widget))
    }


def edit_filters(resource_id, body: FilterEdit):
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        workspace = workspace.resolve(resource_id, write=True)
        doc = workspace.get(resource_id)
        for page in doc.get("pages", []):
            for widget in page["widgets"]:
                if widget["id"] != body.placement_id:
                    continue
                ctx = source_context(widget)
                container = {"widget": widget, "page": page, "dashboard": doc}[
                    body.scope
                ]
                groups = [
                    g for g in container.get("filter_groups", []) if g["source"] != ctx
                ]
                if body.filters:
                    groups.append(
                        {
                            "source": ctx,
                            "filters": [
                                f.model_dump(mode="json") for f in body.filters
                            ],
                        }
                    )
                container["filter_groups"] = groups
                calculate(
                    workspace,
                    widget["source"],
                    expected_digest=widget["digest"],
                    filters=effective_filters(doc, page, widget),
                )
                return {
                    "revision": workspace.save(doc, body.revision, "filters")[
                        "revision"
                    ]
                }
        raise HTTPException(404, "Placement unavailable.")


def reorder(items, index, action):
    position = max(0, min(len(items) - 1, index + (1 if action == "down" else -1)))
    items.insert(position, items.pop(index))


def edit_pages(resource_id: ResourceId, body: PageEdit):
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        workspace = workspace.resolve(resource_id, write=True)
        doc = workspace.get(resource_id)
        pages = doc.get("pages")
        if pages is None:
            raise HTTPException(422, "Select a dashboard.")
        page = next((p for p in pages if p["id"] == body.page_id), None)
        if body.action != "add" and page is None:
            raise HTTPException(404, "Page unavailable.")
        if body.action in ("add", "duplicate"):
            widgets = (
                [copy_placement(workspace, w) for w in page["widgets"]]
                if body.action == "duplicate"
                else []
            )
            if (
                len(pages) >= 30
                or sum(len(p["widgets"]) for p in pages) + len(widgets) > 100
            ):
                raise HTTPException(409, "Dashboard size limit reached.")
            pages.append(dict(id=new_id(), name=file_name(body.name), widgets=widgets))
        elif body.action == "rename":
            page["name"] = file_name(body.name)
        elif body.action == "remove":
            if len(pages) == 1:
                raise HTTPException(409, "Keep at least one dashboard page.")
            pages.remove(page)
        else:
            reorder(pages, pages.index(page), body.action)
        return {"revision": workspace.save(doc, body.revision, "pages")["revision"]}


def edit_widget(resource_id: ResourceId, placement_id: ResourceId, body: PlacementEdit):
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        workspace = workspace.resolve(resource_id, write=True)
        doc = workspace.get(resource_id)
        for page in doc.get("pages", []):
            widgets = page["widgets"]
            for index, widget in enumerate(widgets):
                if widget["id"] != placement_id:
                    continue
                if body.action == "move":
                    target = next(
                        (i for i, w in enumerate(widgets) if w["id"] == body.target_id),
                        None,
                    )
                    if target is None:
                        raise HTTPException(404, "Destination placement unavailable.")
                    widgets.insert(target, widgets.pop(index))
                elif body.action == "remove":
                    widgets.pop(index)
                elif body.action == "duplicate":
                    if sum(len(p["widgets"]) for p in doc["pages"]) >= 100:
                        raise HTTPException(409, "Dashboard placement limit reached.")
                    widgets.insert(index + 1, copy_placement(workspace, widget))
                elif body.action == "edit":
                    widget.update(width=body.width, title=body.title)
                else:
                    reorder(widgets, index, body.action)
                return {
                    "revision": workspace.save(doc, body.revision, "layout")["revision"]
                }
        raise HTTPException(404, "Placement unavailable.")
