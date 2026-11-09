import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import unittest
from unittest.mock import MagicMock, patch
import pandas as pd
from api.services.excel_dataset_service import ExcelDatasetService
from api.services.data_service import DataService
from api.database.vector_client import HANAVectorClient


class MultiTableScopingTests(unittest.TestCase):
    def setUp(self):
        self.excel_svc = ExcelDatasetService()
        self.data_svc = DataService()

    def test_excel_dataset_service_needs_reload_on_table_change(self):
        """When switching between Table A and Table B, cache should trigger reload."""
        self.excel_svc._df = pd.DataFrame([{"colA": 1}])
        self.excel_svc._loaded_table = "TABLE_A"
        self.excel_svc._loaded_dataset_id = "ds_a"

        # Querying same table should not require reload
        self.assertFalse(self.excel_svc._needs_reload("TABLE_A", "ds_a"))

        # Querying different table must require reload
        self.assertTrue(self.excel_svc._needs_reload("TABLE_B", "ds_b"))
        self.assertTrue(self.excel_svc._needs_reload("TABLE_A", "ds_b"))
        self.assertTrue(self.excel_svc._needs_reload("TABLE_B", "ds_a"))

    def test_excel_dataset_service_clear_cache(self):
        """Clear cache must completely reset table and dataset markers."""
        self.excel_svc._df = pd.DataFrame([{"colA": 1}])
        self.excel_svc._loaded_table = "TABLE_A"
        self.excel_svc._loaded_dataset_id = "ds_a"
        self.excel_svc.clear_cache()

        self.assertIsNone(self.excel_svc._df)
        self.assertIsNone(self.excel_svc._loaded_table)
        self.assertIsNone(self.excel_svc._loaded_dataset_id)
        self.assertTrue(self.excel_svc._needs_reload("TABLE_A", "ds_a"))

    @patch("api.database.hana_client.hana_client")
    @patch("api.platform.datasets_metadata_repository.datasets_metadata_repo")
    @patch("api.services.dataset_service.dataset_service")
    def test_data_service_cross_table_record_fallback(self, mock_dataset_svc, mock_meta_repo, mock_hana):
        """When record is not found in active Table B, it should search and find it in Table A."""
        # Active table is TABLE_B, which returns empty
        mock_meta_repo._resolve_physical_table.side_effect = lambda hint: "TABLE_B" if hint == "table_b" else "TABLE_A"
        mock_dataset_svc._catalog.return_value = {
            "datasets": {
                "ds_b": {"name": "Table B", "physical_table_name": "table_b"},
                "ds_a": {"name": "Table A", "physical_table_name": "table_a"},
            }
        }

        # Mock execute_query: TABLE_B returns empty, TABLE_A returns the record
        def fake_query(sql, params=None):
            if '"TABLE_B"' in sql:
                return []
            if '"TABLE_A"' in sql:
                return [{"ORDERID": "SO-106760", "CUSTOMERNAME": "Acme Corp", "NETREVENUEUSD": 15000.0}]
            return []

        mock_hana.execute_query.side_effect = fake_query

        with patch.object(self.data_svc, "get_dataframe", return_value=pd.DataFrame()):
            res = self.data_svc.get_record_details("SO-106760", table_name="table_b")
            self.assertIsNotNone(res)
            self.assertEqual(res.get("ORDERID"), "SO-106760")
            self.assertEqual(res.get("_resolved_dataset_name"), "Table A")
            self.assertEqual(res.get("_resolved_table"), "TABLE_A")

    @patch("api.database.vector_client.hana_client")
    def test_vector_client_search_all_datasets_pattern(self, mock_hana):
        """When dataset_id is 'all' or empty, search_dataset_version must use wildcard pattern '%'."""
        vc = HANAVectorClient()
        mock_hana.execute_query.return_value = [
            {"ID": "ds_a:v1:0", "TEXT_CHUNK": "Table A chunk", "SCORE": 0.95, "METADATA": "{}"}
        ]

        # Case 1: dataset_id='all'
        results = vc.search_dataset_version("all", 1, [0.1] * 10, top_k=5)
        self.assertEqual(len(results), 1)
        calls = mock_hana.execute_query.call_args_list
        # Verify the target_pattern passed was "%"
        pattern_arg = calls[-1][0][1][1]
        self.assertEqual(pattern_arg, "%")

        # Case 2: specific dataset_id='ds_a'
        mock_hana.reset_mock()
        mock_hana.execute_query.return_value = [
            {"ID": "ds_a:v1:0", "TEXT_CHUNK": "Table A chunk", "SCORE": 0.95, "METADATA": "{}"}
        ]
        vc.search_dataset_version("ds_a", 1, [0.1] * 10, top_k=5)
        pattern_arg = mock_hana.execute_query.call_args_list[-1][0][1][1]
        self.assertEqual(pattern_arg, "%ds_a%")

    @patch("api.database.vector_client.vector_client.search_dataset_version")
    @patch("api.services.embedding_service.embedding_service.get_embedding")
    def test_dataset_service_search_global_when_no_dataset_id(self, mock_get_embedding, mock_search_version):
        """When dataset_id is None, dataset_service.search must pass scoped_id=None to search globally across all embeddings."""
        from api.services.dataset_service import dataset_service
        mock_get_embedding.return_value = [0.1] * 10
        mock_search_version.return_value = [
            {"ID": "table_a:v1:0", "TEXT_CHUNK": "Table A content", "SCORE": 0.92, "METADATA": '{"source": "Table A"}'},
            {"ID": "table_b:v1:0", "TEXT_CHUNK": "Table B content", "SCORE": 0.88, "METADATA": '{"source": "Table B"}'},
        ]

        # Call search without specifying dataset_id
        results = dataset_service.search("query about products and orders", top_k=5)

        self.assertEqual(len(results), 2)
        # Verify scoped_id was passed as None to search_dataset_version
        called_args = mock_search_version.call_args[0]
        self.assertIsNone(called_args[0])  # scoped_id must be None for global search

    @patch("api.rag.pipeline.generator.generate")
    @patch("api.rag.pipeline.retriever.retrieve")
    @patch("api.services.analytics_engine.analytics_engine.execute")
    @patch("api.services.intent_engine.intent_engine.classify")
    @patch("api.platform.ai_settings.ai_settings")
    def test_pipeline_fallback_to_vector_when_structured_fails(self, mock_ai_settings, mock_classify, mock_execute, mock_retrieve, mock_generate):
        """When intent is structured but analytics_engine returns failure, it must fall through to vector retrieval instead of raising 422."""
        from api.rag.pipeline import rag_pipeline
        mock_ai_settings.return_value = {"llm_model": "gpt-4"}
        mock_classify.return_value = {
            "intent": "analytical",
            "requires_structured_query": True,
            "metrics": ["Revenue"],
            "dimensions": ["Region"],
        }
        # Simulate structured calculation failure (e.g. column not in active table)
        mock_result = MagicMock()
        mock_result.success = False
        mock_result.error = "Column Region not found in active table"
        mock_result.data = None
        mock_execute.return_value = mock_result

        # Mock vector chunks found in embeddings
        mock_retrieve.return_value = [
            {"ID": "table_a:v1:0", "TEXT_CHUNK": "Region A Revenue is 500k", "SCORE": 0.89, "METADATA": '{"source": "Table A"}'}
        ]
        mock_generate.return_value = "Region A Revenue is 500k according to Table A."

        # Execute _run_scoped
        res = rag_pipeline._run_scoped("What is the revenue by region?", top_k=4)

        self.assertEqual(res.get("status"), "success")
        self.assertIn("Region A Revenue is 500k", res.get("reply", ""))
        # Verify vector retrieval was called as a seamless fallback
        mock_retrieve.assert_called_once()


if __name__ == "__main__":
    unittest.main()
