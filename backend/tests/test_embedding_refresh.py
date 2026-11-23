"""Embedding refresh failures preserve saved data and surface actionable errors."""
import copy
import tempfile
import unittest
from contextlib import nullcontext
from unittest.mock import patch
from fastapi import HTTPException
from api.services.dataset_service import DatasetService
from api.services.embedding_service import embedding_service
from api.services.ai_core_service import EmbeddingProviderError

class EmbeddingRefreshTests(unittest.TestCase):
    def test_retired_provider_error_preserves_original_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            service = DatasetService(folder, repository=False)
            entry = {'id': 'test', 'name': 'Projects', 'currentVersion': 1}
            snapshot = {'rows': [{'Name': 'Alpha'}], 'columns': [{'name': 'Name', 'type': 'string'}],
                        'chunks': ['previous source'], 'embeddings': [[1.0, 0.0]], 'embeddingStatus': 'Ready'}
            original = copy.deepcopy(snapshot)
            with patch.object(service, '_writer', return_value=nullcontext()), \
                 patch.object(service, '_catalog', return_value={'datasets': {'test': entry}}), \
                 patch.object(service, '_snapshot', return_value=snapshot), \
                 patch.object(service, '_write_json') as write, \
                 patch.object(embedding_service, 'batch_embeddings', side_effect=EmbeddingProviderError(
                     "Embedding model 'retired' is no longer available (HTTP 410). Choose an available embedding model.")):
                with self.assertRaises(HTTPException) as caught:
                    service.reindex('test')
            self.assertEqual(caught.exception.status_code, 503)
            self.assertIn('HTTP 410', caught.exception.detail)
            self.assertIn('Dataset is still saved', caught.exception.detail)
            self.assertEqual(snapshot, original)
            write.assert_not_called()
