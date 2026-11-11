"""Zero-hardcode verification across SchemaService, DataService, DashboardService, IntentEngine, PythonGraphAgent, and JobService."""
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd
from api.models.execution_context import current_identity, current_selection
from api.platform.ai_settings import current_ai_settings
from api.platform.connectors import Batch
from api.platform.jobs import JobService
from api.platform.semantic import SemanticRegistry
from api.platform.storage import ArtifactStore, DatasetRepository
from api.platform.store import MetadataStore
from api.services.dashboard_service import DashboardService
from api.services.data_service import DataService
from api.services.dataset_service import DatasetService
from api.services.intent_engine import IntentEngine
from api.services.python_graph_agent import PythonGraphAgent
from api.services.schema_service import SchemaService


AI = dict(llm_model="test", embedding_model="test", temperature=0.2, max_tokens=1500)


class ZeroHardcodeDynamicTests(unittest.TestCase):
    def setUp(self):
        self.agri_df = pd.DataFrame({
            "FieldID": ["FLD-101", "FLD-102", "FLD-103", "FLD-104"],
            "HarvestDate": pd.to_datetime(["2025-01-15", "2025-01-20", "2025-02-10", "2025-02-18"]),
            "CropType": ["Soybean", "Wheat", "Soybean", "Corn"],
            "RegionName": ["North", "South", "North", "West"],
            "YieldTons": [120.5, 95.0, 140.0, 210.0],
            "SoilMoisturePct": [24.5, 19.0, 26.2, 22.8],
        })

    def test_schema_service_classifies_arbitrary_domain_without_hardcoding(self):
        schema = SchemaService()
        meta = schema._build_metadata(self.agri_df)
        self.assertTrue(meta["FieldID"].is_identifier)
        self.assertFalse(meta["FieldID"].is_measure)
        self.assertTrue(meta["HarvestDate"].is_date)
        self.assertTrue(meta["YieldTons"].is_measure)
        self.assertEqual(meta["YieldTons"].default_aggregation, "SUM")
        self.assertTrue(meta["SoilMoisturePct"].is_measure)
        self.assertEqual(meta["SoilMoisturePct"].default_aggregation, "AVG")
        self.assertTrue(meta["CropType"].is_dimension)

        schema._metadata = meta
        with patch("api.services.data_service.data_service.get_dataframe", return_value=self.agri_df):
            self.assertEqual(schema.resolve_column("yieldtons"), "YieldTons")
            self.assertIsNone(schema.resolve_column("NetRevenueUSD"))

    def test_dashboard_and_data_service_dynamic_on_non_sales_dataframe(self):
        ds = DataService()
        dash = DashboardService()
        with patch.object(ds, "get_dataframe", return_value=self.agri_df), \
             patch("api.services.dashboard_service.data_service", ds):
            result = dash.get_dashboard_data()
            titles = [k["title"] for k in result["kpis"]]
            self.assertFalse(any("Revenue" in t or "Countries" in t for t in titles))
            self.assertTrue(any("Yield Tons" in t for t in titles))
            self.assertGreater(len(result["region_breakdown"]), 0)
            self.assertGreater(len(result["revenue_trend"]), 0)
            rec = ds.get_record_details("FLD-102")
            self.assertIsNotNone(rec)
            self.assertEqual(rec["CropType"], "Wheat")

    def test_data_service_hana_introspection_avoids_sales_columns(self):
        ds = DataService()
        fake_cols = [
            {"name": "VESSEL_ID", "type": "NVARCHAR"},
            {"name": "PORT_NAME", "type": "NVARCHAR"},
            {"name": "CARGO_TONNAGE", "type": "DECIMAL"},
            {"name": "ARRIVAL_DATE", "type": "DATE"},
        ]
        with patch.object(ds, "get_dataframe", return_value=pd.DataFrame()), \
             patch.object(ds, "_resolve_target_table", return_value="DS_MARITIME_V1"), \
             patch("api.database.hana_table_service.hana_table_service.get_table_columns", return_value=fake_cols), \
             patch("api.database.hana_client.hana_client.execute_query", return_value=[{"M1": 5000.0, "M2": 10, "M_AVG": 500.0, "D1": 4}]) as mock_exec:
            kpis = ds.get_kpis()
            self.assertEqual(kpis["total_revenue"], 5000.0)
            executed_sql = mock_exec.call_args.args[0]
            self.assertIn("CARGO_TONNAGE", executed_sql)
            self.assertIn("PORT_NAME", executed_sql)
            self.assertNotIn("NETREVENUEUSD", executed_sql)
            self.assertNotIn("SALES_ANALYTICS", executed_sql)

    def test_intent_engine_and_graph_agent_dynamic_for_non_sales_dataset(self):
        schema = SchemaService()
        schema._metadata = schema._build_metadata(self.agri_df)
        token_sel = current_selection.set(None)
        self.addCleanup(current_selection.reset, token_sel)

        with patch("api.services.data_service.data_service.get_dataframe", return_value=self.agri_df), \
             patch("api.services.intent_engine.schema_service", schema), \
             patch("api.services.excel_dataset_service.excel_dataset_service.get_df", return_value=self.agri_df):
            engine = IntentEngine()
            plan = engine.classify("Total YieldTons by CropType")
            self.assertEqual(plan["metric"], "YieldTons")
            self.assertEqual(plan["dimension"], "CropType")
            self.assertNotEqual(plan["metric"], "NetRevenueUSD")

            agent = PythonGraphAgent()
            self.assertEqual(agent._infer_measure("Show YieldTons chart", self.agri_df), "YieldTons")
            self.assertEqual(agent._infer_dim("Show YieldTons by CropType", self.agri_df), "CropType")
            insights = agent._build_insights("prompt", "bar", "CropType", "YieldTons", "tmp.py", verified=True, dataset_name="AgriHarvest.csv")
            self.assertIn("AgriHarvest.csv", insights)
            self.assertNotIn("SAC_Sales_Preprocessed", insights)

    def test_connector_sync_job_auto_proposes_open_domain_semantic_model(self):
        with tempfile.TemporaryDirectory() as directory:
            store = MetadataStore(Path(directory) / "metadata.db", "sqlite")
            objects = ArtifactStore("local", Path(directory) / "objects")
            repo = DatasetRepository(store, objects, "w")
            datasets = DatasetService(Path(directory) / "cache", False, repo)
            self.addCleanup(datasets.wait_for_idle)
            t_id = current_identity.set({"workspace_id": "w", "user_id": "admin", "roles": ["Admin"]})
            t_ai = current_ai_settings.set(AI)
            self.addCleanup(current_identity.reset, t_id)
            self.addCleanup(current_ai_settings.reset, t_ai)

            store.put("w:bindings", "b1", dict(name="MaritimeFeed", connection_id="c1", source="Vessels", mode="replace", checkpoint={}))
            connector = Mock()
            connector.extract.return_value = iter([Batch(records=[
                {"VesselID": "V-101", "PortName": "Rotterdam", "CargoTons": "4500.5"},
                {"VesselID": "V-102", "PortName": "Singapore", "CargoTons": "6200.0"},
            ], checkpoint={"cursor": "2"})])
            connections = Mock()
            @contextmanager
            def opened(*args):
                yield connector
            connections.open = opened

            with patch.object(datasets, "_index", return_value=([], "Ready")), \
                 patch.object(datasets, "_submit_indexing", return_value=None), \
                 patch("api.services.ai_core_service.ai_core_service.generate_nvidia_completion", return_value=""):
                jobs = JobService(store, datasets, connections)
                job = jobs.enqueue("sync", {"binding_id": "b1"}, "sync-maritime-1")
                jobs.run_next("w")
                finished = jobs.get(job["id"])["value"]
                self.assertEqual(finished["state"], "succeeded")
                ds_id = finished["result"]["dataset_id"]
                entry = datasets._entry(datasets._catalog(), ds_id)
                models = SemanticRegistry(store).list(entry, 1)
                self.assertEqual(len(models), 1)
                field_names = [f["name"] for f in models[0]["fields"]]
                self.assertEqual(field_names, ["VesselID", "PortName", "CargoTons"])


if __name__ == "__main__":
    unittest.main()

