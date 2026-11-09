import json
from typing import Any, Literal
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, Request
from pydantic import BaseModel, Field
from api.services.dataset_service import dataset_service
from starlette.concurrency import run_in_threadpool
from api.models.execution_context import current_identity, is_admin, require_dataset_access

router = APIRouter(prefix="/api/datasets", tags=["Datasets"])

class RowsPayload(BaseModel):
    rows: list[dict[str, Any]] = Field(min_length=1)

class DeleteRowsPayload(BaseModel):
    rowIds: list[str] = Field(min_length=1)

class RollbackPayload(BaseModel):
    version: int = Field(ge=1)


def expected_version(request, dataset_id):
    if request.headers.get("X-Dataset-Id") != dataset_id:
        return None
    value = request.headers.get("X-Dataset-Version")
    if value is None:
        return None
    try:
        number = int(value)
        if number < 1:
            raise ValueError()
        return number
    except ValueError:
        raise HTTPException(422, "Dataset version must be a positive integer.") from None


class DatasetGrants(BaseModel):
    readers: list[str] = Field(default_factory=list, max_length=200)
    writers: list[str] = Field(default_factory=list, max_length=200)


@router.get("/{dataset_id}/access")
def dataset_access(dataset_id: str):
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id)
    identity = current_identity.get()
    if identity is None or not (is_admin(identity) or identity["user_id"] == entry.get("ownerId")):
        raise HTTPException(403, "Only the dataset owner or administrator can manage grants.")
    return {"owner_id": entry["ownerId"], "workspace_id": entry["workspaceId"], "readers": entry.get("readers", []), "writers": entry.get("writers", [])}


@router.put("/{dataset_id}/access")
def update_dataset_access(dataset_id: str, payload: DatasetGrants):
    dataset_access(dataset_id)
    with dataset_service._writer():
        catalog = dataset_service._catalog()
        entry = dataset_service._entry(catalog, dataset_id)
        entry.update(readers=sorted(set(payload.readers)), writers=sorted(set(payload.writers)))
        entry.setdefault("audit", []).append({"action": "access_updated", "userId": current_identity.get()["user_id"]})
        dataset_service._write_json(dataset_service.catalog_path, catalog)
    return dataset_access(dataset_id)


@router.get("/{dataset_id}/compare")
def compare_versions(dataset_id: str, from_version: int = Query(ge=1), to_version: int = Query(ge=1), keys: str = ""):
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id)
    previous = dataset_service._snapshot(entry, from_version)
    current = dataset_service._snapshot(entry, to_version)
    key_fields = [key.strip() for key in keys.split(",") if key.strip()] or ["__rowId"]
    def indexed(snapshot):
        columns = {column["name"] for column in snapshot["columns"]} | {"__rowId"}
        if not set(key_fields) <= columns:
            raise HTTPException(422, "Comparison keys must exist in both versions.")
        values = {tuple(row.get(key) for key in key_fields): row for row in snapshot["rows"]}
        if len(values) != len(snapshot["rows"]) or any(any(value is None for value in key) for key in values):
            raise HTTPException(422, "Comparison requires unique non-null record keys.")
        return values
    before, after = indexed(previous), indexed(current)
    shared = set(before) & set(after)
    changed = [key for key in shared if {k: v for k, v in before[key].items() if k != "__rowId"} != {k: v for k, v in after[key].items() if k != "__rowId"}]
    old_columns = {column["name"]: column for column in previous["columns"]}
    new_columns = {column["name"]: column for column in current["columns"]}
    return {"from_version": from_version, "to_version": to_version, "keys": key_fields,
            "counts": {"inserted": len(set(after) - set(before)), "deleted": len(set(before) - set(after)), "updated": len(changed), "unchanged": len(shared) - len(changed)},
            "schema": {"added": sorted(set(new_columns) - set(old_columns)), "removed": sorted(set(old_columns) - set(new_columns)),
                       "changed": [key for key in old_columns.keys() & new_columns.keys() if old_columns[key] != new_columns[key]]},
            "identity_note": "Local row identifiers persist through edits and appends. Use approved source keys to compare independent replacement uploads."}

@router.get("")
def list_datasets():
    return dataset_service.list_datasets()

