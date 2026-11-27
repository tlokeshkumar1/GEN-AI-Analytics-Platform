"""Resolve approved definitions from their own immutable source context."""

import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from copy import deepcopy

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


class CalculationBatch:
    """Request-local source preparation shared by concurrent widgets."""

    def __init__(self, sources=()):
        self.lock = threading.RLock()
        self.values = {}
        self.cache_hits = 0
        self.definition_keys = {}
        for source in sources:
            key = (source["dataset_id"], source["version"], source["semantic_revision"])
            self.definition_keys.setdefault(key, set()).add(f"{source['id']}:{source['revision']}")

    def get(self, key, load):
        with self.lock:
            if key not in self.values:
                self.values[key] = load()
            return self.values[key]


_result_lock = threading.Lock()
_results = OrderedDict()
_result_bytes = 0
_RESULT_TTL = 120
_RESULT_MAX_BYTES = 16 * 1024 * 1024
_legacy_proofs = OrderedDict()


def clear_calculation_cache():
    global _result_bytes
    with _result_lock:
        _results.clear()
        _result_bytes = 0
        _legacy_proofs.clear()


def snapshot_data_digest(snapshot):
    """Publication pins data and schema; vector indexing is independent."""
    return hashlib.sha256(json.dumps(
        [snapshot.get("columns"), snapshot.get("rows"), snapshot.get("source_backend")],
        sort_keys=True, ensure_ascii=False, allow_nan=False,
    ).encode()).hexdigest()


def legacy_pin_matches(repository, model, item, expected, snapshot, digest, memo):
    """Recover an old pin only after proving its original data is unchanged."""
    proof = (expected, digest)
    with _result_lock:
        if proof in _legacy_proofs:
            _legacy_proofs.move_to_end(proof)
            return True
    # Only IDs are loaded. Fetch the one immutable manifest authenticated by
    # the original digest; never scan the contents of unrelated snapshots.
    keys = memo("artifact-keys", repository.objects.keys)
    original = next((key for key in keys if hashlib.sha256(
        json.dumps([model, item, key], sort_keys=True).encode()
    ).hexdigest() == expected), None)
    if original is None:
        return False
    try:
        old = memo(("legacy-snapshot", original), lambda: repository.snapshot(original))
    except (FileNotFoundError, ValueError, KeyError):
        return False
    if "rows" not in old or snapshot_data_digest(old) != snapshot_data_digest(snapshot):
        return False
    with _result_lock:
        _legacy_proofs[proof] = True
        while len(_legacy_proofs) > 512:
            _legacy_proofs.popitem(last=False)
    return True


def _cached_result(key):
    with _result_lock:
        entry = _results.get(key)
        if entry and time.monotonic() - entry[0] < _RESULT_TTL:
            _results.move_to_end(key)
            return deepcopy(entry[1])
    return None


def _remember_result(key, value):
    global _result_bytes
    size = len(json.dumps(value, default=str).encode())
    if size > _RESULT_MAX_BYTES:
        return
    with _result_lock:
        previous = _results.pop(key, None)
        if previous:
            _result_bytes -= previous[2]
        _results[key] = (time.monotonic(), deepcopy(value), size)
        _result_bytes += size
        while len(_results) > 128 or _result_bytes > _RESULT_MAX_BYTES:
            _, removed = _results.popitem(last=False)
            _result_bytes -= removed[2]


