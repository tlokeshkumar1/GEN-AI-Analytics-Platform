"""Exact dataset resolution shared by SQL and DataFrame execution."""
from fastapi import HTTPException
import os
from contextlib import contextmanager


def quote_identifier(name):
    if not isinstance(name, str) or not name or len(name) > 256 or "\x00" in name:
        raise ValueError("Invalid database identifier")
    return '"' + name.replace('"', '""') + '"'


def current_table(entry, version):
    """Historical calculations use snapshots; an entry-level table may be mutable."""
    versions = entry.get("versions", [])
    latest = max((v["version"] for v in versions), default=entry.get("currentVersion", version))
    if version != latest or version != entry.get("currentVersion", version):
        return None
    meta = next((v for v in versions if v["version"] == version), {})
    return (meta.get("physical_table_name") or meta.get("tableName") or
            entry.get("physical_table_name") or entry.get("tableName") or entry.get("table_name"))


def selected_dataset(dataset_id, *, for_chat=False):
    """Reuse a pinned selection, or authorize an explicitly requested dataset."""
    from api.models.execution_context import current_selection
    from api.services.dataset_service import dataset_service
    selection = current_selection.get()
    if dataset_id and str(dataset_id).strip().lower() in ("all", "*", "default"):
        return selection
    if selection and (not dataset_id or dataset_id == selection.context.dataset_id):
        return selection
    if not dataset_id:
        return selection
    from api.models.execution_context import DatasetSelection, ExecutionContext, current_identity
    from api.platform.semantic import semantic_registry
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id, for_chat=for_chat)
    identity = current_identity.get()
    if identity is None:
        raise HTTPException(401, "A verified account is required to select a dataset.")
    version = entry["currentVersion"]
    models = semantic_registry.list(entry, version, for_chat)
    approved = [m for m in models if m.get("status") == "approved"]
    if not approved and os.getenv("PLATFORM_AUTO_APPROVE_SEMANTICS", "true").lower() == "true":
        approved = [m for m in models if m.get("status") == "proposed"]
    if not approved:
        raise HTTPException(409, "The selected dataset has no approved semantic model.")
    context = ExecutionContext(workspace_id=identity["workspace_id"], user_id=identity["user_id"],
                               dataset_id=entry["id"], version=version,
                               semantic_revision=max(m["revision"] for m in approved))
    return DatasetSelection(context, entry, dataset_service._snapshot(entry, version))


def dataset_frame(entry, snapshot, version):
    from api.services.dataset_service import dataset_service
    if snapshot.get("source_backend") != "hana":
        return dataset_service._frame(snapshot["rows"], snapshot["columns"])
    table = current_table(entry, version)
    if not table:
        raise ValueError("This dataset version has no complete snapshot or exact live table mapping")
    from api.services.excel_dataset_service import ExcelDatasetService
    return ExcelDatasetService()._load_dataset(table, entry["id"])


@contextmanager
def dataset_scope(dataset_id, *, for_chat=False):
    from api.models.execution_context import current_selection
    selection = selected_dataset(dataset_id, for_chat=for_chat)
    token = current_selection.set(selection)
    try:
        yield selection
    finally:
        current_selection.reset(token)
