"""System Management: connection administration, bindings, jobs and audited settings."""
import asyncio
import json
import os
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.models.execution_context import current_identity, require_admin, require_dataset_access
from api.platform.connections import connection_service
from api.platform.connectors import ConnectionSpec, REGISTRY, AUTH_TYPES
from api.platform.contracts import TransformationPlan
from api.platform.jobs import job_service
from api.platform.semantic import now
from api.services.dataset_service import dataset_service

router = APIRouter(prefix="/api/system", tags=["System Management"])


@router.get("/ai")
def get_ai_settings():
    require_admin()
    from api.platform.ai_settings import ai_settings
    from api.config import settings
    return {**ai_settings(), "nvidia_credentials_configured": bool(settings.NVIDIA_API_KEY),
            "aicore_credentials_configured": bool(settings.AICORE_CLIENT_ID and settings.AICORE_CLIENT_SECRET),
            "embedding_dimensions": 1536}


from api.platform.ai_settings import AISettings


@router.put("/ai")
def update_ai_settings(body: AISettings):
    identity = require_admin()
    namespace = identity["workspace_id"] + ":settings"
    row = connection_service.store.get(namespace, "ai")
    connection_service.store.put(namespace, "ai", body.model_dump(), row["revision"] if row else 0)
    connection_service.audit("ai_settings_updated", "ai")
    return get_ai_settings()


class SourceSelection(BaseModel):
    source: str = Field(min_length=1, max_length=1000)


class Binding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    connection_id: str
    source: str
    dataset_id: str | None = None
    mode: Literal["replace", "append", "upsert"] = "replace"
    keys: list[str] = Field(default_factory=list)
    duplicate_policy: Literal["keep", "drop", "reject"] = "keep"
    deletion_field: str | None = None
    transformation_plan: TransformationPlan = Field(default_factory=TransformationPlan)


class SyncRequest(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=200)


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_versions: int = Field(0, ge=0, le=10000)


@router.get("/connector-types")
def connector_types():
    require_admin()
    return [{"service": service, "provider": provider, "protocol": protocol, "auth_types": AUTH_TYPES[service]} for service, (provider, protocol, _) in REGISTRY.items()]


@router.get("/connections")
def connections():
    require_admin()
    return connection_service.list()


@router.post("/connections")
def create_connection(spec: ConnectionSpec):
    return connection_service.save(spec)


@router.put("/connections/{connection_id}")
def update_connection(connection_id: str, revision: int, spec: ConnectionSpec):
    return connection_service.save(spec, connection_id, revision)


@router.post("/connections/{connection_id}/test")
def test_connection(connection_id: str):
    return connection_service.test(connection_id)


@router.get("/connections/{connection_id}/discover")
def discover(connection_id: str):
    require_admin()
    with connection_service.open(connection_id) as adapter:
        return adapter.discover()


@router.post("/connections/{connection_id}/preview")
def preview(connection_id: str, body: SourceSelection):
    require_admin()
    with connection_service.open(connection_id) as adapter:
        return adapter.preview(body.source)


@router.post("/connections/{connection_id}/disable")
def disable(connection_id: str):
    return connection_service.disable(connection_id)


@router.get("/bindings")
def bindings():
    require_admin()
    return [{"id": row["id"], **row["value"]} for row in connection_service.store.list(current_identity.get()["workspace_id"] + ":bindings")]


@router.post("/bindings")
def create_binding(body: Binding):
    identity = require_admin()
    connection = connection_service.get(body.connection_id)
    if connection["value"]["config"].get("incremental") and body.mode != "upsert":
        raise HTTPException(422, "Incremental source extraction requires upsert with stable source keys.")
    if body.dataset_id:
        require_dataset_access(dataset_service._entry(dataset_service._catalog(), body.dataset_id), write=True)
    if body.mode != "replace" and not body.dataset_id:
        raise HTTPException(422, "Append/upsert requires an existing target dataset.")
    if body.mode == "upsert" and not body.keys:
        raise HTTPException(422, "Select a stable source key for upsert.")
    key = uuid.uuid4().hex
    value = {**body.model_dump(mode="json"), "created_by": identity["user_id"], "created_at": now(), "checkpoint": {}}
    connection_service.store.put(identity["workspace_id"] + ":bindings", key, value)
    connection_service.audit("binding_created", key)
    return {"id": key, **value}