@router.get("/{dataset_id}/data")
def dataset_data(dataset_id: str, page: int = Query(1, ge=1), pageSize: int = Query(10, ge=1, le=1000),
                 sortField: str | None = None, sortDir: Literal["asc", "desc"] = "asc", search: str = "", version: int | None = Query(None, ge=1)):
    return dataset_service.data(dataset_id, page, pageSize, sortField, sortDir, search, version)

@router.put("/{dataset_id}/rows")
def update_rows(dataset_id: str, payload: RowsPayload, request: Request, sync: bool = Query(False)):
    return dataset_service.mutate(dataset_id, "edit", payload.rows, False if sync else None, expected_version(request, dataset_id))

@router.post("/{dataset_id}/append")
async def append_rows(dataset_id: str, request: Request, rows: str = Form("[]"), file: UploadFile | None = File(None), sync: bool = Query(False)):
    if file:
        df = await run_in_threadpool(dataset_service.parse_file, await file.read(), file.filename)
        incoming = [{key: value for key, value in row.items() if key != "__rowId"} for row in dataset_service._rows(df)]
    else:
        try:
            incoming = json.loads(rows)
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, "Rows must contain valid JSON.") from exc
    if not isinstance(incoming, list) or any(not isinstance(r, dict) for r in incoming):
        raise HTTPException(400, "Rows must be an array of objects.")
    return await run_in_threadpool(dataset_service.mutate, dataset_id, "append", incoming, False if sync else None, expected_version(request, dataset_id))

@router.delete("/{dataset_id}/rows")
def delete_rows(dataset_id: str, payload: DeleteRowsPayload, request: Request, sync: bool = Query(False)):
    return dataset_service.mutate(dataset_id, "delete_rows", payload.rowIds, False if sync else None, expected_version(request, dataset_id))

@router.post("/{dataset_id}/append/preview")
async def preview_append(dataset_id: str, file: UploadFile = File(...)):
    df = await run_in_threadpool(dataset_service.parse_file, await file.read(), file.filename)
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id)
    snap = dataset_service._snapshot(entry)
    expected = {c["name"] for c in snap["columns"]}
    missing = sorted(expected - set(df.columns))
    extra = sorted(set(df.columns) - expected)
    valid, invalid = [], []
    for i, row in enumerate(dataset_service._rows(df), 1):
        errors = []
        for column in snap["columns"]:
            value = row.get(column["name"])
            if column["type"] == "number" and value is not None:
                try:
                    float(value)
                except (ValueError, TypeError):
                    errors.append(f"{column['name']} must be numeric")
        if errors:
            invalid.append({"rowNumber": i, "data": row, "errors": errors})
        else:
            valid.append({**row, "__rowId": f"preview-{i}"})
    return {"totalRows": len(df), "validRows": valid, "invalidRows": invalid,
            "missingColumns": missing, "extraColumns": extra}

@router.get("/{dataset_id}/versions")
def dataset_versions(dataset_id: str):
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id)
    return {"currentVersion": entry["currentVersion"], "versions": entry["versions"]}

@router.get("/{dataset_id}/status")
def dataset_status(dataset_id: str, version: int | None = Query(None, ge=1)):
    entry = dataset_service._entry(dataset_service._catalog(), dataset_id)
    snap = dataset_service._snapshot(entry, version)
    return {
        "datasetId": dataset_id,
        "name": entry["name"],
        "currentVersion": version or entry["currentVersion"],
        "embeddingStatus": snap.get("embeddingStatus", "Pending"),
        "embeddingCount": snap.get("embeddingCount", 0),
        "hanaSyncStatus": snap.get("hanaSyncStatus", "Pending"),
        "rowCount": len(snap.get("rows", [])),
    }

@router.post("/{dataset_id}/rollback")
def rollback(dataset_id: str, payload: RollbackPayload):
    return dataset_service.restore(dataset_id, payload.version)

@router.post("/{dataset_id}/activate")
def activate(dataset_id: str):
    return dataset_service.activate(dataset_id)

@router.post("/{dataset_id}/reindex")
def reindex(dataset_id: str):
    return dataset_service.reindex(dataset_id)

@router.delete("/{dataset_id}")
def delete_dataset(dataset_id: str):
    return dataset_service.delete(dataset_id)
