"""Content-addressed object store garbage collection script.

Identifies and cleans up unreferenced/orphaned content hashes from ArtifactStore
without deleting live referenced dataset snapshots, indexes, or blobs.

Usage:
    python scripts/gc_objects.py --dry-run
    python scripts/gc_objects.py --apply
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure backend modules can be imported
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from api.platform.storage import ArtifactStore
from api.platform.store import metadata_store

OBJECT_HASH_REGEX = re.compile(r"objects/([0-9a-fA-F]{64})")


def _is_missing_object_error(exc: Exception) -> bool:
    """Determine if an exception indicates the object does not exist vs a read/network failure."""
    if isinstance(exc, (FileNotFoundError, KeyError)):
        return True
    # S3 ClientError: NoSuchKey or 404
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error_code = response.get("Error", {}).get("Code", "")
        if error_code in ("NoSuchKey", "404", "NotFound"):
            return True
    # GCS, Azure, HTTP 404
    status_code = getattr(exc, "status_code", getattr(exc, "code", None))
    if status_code == 404:
        return True
    exc_type = type(exc).__name__
    if exc_type in ("NotFound", "ResourceNotFoundError", "NoSuchKey"):
        return True
    return False


def collect_referenced_hashes(store=None, objects=None, local_dir=None, incomplete_errors=None):
    """
    Collect all content hashes referenced by active catalogs, snapshots, and documents.
    Recursively inspects snapshot manifests to find transitive data and index hashes.
    Fails closed: any reference query failure or transient read error is recorded into incomplete_errors.
    """
    referenced = set()
    store = store or metadata_store()
    objects = objects or ArtifactStore()
    if incomplete_errors is None:
        incomplete_errors = []

    # 1. Inspect all documents in PLATFORM_DOCUMENTS
    try:
        with store.transaction() as cursor:
            cursor.execute("SELECT NAMESPACE, DOCUMENT_ID, PAYLOAD FROM PLATFORM_DOCUMENTS")
            rows = cursor.fetchall()
            for row in rows:
                payload_raw = row[2]
                payload_str = payload_raw.read() if hasattr(payload_raw, "read") else str(payload_raw)
                for match in OBJECT_HASH_REGEX.finditer(payload_str):
                    referenced.add(match.group(1).lower())
    except Exception as exc:
        incomplete_errors.append(f"PLATFORM_DOCUMENTS: {exc}")
        print(f"[GC] Warning: Could not query PLATFORM_DOCUMENTS ({exc}).")

    # 2. Inspect local catalog files if present
    output_dir = Path(local_dir or os.getenv("PLATFORM_OUTPUT_DIR", str(Path(__file__).resolve().parents[1] / "preprocessing" / "output")))
    catalog_file = output_dir / "datasets.json"
    if catalog_file.exists():
        try:
            content = catalog_file.read_text(encoding="utf-8")
            for match in OBJECT_HASH_REGEX.finditer(content):
                referenced.add(match.group(1).lower())
        except Exception as exc:
            incomplete_errors.append(f"{catalog_file}: {exc}")
            print(f"[GC] Warning: Error reading {catalog_file}: {exc}")

    # 3. Recursively resolve manifests for referenced hashes
    # Snapshot manifests contain: {"data": "objects/<hash>", "index": "objects/<hash>"}
    uninspected = list(referenced)
    inspected = set()

    while uninspected:
        current_hash = uninspected.pop()
        if current_hash in inspected:
            continue
        inspected.add(current_hash)

        key = f"objects/{current_hash}"
        try:
            raw_bytes = objects.get(key)
            # Try parsing as JSON to find transitive references
            try:
                manifest = json.loads(raw_bytes.decode("utf-8"))
                if isinstance(manifest, dict):
                    for val in manifest.values():
                        if isinstance(val, str):
                            match = OBJECT_HASH_REGEX.search(val)
                            if match:
                                child_hash = match.group(1).lower()
                                referenced.add(child_hash)
                                if child_hash not in inspected:
                                    uninspected.append(child_hash)
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
        except Exception as exc:
            if _is_missing_object_error(exc):
                # Object genuinely does not exist in store; no child manifests to inspect
                pass
            else:
                # Transient cloud error, timeout, permission error, etc.
                incomplete_errors.append(f"{key}: {exc}")
                print(f"[GC] Warning: Transient error reading {key} ({exc}); reference scan is incomplete.")

    return referenced


def collect_stored_objects(objects=None):
    """
    List all stored content objects in the ArtifactStore.
    Returns a dict mapping hash -> (full_path_or_key, size_bytes, last_modified_utc).
    """
    objects = objects or ArtifactStore()
    stored = {}

    if objects.backend == "local":
        objects_dir = objects.root / "objects"
        if objects_dir.exists():
            for entry in objects_dir.iterdir():
                if entry.is_file() and not entry.name.endswith(".tmp"):
                    h = entry.name.lower()
                    if len(h) == 64 and all(c in "0123456789abcdef" for c in h):
                        stat = entry.stat()
                        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
                        stored[h] = (entry, stat.st_size, mtime)
    else:
        # Cloud backends
        client = objects._client()
        try:
            if objects.backend == "s3":
                paginator = client.get_paginator("list_objects_v2")
                for page in paginator.paginate(Bucket=objects.bucket, Prefix="objects/"):
                    for obj in page.get("Contents", []):
                        key = obj["Key"]
                        if key.startswith("objects/") and len(key) == 72:
                            h = key[8:].lower()
                            dt = obj.get("LastModified")
                            if dt and dt.tzinfo is None:
                                dt = dt.replace(tzinfo=timezone.utc)
                            stored[h] = (key, obj.get("Size", 0), dt)
            elif objects.backend == "gcs":
                for blob in client.bucket(objects.bucket).list_blobs(prefix="objects/"):
                    key = blob.name
                    if key.startswith("objects/") and len(key) == 72:
                        h = key[8:].lower()
                        dt = blob.updated
                        if dt and dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        stored[h] = (key, blob.size or 0, dt)
            elif objects.backend == "azure_blob":
                container = client.get_container_client(objects.bucket)
                for blob in container.list_blobs(name_starts_with="objects/"):
                    key = blob.name
                    if key.startswith("objects/") and len(key) == 72:
                        h = key[8:].lower()
                        dt = blob.last_modified
                        if dt and dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        stored[h] = (key, blob.size or 0, dt)
        finally:
            if hasattr(client, "close"):
                client.close()

    return stored


def run_garbage_collection(dry_run=True, store=None, objects=None, local_dir=None, min_age_seconds=None):
    """
    Execute object garbage collection.
    Fails closed when reference discovery is incomplete.
    Protects unreferenced objects younger than the configurable grace period (min_age_seconds).
    Returns a report dictionary with scan statistics and orphaned hash details.
    """
    objects = objects or ArtifactStore()
    store = store or metadata_store()

    if min_age_seconds is None:
        if "GC_MIN_AGE_SECONDS" in os.environ:
            min_age_seconds = int(os.getenv("GC_MIN_AGE_SECONDS"))
        elif "GC_MIN_AGE_HOURS" in os.environ:
            min_age_seconds = int(float(os.getenv("GC_MIN_AGE_HOURS")) * 3600)
        else:
            min_age_seconds = 86400

    print("[GC] Scanning live references from catalog and metadata storage...")
    incomplete_errors = []
    live_hashes = collect_referenced_hashes(
        store=store, objects=objects, local_dir=local_dir, incomplete_errors=incomplete_errors
    )
    print(f"[GC] Found {len(live_hashes)} referenced content hashes.")

    if incomplete_errors:
        print(f"\n[GC] WARNING: Reference discovery was incomplete ({len(incomplete_errors)} errors):")
        for err in incomplete_errors:
            print(f"  - {err}")
        if not dry_run:
            raise RuntimeError(
                f"Reference scan was incomplete ({len(incomplete_errors)} errors); "
                f"refusing to delete objects in --apply mode to prevent data loss."
            )

    print(f"[GC] Scanning object store (backend: {objects.backend})...")
    stored_objects = collect_stored_objects(objects=objects)
    print(f"[GC] Found {len(stored_objects)} physical objects in storage.")

    now = datetime.now(timezone.utc)
    unreferenced_hashes = set(stored_objects.keys()) - live_hashes
    orphaned_hashes = set()
    protected_young_hashes = set()

    for h in unreferenced_hashes:
        entry = stored_objects[h]
        size = entry[1]
        last_modified = entry[2] if len(entry) > 2 else None

        if last_modified is not None and min_age_seconds > 0:
            age = (now - last_modified).total_seconds()
            if age < min_age_seconds:
                protected_young_hashes.add(h)
                continue
        orphaned_hashes.add(h)

    orphaned_details = []
    total_reclaimable_bytes = 0

    for h in sorted(orphaned_hashes):
        entry = stored_objects[h]
        path_or_key = entry[0]
        size = entry[1]
        total_reclaimable_bytes += size
        orphaned_details.append({
            "hash": h,
            "key": f"objects/{h}",
            "size_bytes": size,
        })

    report = {
        "dry_run": dry_run,
        "total_stored_objects": len(stored_objects),
        "live_referenced_objects": len(live_hashes & set(stored_objects.keys())),
        "unreferenced_count": len(unreferenced_hashes),
        "orphaned_count": len(orphaned_hashes),
        "protected_count": len(protected_young_hashes),
        "min_age_seconds": min_age_seconds,
        "incomplete_scan": bool(incomplete_errors),
        "scan_errors": incomplete_errors,
        "reclaimable_bytes": total_reclaimable_bytes,
        "orphaned_objects": orphaned_details,
        "deleted_count": 0,
    }

    print("\n" + "=" * 60)
    print("OBJECT STORAGE GARBAGE COLLECTION REPORT")
    print("=" * 60)
    print(f"Mode: {'DRY RUN (No files modified)' if dry_run else 'APPLY (Deleting orphaned objects)'}")
    print(f"Total Stored Objects : {report['total_stored_objects']}")
    print(f"Live Referenced      : {report['live_referenced_objects']}")
    print(f"Unreferenced Total   : {report['unreferenced_count']}")
    if min_age_seconds > 0:
        print(f"Protected (Age < {min_age_seconds / 3600:.1f}h): {report['protected_count']}")
    print(f"Eligible for Deletion: {report['orphaned_count']}")
    print(f"Reclaimable Storage  : {report['reclaimable_bytes']:,} bytes ({report['reclaimable_bytes'] / (1024*1024):.2f} MB)")
    if incomplete_errors:
        print(f"Incomplete Reference : YES ({len(incomplete_errors)} errors)")
    print("=" * 60)

    if protected_young_hashes:
        print(f"\n[GC] Note: {len(protected_young_hashes)} unreferenced objects are younger than {min_age_seconds / 3600:.1f}h grace period; skipped.")

    if orphaned_details:
        print("\nIdentified Orphaned Objects:")
        for item in orphaned_details[:20]:
            print(f"  - {item['key']} ({item['size_bytes']:,} bytes)")
        if len(orphaned_details) > 20:
            print(f"  ... and {len(orphaned_details) - 20} more.")

    if not dry_run and orphaned_hashes:
        print("\n[GC] Deleting orphaned objects...")
        deleted = 0
        if objects.backend == "local":
            for h in orphaned_hashes:
                entry = stored_objects[h]
                path = entry[0]
                try:
                    Path(path).unlink(missing_ok=True)
                    deleted += 1
                except Exception as exc:
                    print(f"[GC] Error deleting {path}: {exc}")
        else:
            client = objects._client()
            try:
                for h in orphaned_hashes:
                    key = f"objects/{h}"
                    try:
                        if objects.backend == "s3":
                            client.delete_object(Bucket=objects.bucket, Key=key)
                        elif objects.backend == "gcs":
                            client.bucket(objects.bucket).blob(key).delete()
                        elif objects.backend == "azure_blob":
                            client.get_blob_client(objects.bucket, key).delete_blob()
                        deleted += 1
                    except Exception as exc:
                        print(f"[GC] Error deleting {key}: {exc}")
            finally:
                if hasattr(client, "close"):
                    client.close()
        report["deleted_count"] = deleted
        print(f"[GC] Successfully deleted {deleted} orphaned objects.")
    elif dry_run and orphaned_hashes:
        print("\n[GC] Run with --apply to delete these orphaned objects.")
    else:
        print("\n[GC] Storage is clean; no orphaned objects found.")

    return report


def main():
    parser = argparse.ArgumentParser(description="Garbage collect unreferenced content-addressed objects.")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Preview orphaned objects without deleting (default).")
    parser.add_argument("--apply", action="store_true", default=False, help="Permanently delete identified orphaned objects.")
    parser.add_argument(
        "--min-age-hours",
        type=float,
        default=None,
        help="Minimum age in hours before an unreferenced object is considered orphaned for deletion (default: 24, or GC_MIN_AGE_SECONDS / GC_MIN_AGE_HOURS)."
    )
    parser.add_argument(
        "--min-age-seconds",
        type=int,
        default=None,
        help="Minimum age in seconds before an unreferenced object is considered orphaned for deletion."
    )
    args = parser.parse_args()

    dry_run = not args.apply
    if args.min_age_seconds is not None:
        min_age_seconds = args.min_age_seconds
    elif args.min_age_hours is not None:
        min_age_seconds = int(args.min_age_hours * 3600)
    else:
        min_age_seconds = None
    try:
        run_garbage_collection(dry_run=dry_run, min_age_seconds=min_age_seconds)
    except RuntimeError as err:
        print(f"\n[GC] Aborted: {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
