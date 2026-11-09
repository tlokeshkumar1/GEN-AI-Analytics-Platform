"""Request-local identities and pinned dataset versions, independent of UI selection."""
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field


class ExecutionContext(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    workspace_id: str = Field(min_length=1, max_length=120)
    dataset_id: str = Field(min_length=1, max_length=120)
    version: int = Field(ge=1)
    semantic_revision: int = Field(ge=1)
    user_id: str = Field(min_length=1)


@dataclass(frozen=True)
class DatasetSelection:
    context: ExecutionContext
    entry: dict[str, Any]
    snapshot: dict[str, Any]


current_identity: ContextVar[dict | None] = ContextVar("platform_identity", default=None)
current_selection: ContextVar[DatasetSelection | None] = ContextVar("dataset_selection", default=None)


def is_admin(identity: dict) -> bool:
    role = str(identity.get("role") or "").lower()
    roles = [str(r).lower() for r in identity.get("roles", [])]
    return "admin" in role or any("admin" in r for r in roles)


def require_dataset_access(entry: dict, *, write: bool = False) -> None:
    """Internal callers may be unbound; every HTTP route is bound by middleware."""
    identity = current_identity.get()
    if identity is None:
        return
    if entry.get("workspaceId") != identity["workspace_id"]:
        # Legacy catalog ownership is assigned by an explicit migration, never a read.
        raise HTTPException(404, "Dataset not found in this workspace. Legacy data requires migration.")
    owner = entry.get("ownerId") == identity["user_id"]
    readers = entry.get("readers", [])
    writers = entry.get("writers", [])
    grants = writers if write else readers + writers
    if not (is_admin(identity) or owner or "*" in grants or identity["user_id"] in grants):
        raise HTTPException(403, "You do not have permission for this dataset operation.")


def require_admin() -> dict:
    identity = current_identity.get()
    if identity is None or not is_admin(identity):
        raise HTTPException(403, "Platform administrator permission is required.")
    return identity
