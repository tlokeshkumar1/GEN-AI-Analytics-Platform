"""Regressions for exact generation, real calculations and transcript routing."""
import unittest
from unittest.mock import patch

import pandas as pd

from api.platform.widget_contract import requested_counts, widget_signature
from api.rag.catalog_chat import named_dataset_response
from api.services.genai_dashboard_service import GenAIDashboardService


class RequestedWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.service = GenAIDashboardService()
        self.frame = pd.DataFrame({'Region': ['East', 'East', 'West'], 'Revenue': [10, None, 30], 'Cost': [2, 4, 6]})

    def test_explicit_output_counts(self):
        cases = [('one KPI', {'kpis': 1, 'charts': 0}), ('two KPIs', {'kpis': 2, 'charts': 0}),
                 ('three KPIs', {'kpis': 3, 'charts': 0}), ('a chart', {'charts': 1, 'kpis': 0}),
                 ('two charts', {'charts': 2, 'kpis': 0}), ('two KPIs and three charts', {'kpis': 2, 'charts': 3}),
                 ('one Python chart', {'charts': 1, 'kpis': 0})]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(requested_counts(text), expected)

    def test_count_metric_counts_nonnull_values_not_rows(self):
        result = self.service._execute_aggregations(self.frame, [], [{'kind': 'bar', 'metric': 'Revenue', 'dimension': 'Region', 'aggregation': 'COUNT'}])
        self.assertEqual({v['label']: v['value'] for v in result['charts'][0]['data']}, {'East': 1, 'West': 1})

    def test_sum_of_dimension_itself_is_not_replaced_by_frequency(self):
        with self.assertRaisesRegex(ValueError, 'numeric'):
            self.service._execute_aggregations(self.frame, [], [{'metric': 'Region', 'dimension': 'Region', 'aggregation': 'SUM'}])

    def test_invalid_fields_never_return_fabricated_values(self):
        for spec in [{'metric': 'Missing', 'aggregation': 'SUM'}, {'metric': '*', 'aggregation': 'SUM'},
                     {'metric': 'Revenue', 'aggregation': 'MEDIAN_UNKNOWN'}]:
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                self.service._execute_aggregations(self.frame, [spec], [])
        with self.assertRaises(ValueError):
            self.service._execute_aggregations(self.frame, [], [{'metric': 'Revenue', 'dimension': 'Missing'}])

    def test_actual_complete_data_aggregation(self):
        result = self.service._execute_aggregations(self.frame, [{'metric': 'Revenue', 'aggregation': 'SUM'}], [])
        self.assertEqual(result['kpis'][0]['value'], 40)
        self.assertEqual(result['records_matched'], 3)

    def test_duplicate_identity_ignores_titles_and_ids_and_normalizes_plans(self):
        a = {'id': 'new', 'title': 'Revenue', 'kind': 'kpi', 'metric': 'Revenue', 'aggregation': 'SUM'}
        b = {'id': 'old', 'title': 'Sales', 'kind': 'kpi', 'query_plan': {'measures': [{'field': 'Revenue', 'aggregation': 'SUM'}]}}
        self.assertEqual(widget_signature(a), widget_signature(b))
        self.assertNotEqual(widget_signature(a), widget_signature({**a, 'aggregation': 'AVG'}))

    def test_digit_bearing_dataset_name_is_overview_not_record_id(self):
        name = 'COPY_OF_PORTFOLIO_5_FINAL_PROJECTS'
        entry = {'id': 'projects', 'name': name, 'currentVersion': 1}
        snapshot = {'columns': [{'name': 'Revenue', 'type': 'decimal'}], 'rows': [{'Revenue': n} for n in range(20)]}
        with patch('api.rag.catalog_chat.require_dataset_access'), \
             patch('api.services.dataset_service.dataset_service._snapshot', return_value=snapshot):
            response = named_dataset_response('give me data about ' + name, {'datasets': {'projects': entry}})
        self.assertEqual(response['intent'], 'dataset_overview')
        self.assertIn('**20 rows**', response['reply'])
        self.assertNotIn('Record Not Found', response['reply'])

    def test_named_dataset_lookup_does_not_intercept_calculation(self):
        self.assertIsNone(named_dataset_response('sum Revenue', {'datasets': {}}))
        self.assertIsNone(named_dataset_response('sum Revenue in data Sales_5', {'datasets': {'sales': {'name': 'Sales_5'}}}))

    def test_filters_are_applied_and_preserved_for_preview_and_publication(self):
        result = self.service._execute_aggregations(self.frame, [{'metric': 'Revenue', 'aggregation': 'SUM'}], [],
                                                    [{'column': 'Region', 'operator': '==', 'value': 'West'}])
        widget = result['kpis'][0]
        self.assertEqual(widget['value'], 30)
        self.assertEqual(widget['query_plan']['filters'][0]['operator'], '=')
        self.assertEqual(result['records_matched'], 1)
        with self.assertRaises(ValueError):
            self.service._execute_aggregations(self.frame, [], [], [{'column': 'Region', 'operator': 'BAD', 'value': 'West'}])

    def test_general_question_uses_llm_and_history_without_workspace_retrieval(self):
        from api.rag.pipeline import rag_pipeline
        with patch('api.services.dataset_service.dataset_service.active', return_value=(None, None)), \
             patch('api.services.dataset_service.dataset_service._catalog', return_value={'datasets': {}}), \
             patch('api.platform.ai_settings.ai_settings', return_value={'llm_model': 'test', 'max_tokens': 600}), \
             patch('api.rag.pipeline.intent_engine.classify', return_value={'intent': 'chat', 'requires_structured_query': False, 'requires_vector_search': False}), \
             patch('api.rag.pipeline.generator.generate', return_value='A neural network learns patterns from examples.') as generate, \
             patch('api.rag.pipeline.retriever.retrieve') as retrieve:
            result = rag_pipeline._run_scoped('What is a neural network?', 5, history=[{'role': 'user', 'content': 'Explain simply'}])
        self.assertEqual(result['intent'], 'general_chat')
        self.assertEqual(result['sources'], [])
        retrieve.assert_not_called()
        self.assertIn('Explain simply', generate.call_args.args[0])
