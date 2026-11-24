from fastapi import APIRouter, Depends, HTTPException, Response
from api.models.content import (
    Bookmark,
    CreateFile,
    Edit,
    FilterEdit,
    Grant,
    NewFile,
    PageEdit,
    PlacementEdit,
    Preferences,
    Publication,
    ResourceId,
    Revision,
)
from api.platform import content_dashboard

from api.platform.content import ContentWorkspace
from api.platform.content_publication import publish


def private_response(response: Response):
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/api/content",
    tags=["Personal content"],
    dependencies=[Depends(private_response)],
)


@router.get("/preferences")
def preferences():
    workspace = ContentWorkspace()
    row = workspace.store.get(workspace.ns, "preferences")
    return (
        {"revision": row["revision"], **row["value"]}
        if row
        else {"revision": 0, "folded": []}
    )


@router.put("/preferences")
def save_preferences(body: Preferences):
    workspace = ContentWorkspace()
    value = {"folded": list(dict.fromkeys(body.folded))}
    row = workspace.store.put(workspace.ns, "preferences", value, body.revision)
    return {"revision": row["revision"], **value}


@router.get("/tree")
def tree(deleted: bool = False, archived: bool = False):
    workspace = ContentWorkspace()
    workspace.register()
    return workspace.tree(deleted, archived)


@router.put("/files/{resource_id}/favourite")
def favourite(resource_id: ResourceId, body: Bookmark):
    return ContentWorkspace().mark(resource_id, favourite=body.favourite)


@router.post("/files/{resource_id}/opened")
def opened(resource_id: ResourceId):
    return ContentWorkspace().mark(resource_id)


@router.get("/users")
def users():
    workspace = ContentWorkspace()
    return [
        r["value"]["user_id"]
        for r in workspace.store.list(workspace.directory)
        if r["value"]["user_id"] != workspace.scope["user_id"]
    ]


@router.post("/files/{resource_id}/access")
def grant(resource_id: ResourceId, body: Grant):
    return content_dashboard.public_document(
        ContentWorkspace().share(resource_id, **body.model_dump())
    )


@router.post("/files", status_code=201)
def create(body: CreateFile):
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        file = workspace.create(**body.model_dump(exclude={"first_dashboard"}))
        if body.first_dashboard:
            if body.kind != "folder":
                raise HTTPException(
                    422, "Only a folder can contain an initial dashboard."
                )
            first = workspace.create(
                "dashboard", body.first_dashboard, parent_id=file["id"]
            )
            return dict(file, first_dashboard=first)
        return file


@router.get("/files/{resource_id}")
def read(resource_id: ResourceId):
    workspace = ContentWorkspace().resolve(resource_id)
    doc = workspace.get(resource_id)
    if workspace.permission != "owner":
        doc.pop("grants", None)
        doc["parent_id"] = None
    return dict(content_dashboard.public_document(doc), permission=workspace.permission)


@router.patch("/files/{resource_id}")
def edit(resource_id: ResourceId, body: Edit):
    changes = body.model_dump(exclude_unset=True, exclude={"revision"})
    if not changes or any(v is None and k != "parent_id" for k, v in changes.items()):
        raise HTTPException(422, "Specify valid file changes.")
    return content_dashboard.public_document(
        ContentWorkspace().change(resource_id, body.revision, changes)
    )


@router.get("/files/{resource_id}/history")
def history(resource_id: ResourceId):
    workspace = ContentWorkspace()
    workspace.get(resource_id)
    return [
        dict(
            r["value"],
            document=content_dashboard.public_document(r["value"]["document"]),
        )
        for r in workspace.store.list(workspace.ns + ":history:" + resource_id)
    ]


@router.post("/files/{resource_id}/history/{previous}/restore")
def restore_revision(resource_id: ResourceId, previous: int, body: Revision):
    return content_dashboard.public_document(
        content_dashboard.restore_revision(resource_id, previous, body)
    )


@router.post("/files/{resource_id}/duplicate", status_code=201)
def duplicate(resource_id: ResourceId, body: NewFile):
    return content_dashboard.public_document(
        content_dashboard.duplicate(resource_id, body)
    )


@router.post("/files/{resource_id}/publish")
def publish_widgets(resource_id: ResourceId, body: Publication):
    workspace = ContentWorkspace()
    with workspace.store.transaction():
        return publish(workspace.resolve(resource_id, write=True), resource_id, body)


@router.post("/files/{resource_id}/refresh")
def refresh(resource_id: ResourceId, page_id: ResourceId):
    return content_dashboard.refresh(resource_id, page_id)


@router.post("/files/{resource_id}/pages")
def edit_pages(resource_id: ResourceId, body: PageEdit):
    return content_dashboard.edit_pages(resource_id, body)


@router.put("/files/{resource_id}/filters")
def edit_filters(resource_id: ResourceId, body: FilterEdit):
    return content_dashboard.edit_filters(resource_id, body)


@router.patch("/files/{resource_id}/widgets/{placement_id}")
def edit_widget(resource_id: ResourceId, placement_id: ResourceId, body: PlacementEdit):
    return content_dashboard.edit_widget(resource_id, placement_id, body)
