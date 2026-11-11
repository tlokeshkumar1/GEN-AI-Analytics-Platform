"""Workspace AI settings pinned per request/job; credentials remain environment-owned."""
import copy
import threading
import time
from contextvars import ContextVar
from pydantic import BaseModel, ConfigDict, Field
from api.models.execution_context import current_identity

current_ai_settings = ContextVar("workspace_ai_settings", default=None)

_AI_SETTINGS_CACHE: dict[tuple, tuple[float, dict]] = {}
_AI_SETTINGS_LOCK = threading.Lock()
_AI_SETTINGS_TTL_SECONDS = 60.0


def clear_ai_settings_cache():
    with _AI_SETTINGS_LOCK:
        _AI_SETTINGS_CACHE.clear()


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
        store = metadata_store()
        cache_key = (identity["workspace_id"], id(store), getattr(store, "backend", None), str(getattr(store, "path", "")), getattr(store, "_write_seq", 0))
        now = time.monotonic()
        with _AI_SETTINGS_LOCK:
            cached = _AI_SETTINGS_CACHE.get(cache_key)
            if cached and (now - cached[0]) < _AI_SETTINGS_TTL_SECONDS:
                return copy.deepcopy(cached[1])
        row = store.get(identity["workspace_id"] + ":settings", "ai")
        if row:
            value = row["value"]
        validated = AISettings.model_validate(value).model_dump()
        with _AI_SETTINGS_LOCK:
            if len(_AI_SETTINGS_CACHE) >= 32:
                _AI_SETTINGS_CACHE.clear()
            _AI_SETTINGS_CACHE[cache_key] = (now, copy.deepcopy(validated))
        return validated
    return AISettings.model_validate(value).model_dump()
