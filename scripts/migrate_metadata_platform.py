"""Explicit catalog/semantic migration. Dry-run by default; never runs on API startup."""
import argparse
import copy
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from api.models.execution_context import current_identity
from api.platform.contracts import SemanticModel, SemanticField
from api.platform.semantic import semantic_registry
from api.services.dataset_service import DatasetService
from api.services.schema_service import _COLUMN_ALIASES, _MEASURE_COLUMNS, _DEFAULT_AGGREGATIONS, _DATE_COLUMNS


def legacy_model(entry, version, snapshot, grain, owner, approve=False):
    sales = "NetRevenueUSD" in {column["name"] for column in snapshot["columns"]}
    fields = []
    for column in snapshot["columns"]:
        name = column["name"]
        kind = {"number": "decimal", "percentage": "decimal"}.get(column["type"], column["type"])
        role = "measure" if sales and name in _MEASURE_COLUMNS else "time" if name in _DATE_COLUMNS else "identifier" if name.lower().endswith(("id", "code", "number")) else "dimension"
        aliases = [alias for alias, target in _COLUMN_ALIASES.items() if target == name and alias not in ("orders", "order count")] if sales else []
        if name == "OrderID":
            aliases += ["orders", "order count"]
        aggregations = ["SUM", "AVG", "MIN", "MAX", "COUNT", "COUNT_DISTINCT"] if role == "measure" else ["COUNT", "COUNT_DISTINCT"]
        fields.append(SemanticField(name=name, semantic_name=name, type=kind, role=role, aliases=aliases,
                                    aggregations=aggregations, default_aggregation=_DEFAULT_AGGREGATIONS.get(name) if role == "measure" else None,
                                    currency="USD" if name.endswith("USD") else None,
                                    unit="%" if "Percent" in name else None,
                                    evidence="Migrated sales mapping; original precision and source business grain require review."))
    return SemanticModel(dataset_id=entry["id"], data_version=version, revision=1, domain="sales" if sales else "unknown",
                         grain=grain or "Unconfirmed: one source row", fields=fields,
                         status="approved" if approve and sales else "proposed", reviewer=f"migration:{owner}" if approve and sales else None,
                         reviewed_at=datetime.now(timezone.utc).isoformat() if approve and sales else None)


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
