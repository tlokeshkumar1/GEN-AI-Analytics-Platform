"""Workspace AI settings pinned per request/job; credentials remain environment-owned."""
from contextvars import ContextVar
from pydantic import BaseModel, ConfigDict, Field
from api.models.execution_context import current_identity

current_ai_settings = ContextVar("workspace_ai_settings", default=None)


class AISettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    llm_model: str = Field(min_length=1, max_length=200)
    embedding_model: str = Field(min_length=1, max_length=200)
    max_tokens: int = Field(1500, ge=100, le=16000)
    temperature: float = Field(0.2, ge=0, le=1)


def ai_settings():
    pinned = current_ai_settings.get()
    if pinned is not None:
        return pinned
    from api.config import settings
    value = dict(llm_model=settings.NVIDIA_LLM_MODEL, embedding_model=settings.NVIDIA_EMBEDDING_MODEL,
                 max_tokens=1500, temperature=0.2)
    identity = current_identity.get()
    if identity is not None:
        from api.platform.store import metadata_store
        row = metadata_store().get(identity["workspace_id"] + ":settings", "ai")
        if row:
            value = row["value"]
    return AISettings.model_validate(value).model_dump()