@router.post("/bindings/{binding_id}/sync")
def sync(binding_id: str, body: SyncRequest):
    identity = require_admin()
    row = connection_service.store.get(identity["workspace_id"] + ":bindings", binding_id)
    if row is None:
        raise HTTPException(404, "Source binding not found.")
    return job_service.enqueue("sync", {"binding_id": binding_id, "dataset_id": row["value"].get("dataset_id")}, body.idempotency_key)


@router.get("/jobs")
def jobs():
    return job_service.list()


@router.get("/jobs/{job_id}")
def job_status(job_id: str):
    row = job_service.get(job_id)
    return {"id": job_id, "revision": row["revision"], **{key: value for key, value in row["value"].items() if key != "identity"}}


@router.get("/jobs/{job_id}/artifact")
def chart_artifact(job_id: str):
    row = job_service.get(job_id)
    job = row["value"]
    if job["kind"] != "custom_chart" or job["state"] != "succeeded":
        raise HTTPException(409, "The chart artifact is not ready.")
    dataset_service._entry(dataset_service._catalog(), job["payload"]["dataset_id"])
    from api.platform.storage import ArtifactStore
    objects = dataset_service.repository.objects if dataset_service.repository else ArtifactStore()
    return Response(objects.get(job["result"]["image_key"]), media_type="image/png", headers={"Cache-Control": "private, no-store"})


@router.post("/jobs/{job_id}/cancel")
def cancel(job_id: str):
    return job_service.cancel(job_id)


@router.post("/jobs/{job_id}/retry")
def retry(job_id: str):
    return job_service.retry(job_id)


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str):
    await run_in_threadpool(job_service.get, job_id)
    async def events():
        revision = None
        while True:
            row = await run_in_threadpool(job_service.get, job_id)
            if row["revision"] != revision:
                value = {k: v for k, v in row["value"].items() if k != "identity"}
                yield "data: " + json.dumps({"type": "job_status", "job_id": job_id, **value}, default=str) + "\n\n"
                revision = row["revision"]
                if value["state"] in ("succeeded", "failed", "cancelled"):
                    return
            else:
                yield ": heartbeat\n\n"
            await asyncio.sleep(2)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/storage")
def storage_settings():
    identity = require_admin()
    row = connection_service.store.get(identity["workspace_id"] + ":settings", "retention")
    return {"max_versions": row["value"]["max_versions"] if row else int(os.getenv("MAX_VERSIONS_PER_DATASET", "0")),
            "metadata_backend": connection_service.store.backend, "dataset_backend": "durable" if dataset_service.repository else "local",
            "object_backend": dataset_service.repository.objects.backend if dataset_service.repository else "local",
            "retention_note": "Zero retains every version. Referenced definitions and history must be reviewed before applying retention."}


@router.put("/storage")
def update_storage(body: SettingsUpdate):
    identity = require_admin()
    namespace = identity["workspace_id"] + ":settings"
    row = connection_service.store.get(namespace, "retention")
    connection_service.store.put(namespace, "retention", body.model_dump(), row["revision"] if row else 0)
    connection_service.audit("retention_updated", "retention")
    return storage_settings()


@router.get("/audit")
def audit():
    identity = require_admin()
    return [row["value"] for row in connection_service.store.list(identity["workspace_id"] + ":audit")]


@router.get("/access")
def access():
    identity = require_admin()
    return {"workspace_id": identity["workspace_id"], "user_id": identity["user_id"], "roles": identity["roles"],
            "policy": "Administrators manage connections. Dataset owners, administrators and explicit dataset grants control access."}
