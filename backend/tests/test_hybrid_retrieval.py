"""Hybrid record answers must use actual, scoped evidence and truthful provenance."""
import json
import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from api.rag.evidence import select_evidence, cosine_score
from api.rag.pipeline import RAGPipeline


def chunk(identifier='milestone-1', text='PRJ-002 has an open design milestone.', score=.72, **meta):
    return {'ID': identifier, 'TEXT_CHUNK': text, 'SCORE': score,
            'METADATA': json.dumps({'dataset_id': 'milestones', 'version': 1, 'source': 'Milestones',
                                    'source_table': 'VECTOR_TABLE', 'retrieval': 'hana_vector', 'score_type': 'cosine', **meta})}


class HybridRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.pipeline = RAGPipeline()
        self.record = {'PROJECT_ID': 'PRJ-002', 'Rate': Decimal('0.123456789123'), 'Status': 'Amber',
                       '_resolved_dataset_id': 'projects', '_resolved_dataset_name': 'Projects',
                       '_resolved_table': 'PROJECTS', '_resolved_version': 1, '_resolved_backend': 'hana_table'}
        self.selection = SimpleNamespace(context=SimpleNamespace(dataset_id='production', model_dump=lambda: {
            'dataset_id': 'production', 'version': 1, 'semantic_revision': 1}))

    def run_hybrid(self, record, chunks, question='give full details of PRJ-002', stream=False):
        self.events = []
        with patch('api.rag.pipeline.data_service.get_order_details', return_value=record), \
             patch('api.rag.pipeline.retriever.retrieve', return_value=chunks) as retrieve, \
             patch('api.platform.ai_settings.ai_settings', return_value={'llm_model': 'test'}), \
             patch.object(self.pipeline, '_stream_nim_synthesis', return_value='Evidence-based analysis [2].') as synthesize:
            result = self.pipeline._hybrid_record(question, 'PRJ-002', 8, self.selection, [], self.events.append, stream, None)
            self.prompt = synthesize.call_args.kwargs['prompt'] if synthesize.called else None
            self.synthesis_count = synthesize.call_count
            retrieve.assert_called_once()
        return result

    def test_combines_records_and_relevant_vectors_without_active_dataset_placeholder(self):
        result = self.run_hybrid(self.record, [chunk(), chunk('wrong', 'Production output: 23 tons.'), chunk('partial', 'PRJ-0020 is red.')])
        self.assertEqual(result['retrieval']['mode'], 'hybrid')
        self.assertEqual(len(result['sources']), 2)
        self.assertEqual(result['context']['dataset_id'], 'projects')
        self.assertNotIn('semantic_revision', result['context'])
        self.assertEqual(result['cosine_score'], .72)
        self.assertIsNone(result['sources'][0]['SCORE'])
        self.assertIn('open design milestone', self.prompt)
        self.assertNotIn('Production output', self.prompt)
        self.assertNotIn('Selected dataset version', self.prompt)
        self.assertIn('| Rate | 0.123456789123 |', result['reply'])
        self.assertIn('| Status | Amber |', result['reply'])

    def test_vector_only_answer_when_record_is_not_in_relational_table(self):
        result = self.run_hybrid(None, [chunk()])
        self.assertEqual(result['retrieval']['mode'], 'vector_only')
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['sources'][0]['ID'], 'milestone-1')

    def test_no_matching_record_or_vector_does_not_call_model(self):
        result = self.run_hybrid(None, [chunk(text='PRJ-099 has unrelated issues.')])
        self.assertEqual(result['status'], 'not_found')
        self.assertEqual(result['sources'], [])
        self.assertEqual(self.synthesis_count, 0)

    def test_snapshot_matches_are_never_labelled_as_cosine_or_vector_table(self):
        fallback = chunk(score=3, source_table=None, retrieval='snapshot_lexical', score_type='lexical', lexical_score=.4)
        result = self.run_hybrid(self.record, [fallback])
        self.assertEqual(result['retrieval']['mode'], 'structured_with_snapshot')
        self.assertEqual(result['retrieval']['vector_table_chunks'], 0)
        self.assertIsNone(result['cosine_score'])
        self.assertTrue(result['warnings'])

    def test_keyword_match_in_vector_table_without_embedding_has_no_cosine(self):
        result = self.run_hybrid(self.record, [chunk(score=None, score_type=None, match_type='identifier')])
        self.assertEqual(result['retrieval']['mode'], 'hybrid')
        self.assertIsNone(result['cosine_score'])

    def test_record_failure_can_still_return_vector_evidence(self):
        with patch('api.rag.pipeline.data_service.get_order_details', side_effect=RuntimeError('offline')), \
             patch('api.rag.pipeline.retriever.retrieve', return_value=[chunk()]), \
             patch('api.platform.ai_settings.ai_settings', return_value={'llm_model': 'test'}), \
             patch.object(self.pipeline, '_stream_nim_synthesis', return_value='Vector evidence [1].'):
            result = self.pipeline._hybrid_record('PRJ-002', 'PRJ-002', 5, None, [], None, False, None)
        self.assertEqual(result['retrieval']['mode'], 'vector_only')
        self.assertTrue(result['warnings'])

    def test_vector_failure_preserves_verified_record_without_fabricated_score(self):
        events = []
        with patch('api.rag.pipeline.data_service.get_order_details', return_value=self.record), \
             patch('api.rag.pipeline.retriever.retrieve', side_effect=RuntimeError('offline')), \
             patch('api.platform.ai_settings.ai_settings', return_value={'llm_model': 'test'}), \
             patch.object(self.pipeline, '_stream_nim_synthesis', return_value='Structured record [1].'):
            result = self.pipeline._hybrid_record('PRJ-002', 'PRJ-002', 5, None, [], events.append, False, None)
        self.assertEqual(result['retrieval']['mode'], 'structured_only')
        self.assertIsNone(result['cosine_score'])
        self.assertTrue(any(e['stage'] == 'vector_retrieval' and e['status'] == 'failed' for e in events))

    def test_entity_selection_deduplicates_and_rejects_partial_identifiers(self):
        exact = chunk()
        rows = select_evidence([exact, exact, chunk('partial', 'PRJ-0020'), chunk('other', 'prj_002 milestone')], 'PRJ-002')
        self.assertEqual([row['ID'] for row in rows], ['milestone-1', 'other'])
        self.assertIsNone(cosine_score(chunk(score=5, retrieval='fallback')))

    def test_generic_identifier_search_reads_vector_table_with_real_cosine(self):
        from api.database.vector_client import HANAVectorClient
        with patch('api.database.vector_client.hana_client.execute_query', side_effect=[[chunk()], []]) as query:
            result = HANAVectorClient().search_dataset_version('projects', 3, [.1, .2], 5, 'details for PRJ-002')
        sql, params = query.call_args_list[0].args
        self.assertIn('FROM VECTOR_TABLE', sql)
        self.assertIn('COSINE_SIMILARITY', sql)
        self.assertNotIn('1.0 AS SCORE', sql)
        self.assertIn('projects:v3:%', params)
        self.assertIn('%PRJ-002%', params)
        self.assertEqual(json.loads(result[0]['METADATA'])['source_table'], 'VECTOR_TABLE')

    def test_vector_scope_excludes_private_foreign_and_wrong_versions(self):
        from api.database.vector_client import HANAVectorClient
        from api.models.execution_context import current_identity, current_selection
        catalog = {'datasets': {
            'projects': {'id': 'projects', 'workspaceId': 'default', 'ownerId': 'owner', 'currentVersion': 3},
            'milestones': {'id': 'milestones', 'workspaceId': 'default', 'ownerId': 'owner', 'currentVersion': 2},
            'private': {'id': 'private', 'workspaceId': 'default', 'ownerId': 'another', 'currentVersion': 1},
            'foreign': {'id': 'foreign', 'workspaceId': 'other', 'ownerId': 'owner', 'currentVersion': 1}}}
        identity = current_identity.set({'user_id': 'owner', 'workspace_id': 'default', 'roles': ['Member']})
        selection = current_selection.set(SimpleNamespace(context=SimpleNamespace(dataset_id='projects', version=1)))
        try:
            with patch.dict('os.environ', {'PLATFORM_CHAT_WORKSPACE_ACCESS': 'false'}), \
                 patch('api.services.dataset_service.dataset_service._catalog', return_value=catalog), \
                 patch('api.database.vector_client.hana_client.execute_query', return_value=[]) as query:
                HANAVectorClient().search_dataset_version(None, 1, [.1], 5, 'PRJ-002')
            for call in query.call_args_list:
                values = str(call.args[1])
                self.assertIn('projects:v1:', values)
                self.assertIn('milestones:v2:', values)
                self.assertNotIn('projects:v3:', values)
                self.assertNotIn('private', values)
                self.assertNotIn('foreign', values)
        finally:
            current_selection.reset(selection)
            current_identity.reset(identity)
