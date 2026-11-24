"""Resolve approved definitions from their own immutable source context."""

import hashlib
import json
import os

from fastapi import HTTPException
from api.models.execution_context import (
    DatasetSelection,
    ExecutionContext,
    current_selection,
)
from api.platform.content import new_id
from api.platform.contracts import AnalyticsItem, SemanticModel
from api.platform.data_resolution import dataset_frame
from api.platform.semantic import semantic_registry
from api.services.analytics_engine import analytics_engine
from api.services.dataset_service import dataset_service


def calculate(workspace, ref, publishing=False, expected_digest=None, filters=()):
    repository = dataset_service.repository
    if (
        repository is None
        or repository.store.backend != "hana"
        or repository.objects.backend != "hana"
    ):
        raise HTTPException(
            503, "My Files requires HANA-backed dataset manifests and snapshots."
        )
    entry = dataset_service._entry(dataset_service._catalog(), ref["dataset_id"])
    version = ref["version"]
    revision = ref["semantic_revision"]
    if os.getenv("VCAP_APPLICATION") and not entry.get("tenant_id"):
        from api.xsuaa import xsuaa_credentials

        binding = xsuaa_credentials()
        tenant = binding.get("identityzoneid") or binding.get("zoneid")
        if tenant != workspace.scope["tenant_id"]:
            raise HTTPException(403, "Dataset tenant could not be verified.")
    if (
        entry.get("tenant_id", workspace.scope["tenant_id"])
        != workspace.scope["tenant_id"]
    ):
        raise HTTPException(404, "Source unavailable.")
    ns = semantic_registry.namespace(entry, version)
    source_store = repository.store
    model_row = source_store.get(ns, str(revision))
    if not model_row or model_row["value"]["status"] != "approved":
        raise HTTPException(409, "An approved pinned semantic model is required.")
    model = SemanticModel.model_validate(model_row["value"])
    if (model.dataset_id, model.data_version, model.revision) != (
        entry["id"],
        version,
        revision,
    ):
        raise HTTPException(409, "Semantic source mismatch.")
    items_ns = semantic_registry.namespace(entry, version, f"analytics:{revision}")
    row = source_store.get(items_ns, f"{ref['id']}:{ref['revision']}")
    if not row:
        raise HTTPException(404, "Definition unavailable.")
    item = AnalyticsItem.model_validate(row["value"])
    if (
        item.status != "approved"
        or not item.reviewer
        or item.reviewer == "system"
        or item.semantic_revision != revision
        or item.id != ref["id"]
        or item.revision != ref["revision"]
    ):
        raise HTTPException(409, "Review this definition before publication.")
    if publishing:
        stale = (
            entry["currentVersion"] != version
            or any(
                r["value"]["status"] == "approved" and r["value"]["revision"] > revision
                for r in source_store.list(ns)
            )
            or any(
                r["value"]["id"] == item.id and r["value"]["revision"] > item.revision
                for r in source_store.list(items_ns)
            )
        )
        if stale:
            raise HTTPException(409, "Select the current reviewed definition.")
    manifest = next(
        (
            v.get("snapshotKey")
            for v in entry.get("versions", [])
            if v["version"] == version
        ),
        None,
    )
    digest = hashlib.sha256(
        json.dumps(
            [model_row["value"], row["value"], manifest], sort_keys=True
        ).encode()
    ).hexdigest()
    if expected_digest is not None and expected_digest != digest:
        raise HTTPException(
            409, "The pinned definition or snapshot changed. Review and republish."
        )
    plan = item.query_plan
    if plan.joins or any(
        target and target != entry["id"]
        for target in (plan.dataset_id, plan.left_dataset_id)
    ):
        raise HTTPException(
            409, "This plan requires independently versioned join sources."
        )
    snapshot = dataset_service._snapshot(entry, version)
    if snapshot.get("source_backend") == "hana" or "rows" not in snapshot:
        raise HTTPException(409, "This version requires a complete pinned snapshot.")
    context = ExecutionContext(
        **{k: workspace.scope[k] for k in ("workspace_id", "user_id")},
        dataset_id=entry["id"],
        version=version,
        semantic_revision=revision,
    )
    token = current_selection.set(DatasetSelection(context, entry, snapshot))
    try:
        query = plan.model_dump(exclude_none=True, by_alias=True)
        query["filters"] = [*query.get("filters", []), *filters]
        result = analytics_engine.execute(
            query,
            dataframe=dataset_frame(entry, snapshot, version),
            semantic_model=model,
        )
    finally:
        current_selection.reset(token)
    if not result.success:
        raise HTTPException(
            422, result.error or "The approved plan could not be executed."
        )
    return {
        "definition": item.model_dump(mode="json"),
        "result": result.to_dict(),
        "digest": digest,
        "filter_fields": [field.name for field in model.fields],
    }


def publish(workspace, dashboard_id, request):
    with workspace.store.transaction():
        doc = workspace.get(dashboard_id)
        page = next(
            (p for p in doc.get("pages", []) if p["id"] == request.page_id), None
        )
        if page is None:
            raise HTTPException(404, "Destination page unavailable.")
        signature = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
        ns = workspace.ns + ":receipts:" + dashboard_id
        receipt = workspace.store.get(ns, str(request.request_id))
        if receipt:
            if receipt["value"]["signature"] != signature:
                raise HTTPException(
                    409, "Request ID already used for another publication."
                )
            return receipt["value"]["outcome"]
        if doc["revision"] != request.revision:
            raise HTTPException(409, "Dashboard changed. Reload the destination.")
        refs = [s.model_dump() for s in request.sources]
        if len({json.dumps(s, sort_keys=True) for s in refs}) != len(refs):
            raise HTTPException(422, "Select each definition once.")
        count = 0
        for ref in refs:
            digest = calculate(workspace, ref, publishing=True)["digest"]
            matches = [
                w
                for w in page["widgets"]
                if w["source"]["id"] == ref["id"]
                and w["source"]["dataset_id"] == ref["dataset_id"]
            ]
            if matches and request.duplicates == "skip":
                continue
            if matches and request.duplicates == "replace":
                matches[0]["source"] = ref
                matches[0]["digest"] = digest
            else:
                if sum(len(p["widgets"]) for p in doc["pages"]) >= 100:
                    raise HTTPException(409, "Dashboard placement limit reached.")
                page["widgets"].append(
                    dict(id=new_id(), source=ref, digest=digest, width=1, title="")
                )
            count += 1
        if count:
            doc["publication_status"] = "published"
            workspace.save(doc, request.revision, "publish")
        outcome = {
            "placements_written": count,
            "revision": doc["revision"],
            "dashboard_id": dashboard_id,
        }
        workspace.store.put(
            ns, str(request.request_id), {"signature": signature, "outcome": outcome}
        )
        return outcome
