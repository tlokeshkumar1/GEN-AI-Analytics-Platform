"""ASGI middleware keeps verified identity and one data snapshot through SSE completion."""
import copy
import os

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from api.models.execution_context import (
    DatasetSelection, ExecutionContext, current_identity, current_selection,
    require_dataset_access,
)


class DatasetContextMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or path == "/api/health" or path.startswith("/api/auth/") or scope.get("method") == "OPTIONS":
            return await self.app(scope, receive, send)
        identity_token = selection_token = ai_token = None
        try:
            from api.xsuaa import authenticated_profile
            headers = Headers(scope=scope)
            identity = await run_in_threadpool(authenticated_profile, headers.get("authorization"))
            # This deployment owns this workspace; clients cannot manufacture membership.
            workspace = os.getenv("PLATFORM_WORKSPACE_ID", "default")
            if headers.get("x-workspace-id", workspace) != workspace:
                raise HTTPException(403, "This account has no access to the requested workspace.")
            identity_token = current_identity.set({**identity, "workspace_id": workspace})
            is_chat = path in ("/api/chat", "/api/chat/stream") or path.startswith("/api/chat/")
            needs_dataset = is_chat or path in ("/api/analytics", "/api/dashboard") or path.startswith(("/api/insights", "/api/graph/")) or (path.startswith("/api/chat/sessions") and bool(headers.get("x-dataset-id")))
            if needs_dataset:
                from api.platform.ai_settings import ai_settings, current_ai_settings
                ai_token = current_ai_settings.set(await run_in_threadpool(ai_settings))
                from api.services.dataset_service import dataset_service
                catalog = await run_in_threadpool(dataset_service._catalog)
                dataset_id = headers.get("x-dataset-id")
                if not dataset_id:
                    if (path in ("/api/dashboard", "/api/chat", "/api/chat/stream") or path.startswith(("/api/graph/", "/api/chat/"))) and catalog.get("activeDatasetId"):
                        dataset_id = catalog.get("activeDatasetId")
                    else:
                        raise HTTPException(409, "Select a dataset and version before requesting analytics.")
                entry = await run_in_threadpool(dataset_service._entry, catalog, dataset_id, is_chat)
                require_dataset_access(entry, for_chat=is_chat)
                try:
                    version = int(headers.get("x-dataset-version", str(entry["currentVersion"])))
                    from api.platform.semantic import semantic_registry
                    pinned_entry = copy.deepcopy(entry)
                    pinned_entry["currentVersion"] = version
                    models = await run_in_threadpool(semantic_registry.list, pinned_entry, version, is_chat)
                    approved_models = [m for m in models if m.get("status") == "approved"]
                    latest_approved = max([m["revision"] for m in approved_models], default=None)

                    rev_header = headers.get("x-semantic-revision")
                    if rev_header:
                        try:
                            req_rev = int(rev_header)
                            # If client requested an unapproved revision but an approved one exists, use approved
                            if latest_approved and not any(m["revision"] == req_rev and m.get("status") == "approved" for m in models):
                                revision = latest_approved
                            else:
                                revision = req_rev
                        except ValueError:
                            revision = latest_approved or 1
                    else:
                        revision = latest_approved or (max([m["revision"] for m in models], default=1) if models else 1)

                    context = ExecutionContext(workspace_id=workspace, dataset_id=dataset_id,
                                               version=version, semantic_revision=revision, user_id=identity["user_id"])
                except ValueError:
                    raise HTTPException(422, "Dataset version and semantic revision must be positive integers.") from None
                snapshot = await run_in_threadpool(dataset_service._snapshot, entry, version)
                selection_token = current_selection.set(DatasetSelection(context, pinned_entry, snapshot))
                await run_in_threadpool(semantic_registry.get, pinned_entry, version, revision, True if approved_models else False, is_chat)
            await self.app(scope, receive, send)
        except HTTPException as exc:
            await JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers={"Cache-Control": "no-store"})(scope, receive, send)
        finally:
            if ai_token is not None:
                from api.platform.ai_settings import current_ai_settings
                current_ai_settings.reset(ai_token)
            if selection_token is not None:
                current_selection.reset(selection_token)
            if identity_token is not None:
                current_identity.reset(identity_token)
