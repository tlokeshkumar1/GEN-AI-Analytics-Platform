"""Tests for garbage collection of unreferenced content-addressed objects."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location("gc_objects", Path(__file__).resolve().parents[2] / "scripts/gc_objects.py")
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)

from api.platform.storage import ArtifactStore, DatasetRepository
from api.platform.store import MetadataStore


class GarbageCollectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.objects_root = self.root / ".objects"
        self.objects_store = ArtifactStore(backend="local", root=str(self.objects_root))
        self.metadata_path = self.root / ".metadata.sqlite3"
        self.meta_store = MetadataStore(path=str(self.metadata_path), backend="sqlite")
        self.repo = DatasetRepository(store=self.meta_store, objects=self.objects_store, workspace="test-ws")

        self.orig_min_age = os.environ.get("GC_MIN_AGE_SECONDS")
        os.environ["GC_MIN_AGE_SECONDS"] = "0"

    def tearDown(self):
        if self.orig_min_age is not None:
            os.environ["GC_MIN_AGE_SECONDS"] = self.orig_min_age
        else:
            os.environ.pop("GC_MIN_AGE_SECONDS", None)
        self.tmp.cleanup()

    def test_dry_run_identifies_orphaned_hash_without_deleting(self):
        # 1. Create a live snapshot in the repo
        snapshot_data = {"columns": [{"name": "ID", "type": "string"}], "rows": [{"ID": "001"}]}
        snapshot_ref = self.repo.save_snapshot(snapshot_data)
        manifest = json.loads(self.objects_store.get(snapshot_ref))
        data_hash = manifest["data"].replace("objects/", "")
        index_hash = manifest["index"].replace("objects/", "")
        snapshot_hash = snapshot_ref.replace("objects/", "")

        # Publish catalog referencing snapshot_ref
        with self.repo.writer():
            catalog = {
                "datasets": {
                    "ds1": {
                        "id": "ds1",
                        "name": "Dataset 1",
                        "versions": [{"version": 1, "snapshotKey": snapshot_ref}]
                    }
                }
            }
            self.repo.publish(catalog)

        # 2. Put an orphaned artifact into ArtifactStore
        orphan_ref = self.objects_store.put(b"orphaned content unreferenced by any catalog")
        orphan_hash = orphan_ref.replace("objects/", "")

        # 3. Run GC in dry-run mode
        report = gc.run_garbage_collection(dry_run=True, store=self.meta_store, objects=self.objects_store, min_age_seconds=0)

        self.assertTrue(report["dry_run"])
        self.assertEqual(report["total_stored_objects"], 4)  # snapshot manifest + data + index + orphan
        self.assertEqual(report["orphaned_count"], 1)
        self.assertEqual(report["orphaned_objects"][0]["hash"], orphan_hash)
        self.assertEqual(report["deleted_count"], 0)

        # Confirm all 4 files still exist on disk
        self.assertTrue((self.objects_root / "objects" / orphan_hash).exists())
        self.assertTrue((self.objects_root / "objects" / snapshot_hash).exists())
        self.assertTrue((self.objects_root / "objects" / data_hash).exists())
        self.assertTrue((self.objects_root / "objects" / index_hash).exists())

    def test_apply_mode_deletes_orphaned_and_preserves_live_snapshots(self):
        # 1. Create live snapshot
        snapshot_ref = self.repo.save_snapshot({"columns": [], "rows": []})
        manifest = json.loads(self.objects_store.get(snapshot_ref))
        data_hash = manifest["data"].replace("objects/", "")
        index_hash = manifest["index"].replace("objects/", "")
        snapshot_hash = snapshot_ref.replace("objects/", "")

        with self.repo.writer():
            self.repo.publish({
                "datasets": {
                    "ds1": {"versions": [{"version": 1, "snapshotKey": snapshot_ref}]}
                }
            })

        # 2. Put orphan
        orphan_ref = self.objects_store.put(b"orphaned content")
        orphan_hash = orphan_ref.replace("objects/", "")

        # 3. Run GC in apply mode
        report = gc.run_garbage_collection(dry_run=False, store=self.meta_store, objects=self.objects_store, min_age_seconds=0)

        self.assertFalse(report["dry_run"])
        self.assertEqual(report["orphaned_count"], 1)
        self.assertEqual(report["deleted_count"], 1)

        # Orphan should be deleted
        self.assertFalse((self.objects_root / "objects" / orphan_hash).exists())

        # Live snapshots must remain intact and readable
        self.assertTrue((self.objects_root / "objects" / snapshot_hash).exists())
        self.assertTrue((self.objects_root / "objects" / data_hash).exists())
        self.assertTrue((self.objects_root / "objects" / index_hash).exists())

        # Snapshot retrieval still succeeds
        loaded = self.repo.snapshot(snapshot_ref)
        self.assertEqual(loaded["columns"], [])

    def test_unreferenced_younger_than_grace_period_is_protected(self):
        """Unreferenced objects younger than min_age_seconds must be protected from deletion."""
        orphan_ref = self.objects_store.put(b"just uploaded, not yet committed to catalog")
        orphan_hash = orphan_ref.replace("objects/", "")

        # Run GC with 24h grace period (86400s)
        report = gc.run_garbage_collection(dry_run=False, store=self.meta_store, objects=self.objects_store, min_age_seconds=86400)

        self.assertEqual(report["protected_count"], 1)
        self.assertEqual(report["orphaned_count"], 0)
        self.assertEqual(report["deleted_count"], 0)

        # The young object must NOT be deleted
        self.assertTrue((self.objects_root / "objects" / orphan_hash).exists())

    def test_fail_closed_when_platform_documents_fails(self):
        """If metadata table query raises, GC refuses to delete in --apply mode."""
        orphan_ref = self.objects_store.put(b"orphan")

        from unittest.mock import patch
        with patch.object(self.meta_store, "transaction", side_effect=RuntimeError("DB table locked")):
            with self.assertRaises(RuntimeError) as ctx:
                gc.run_garbage_collection(dry_run=False, store=self.meta_store, objects=self.objects_store, min_age_seconds=0)
            self.assertIn("Reference scan was incomplete", str(ctx.exception))

        # Confirm dry-run records incomplete scan without throwing
        with patch.object(self.meta_store, "transaction", side_effect=RuntimeError("DB table locked")):
            report = gc.run_garbage_collection(dry_run=True, store=self.meta_store, objects=self.objects_store, min_age_seconds=0)
            self.assertTrue(report["incomplete_scan"])
            self.assertTrue(any("PLATFORM_DOCUMENTS" in err for err in report["scan_errors"]))

    def test_fail_closed_when_manifest_read_fails(self):
        """If reading an object raises a transient error, GC refuses to delete."""
        # 1. Create a snapshot
        snapshot_ref = self.repo.save_snapshot({"columns": [], "rows": []})
        with self.repo.writer():
            self.repo.publish({"datasets": {"ds1": {"versions": [{"version": 1, "snapshotKey": snapshot_ref}]}}})

        orig_get = self.objects_store.get

        def mock_get(key):
            if key == snapshot_ref:
                raise ConnectionError("Transient S3/GCS timeout")
            return orig_get(key)

        from unittest.mock import patch
        with patch.object(self.objects_store, "get", side_effect=mock_get):
            with self.assertRaises(RuntimeError) as ctx:
                gc.run_garbage_collection(dry_run=False, store=self.meta_store, objects=self.objects_store, min_age_seconds=0)
            self.assertIn("Reference scan was incomplete", str(ctx.exception))

    def test_cli_honors_gc_min_age_seconds_when_min_age_hours_absent(self):
        """CLI main() should pass min_age_seconds=None when --min-age-hours is not specified, allowing GC_MIN_AGE_SECONDS to be honored."""
        from unittest.mock import patch
        with patch.dict(os.environ, {"GC_MIN_AGE_SECONDS": "172800"}), \
             patch("sys.argv", ["gc_objects.py", "--dry-run"]), \
             patch.object(gc, "run_garbage_collection") as mock_gc:
            gc.main()
            mock_gc.assert_called_once_with(dry_run=True, min_age_seconds=None)

    def test_cli_prefers_explicit_min_age_hours_over_env(self):
        """CLI main() with explicit --min-age-hours should override GC_MIN_AGE_SECONDS."""
        from unittest.mock import patch
        with patch.dict(os.environ, {"GC_MIN_AGE_SECONDS": "172800"}), \
             patch("sys.argv", ["gc_objects.py", "--apply", "--min-age-hours", "12"]), \
             patch.object(gc, "run_garbage_collection") as mock_gc:
            gc.main()
            mock_gc.assert_called_once_with(dry_run=False, min_age_seconds=43200)

    def test_run_garbage_collection_reads_gc_min_age_seconds_env_if_none(self):
        """run_garbage_collection should read GC_MIN_AGE_SECONDS when min_age_seconds is None."""
        from unittest.mock import patch
        with patch.dict(os.environ, {"GC_MIN_AGE_SECONDS": "172800"}):
            with patch.object(gc, "collect_referenced_hashes", return_value=set()), \
                 patch.object(gc, "collect_stored_objects", return_value={}):
                report = gc.run_garbage_collection(dry_run=True, store=self.meta_store, objects=self.objects_store, min_age_seconds=None)
                self.assertEqual(report["min_age_seconds"], 172800)


if __name__ == "__main__":
    unittest.main()

