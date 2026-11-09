"""Migration safeguards and isolated chart process boundaries."""
import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location("platform_migration", Path(__file__).resolve().parents[2] / "scripts/migrate_metadata_platform.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationSafety(unittest.TestCase):
    def test_unregistered_sales_source_is_previewed_then_registered_without_rewriting_bytes(self):
        from api.platform.store import MetadataStore
        from api.platform.semantic import SemanticRegistry
        from api.models.execution_context import current_identity
        from api.platform.ai_settings import current_ai_settings
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "Sales.csv"
            content = b"OrderID,Quantity,NetRevenueUSD\n001,2,0.10\n"
            source.write_bytes(content)
            service = migration.DatasetService(root, False, repository=False)
            identity = current_identity.set({"workspace_id": "w", "user_id": "owner", "roles": ["Admin"]})
            ai = current_ai_settings.set(dict(llm_model="test", embedding_model="test", temperature=0.2, max_tokens=1000))
            try:
                registry = SemanticRegistry(MetadataStore(root / "metadata.db", "sqlite"))
                with patch.object(migration, "semantic_registry", registry):
                    report = migration.migrate(service, "w", "owner", None)
                    self.assertEqual(report["unregistered_sources"], [{"filename": "Sales.csv", "rows": 1}])
                    self.assertFalse(service.catalog_path.exists())
                    migration.migrate(service, "w", "owner", None, apply=True)
                    entry = next(iter(service._catalog()["datasets"].values()))
                    self.assertEqual(entry["ownerId"], "owner")
                    self.assertEqual(service._snapshot(entry)["rows"][0]["NetRevenueUSD"], "0.10")
                    self.assertEqual(registry.get(entry, 1, 1).domain, "sales")
                    self.assertEqual(source.read_bytes(), content)
            finally:
                current_ai_settings.reset(ai); current_identity.reset(identity); service.wait_for_idle()

    def test_generated_charts_have_no_network_or_application_credentials(self):
        from api.platform.custom_charts import container_command
        command = container_command("analytics-chart:reviewed", "C:/chart-temp", "chart-one")
        for flag in ("--network=none", "--read-only", "--user=65534:65534", "--memory=256m", "--pids-limit=64", "--cap-drop=ALL"):
            self.assertIn(flag, command)
        self.assertNotIn("--env-file", command)
        self.assertIn("type=bind,src=C:/chart-temp,dst=/work,readonly", command)
        with self.assertRaises(ValueError):
            container_command("image; echo unsafe", "C:/chart-temp", "chart-one")

    def test_dry_run_does_not_write_or_change_source_ownership(self):
        catalog = {"datasets": {"legacy": {"id": "legacy", "name": "Legacy", "versions": [{"version": 1}]}}}
        service = Mock()
        service.output_dir = Path(__file__).resolve().parent / "nonexistent-migration-fixture"
        service._catalog.return_value = catalog
        before = copy.deepcopy(catalog)
        report = migration.migrate(service, "workspace", "owner", None)
        self.assertTrue(report["dry_run"])
        self.assertEqual(catalog, before)
        service._write_json.assert_not_called()

    def test_nonempty_destination_is_rejected_before_any_source_reads(self):
        service, destination = Mock(), Mock()
        destination.catalog.return_value = {"datasets": {"existing": {}}}
        with self.assertRaises(ValueError):
            migration.migrate(service, "workspace", "owner", None, True, destination=destination)
        service._catalog.assert_not_called()
        destination.publish.assert_not_called()

    def test_sales_migration_counts_orders_using_order_identity(self):
        snapshot = {"columns": [{"name": "OrderID", "type": "string"}, {"name": "Quantity", "type": "number"}, {"name": "NetRevenueUSD", "type": "decimal"}]}
        model = migration.legacy_model({"id": "sales"}, 1, snapshot, "One order line", "owner")
        self.assertEqual(model.status, "proposed")
        self.assertIn("orders", model.fields[0].aliases)
        self.assertNotIn("orders", model.fields[1].aliases)


if __name__ == "__main__":
    unittest.main()
