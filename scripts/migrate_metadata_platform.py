"""Explicit catalog/semantic migration. Dry-run by default; never runs on API startup."""
import argparse
import copy
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import re

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from api.models.execution_context import current_identity
from api.platform.contracts import SemanticModel, SemanticField
from api.platform.semantic import semantic_registry
from api.services.dataset_service import DatasetService


def legacy_model(entry, version, snapshot, grain, owner, approve=False):
    fields = []
    for column in snapshot["columns"]:
        name = column["name"]
        raw_type = str(column.get("type", "string")).lower()
        kind = {"number": "decimal", "percentage": "decimal"}.get(raw_type, raw_type)
        low = name.lower()
        is_time = any(t in low for t in ("date", "time", "year", "month", "quarter", "period"))
        is_id = low == "id" or low.endswith(("_id", "id", "_code", "code", "_key", "number"))
        role = "time" if is_time else "identifier" if is_id else "measure" if kind in ("decimal", "integer", "number") else "dimension"
        aliases = []
        if role == "identifier":
            stem = re.sub(r"(_?id|_?code|_?key|_?number)$", "", low).strip("_ ")
            if stem:
                plural = stem if stem.endswith("s") else f"{stem}s"
                aliases = [plural, f"{stem} count"]
        aggregations = ["SUM", "AVG", "MIN", "MAX", "COUNT", "COUNT_DISTINCT"] if role == "measure" else ["COUNT", "COUNT_DISTINCT"]
        default_agg = ("AVG" if ("percent" in low or "pct" in low or "ratio" in low) else "SUM") if role == "measure" else None
        currency = "USD" if low.endswith("usd") else None
        unit = "%" if ("percent" in low or "pct" in low) else None
        fields.append(SemanticField(
            name=name,
            semantic_name=name,
            type=kind,
            role=role,
            aliases=aliases,
            aggregations=aggregations,
            default_aggregation=default_agg,
            currency=currency,
            unit=unit,
            evidence="Migrated mapping inferred from dataset columns; source business grain requires review.",
        ))
    raw_name = str(entry.get("name") or entry.get("id") or "unknown")
    inferred_domain = re.sub(r"\.(csv|xlsx|xls)$", "", raw_name, flags=re.I).strip().lower() or "unknown"
    return SemanticModel(
        dataset_id=entry["id"],
        data_version=version,
        revision=1,
        domain=inferred_domain,
        grain=grain or "Unconfirmed: one source row",
        fields=fields,
        status="approved" if approve else "proposed",
        reviewer=f"migration:{owner}" if approve else None,
        reviewed_at=datetime.now(timezone.utc).isoformat() if approve else None,
    )


def migrate(service, workspace, owner, grain, apply=False, approve_sales=False, destination=None):
    if destination and destination.catalog()["datasets"]:
        raise ValueError("The destination catalog is not empty; refusing to overwrite it.")
    catalog = copy.deepcopy(service._catalog())
    for entry in catalog["datasets"].values():
        if entry.get("workspaceId") in (None, workspace) and entry.get("ownerId") and entry["ownerId"] != owner:
            raise ValueError("An existing dataset owner differs from --owner-id; migrate owners individually.")
    sources = sorted(path for path in service.output_dir.iterdir() if path.is_file() and path.suffix.lower() in (".csv", ".xls", ".xlsx")
                     and not path.name.startswith("~$") and path.name not in catalog.get("importedFiles", [])) if service.output_dir.exists() else []
    # Validate every unregistered source before any apply writes. Dry-run never registers files.
    source_report = [{"filename": path.name, "rows": len(service.parse_file(path.read_bytes(), path.name))} for path in sources]
    backup = None
    if apply and service.repository is None and service.catalog_path.exists():
        backup = service.output_dir / ".migration_backups" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f") + ".json")
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_bytes(service.catalog_path.read_bytes())
    if apply and sources:
        service._import_legacy()
        catalog = copy.deepcopy(service._catalog())
    report = {"dry_run": not apply, "datasets": [], "warnings": [
        "Historical rounding/truncation cannot be reversed without original source files.",
        "Existing chat ownership and messages are unchanged. Legacy conversations without a data context are read-only until explicitly mapped.",
        "Legacy HANA vectors remain intact. Reindex explicitly to adopt the workspace/model namespace.",
    ]}
    report["unregistered_sources"] = source_report
    if backup:
        report["catalog_backup"] = str(backup)
    for entry in catalog["datasets"].values():
        if entry.get("workspaceId") not in (None, workspace):
            continue
        if entry.get("ownerId") and entry["ownerId"] != owner:
            raise ValueError("An existing dataset owner differs from --owner-id; migrate owners individually.")
        entry.update(workspaceId=workspace, ownerId=owner, readers=entry.get("readers", []), writers=entry.get("writers", []))
        report["datasets"].append({"id": entry["id"], "name": entry["name"], "versions": len(entry["versions"])})
        for version in entry["versions"]:
            snapshot = service._snapshot(entry, version["version"])
            if apply:
                namespace = semantic_registry.namespace(entry, version["version"])
                if semantic_registry.store.get(namespace, "1") is None:
                    model = legacy_model(entry, version["version"], snapshot, grain, owner, approve_sales)
                    semantic_registry.store.put(namespace, "1", model.model_dump(mode="json"))
                if destination:
                    raw = (service.output_dir / entry["folder"] / version["filename"]).read_bytes()
                    version.update(rawKey=destination.objects.put(raw), snapshotKey=destination.save_snapshot(snapshot), sizeBytes=len(raw))
    if apply:
        if destination:
            with destination.writer():
                existing = destination.catalog()
                if existing["datasets"]:
                    raise ValueError("The destination catalog is not empty; refusing to overwrite it.")
                destination.publish(catalog)
        else:
            with service._writer():
                service._write_json(service.catalog_path, catalog)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).resolve().parents[1] / "backend/preprocessing/output")
    parser.add_argument("--workspace", default=os.getenv("PLATFORM_WORKSPACE_ID", "default"))
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--grain", help="Reviewed description of what one row represents")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--approve-sales-model", action="store_true")
    parser.add_argument("--to-durable", action="store_true")
    args = parser.parse_args()
    if args.approve_sales_model and not args.grain:
        parser.error("--approve-sales-model requires an explicit --grain")
    # Source is always the legacy local catalog, even when the target deployment is durable.
    service = DatasetService(args.source_dir, default_async_index=False, repository=False)
    identity = current_identity.set({"workspace_id": args.workspace, "user_id": args.owner_id, "roles": ["Admin"]})
    try:
        destination = None
        if args.to_durable and args.apply:
            from api.platform.storage import DatasetRepository
            destination = DatasetRepository(workspace=args.workspace)
        print(json.dumps(migrate(service, args.workspace, args.owner_id, args.grain, args.apply, args.approve_sales_model, destination), indent=2))
    finally:
        current_identity.reset(identity)


if __name__ == "__main__":
    main()
