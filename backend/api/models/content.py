from typing import Annotated, Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field
from api.models.query_plan import Filter

ResourceId = Annotated[str, Field(pattern="^[0-9a-f]{32}$")]


Name = Annotated[str, Field(min_length=1, max_length=120)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewFile(Contract):
    kind: Literal["folder", "dashboard"]
    name: Name
    parent_id: ResourceId | None = None
    description: str = Field("", max_length=2000)


class CreateFile(NewFile):
    first_dashboard: Name | None = None


class Revision(Contract):
    revision: int = Field(ge=1)


class Preferences(Contract):
    revision: int = Field(ge=0)
    folded: list[ResourceId | Literal["root"]] = Field(max_length=1001)


class Edit(Revision):
    name: Name | None = None
    description: str | None = Field(None, max_length=2000)
    parent_id: ResourceId | None = None
    deleted: bool | None = None
    archived: bool | None = None


class Bookmark(Contract):
    favourite: bool


class Source(Contract):
    dataset_id: str = Field(min_length=1, max_length=120)
    version: int = Field(ge=1)
    semantic_revision: int = Field(ge=1)
    id: str = Field(min_length=1, max_length=180)
    revision: int = Field(ge=1)


class Publication(Revision):
    page_id: ResourceId
    request_id: UUID
    duplicates: Literal["skip", "replace", "add"] = "skip"
    sources: list[Source] = Field(min_length=1, max_length=30)


class PageEdit(Revision):
    action: Literal["add", "rename", "duplicate", "remove", "up", "down"]
    page_id: ResourceId | None = None
    name: Name = "Overview"


class PlacementEdit(Revision):
    action: Literal["edit", "remove", "duplicate", "up", "down", "move"]
    target_id: ResourceId | None = None
    title: str = Field("", max_length=120)
    width: int = Field(1, ge=1, le=3)


class FilterEdit(Revision):
    placement_id: ResourceId
    scope: Literal["widget", "page", "dashboard"]
    filters: list[Filter] = Field(max_length=20)


class Grant(Revision):
    recipient: str = Field(min_length=1, max_length=256)
    permission: Literal["view", "edit", "revoke"]