def calculate(
    workspace, ref, publishing=False, expected_digest=None, filters=(),
    *, batch=None, cache_results=False, force=False,
):
    memo = batch.get if batch else lambda key, load: load()
    repository = dataset_service.repository
    if (
        repository is None
        or repository.store.backend != "hana"
        or repository.objects.backend != "hana"
    ):
        raise HTTPException(
            503, "My Files requires HANA-backed dataset manifests and snapshots."
        )
    catalog = memo("catalog", dataset_service._catalog)
    entry = memo(
        ("entry", ref["dataset_id"]),
        lambda: dataset_service._entry(catalog, ref["dataset_id"]),
    )
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
    model_row = memo(
        ("document", ns, str(revision)), lambda: source_store.get(ns, str(revision))
    )
    if not model_row or model_row["value"]["status"] != "approved":
        raise HTTPException(409, "An approved pinned semantic model is required.")
    model = memo(
        ("model", ns, revision), lambda: SemanticModel.model_validate(model_row["value"])
    )
    if (model.dataset_id, model.data_version, model.revision) != (
        entry["id"],
        version,
        revision,
    ):
        raise HTTPException(409, "Semantic source mismatch.")
    items_ns = semantic_registry.namespace(entry, version, f"analytics:{revision}")
    requested = batch.definition_keys.get((entry["id"], version, revision)) if batch else None
    if requested:
        definitions = memo(
            ("definitions", items_ns), lambda: source_store.get_many(items_ns, sorted(requested))
        )
        row = definitions.get(f"{ref['id']}:{ref['revision']}")
    else:
        row = memo(
            ("document", items_ns, ref["id"], ref["revision"]),
            lambda: source_store.get(items_ns, f"{ref['id']}:{ref['revision']}"),
        )
    if not row:
        raise HTTPException(404, "Definition unavailable.")
    item = AnalyticsItem.model_validate(row["value"])
    reviewed = bool(item.reviewer) and item.reviewer != "system"
    if item.reviewer == "system":
        # The Executive Dashboard publishes engine-validated recommendations.
        # Only those exact published revisions may be reused in My Files.
        publication_ns = semantic_registry.namespace(entry, version, f"dashboard:{revision}")
        publication = memo(
            ("document", publication_ns, "published"),
            lambda: source_store.get(publication_ns, "published"),
        )
        reviewed = bool(publication) and any(
            published.get("id") == item.id
            and published.get("revision") == item.revision
            for published in publication["value"].get("items", [])
        )
    if (
        item.status != "approved"
        or not reviewed
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
    legacy_digest = hashlib.sha256(
        json.dumps(
            [model_row["value"], row["value"], manifest], sort_keys=True
        ).encode()
    ).hexdigest()
    snapshot = memo(
        ("snapshot", entry["id"], version),
        lambda: dataset_service._snapshot(entry, version, include_index=False),
    )
    if snapshot.get("source_backend") == "hana" or "rows" not in snapshot:
        raise HTTPException(409, "This version requires a complete pinned snapshot.")
    data_digest = memo(("data-digest", entry["id"], version), lambda: snapshot_data_digest(snapshot))
    digest = "data-v2:" + hashlib.sha256(json.dumps(
        [model_row["value"], row["value"], data_digest], sort_keys=True,
    ).encode()).hexdigest()
    valid_pin = expected_digest is None or expected_digest in (digest, legacy_digest)
    if not valid_pin and len(expected_digest) == 64 and all(c in "0123456789abcdef" for c in expected_digest):
        valid_pin = legacy_pin_matches(repository, model_row["value"], row["value"], expected_digest, snapshot, digest, memo)
    if not valid_pin:
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
    # Authorization and pinned-definition validation always run before cache access.
    cache_key = json.dumps([workspace.scope, ref, digest, filters], sort_keys=True, default=str)
    if cache_results and not publishing and not force:
        cached = _cached_result(cache_key)
        if cached is not None:
            if batch:
                with batch.lock:
                    batch.cache_hits += 1
            return cached
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
            dataframe=memo(
                ("frame", entry["id"], version),
                lambda: dataset_frame(entry, snapshot, version),
            ),
            semantic_model=model,
        )
    finally:
        current_selection.reset(token)
    if not result.success:
        raise HTTPException(
            422, result.error or "The approved plan could not be executed."
        )
    output = {
        "definition": item.model_dump(mode="json"),
        "result": result.to_dict(),
        "digest": digest,
        "filter_fields": [field.name for field in model.fields],
    }
    if cache_results and not publishing:
        _remember_result(cache_key, output)
    return output


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
