"""Offline regressions for failures exposed by the enterprise CI gates."""

import unittest
from contextlib import nullcontext
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from api.routes import datasets


class RecommendationRetryTests(unittest.TestCase):
    def test_failed_recommendation_retry_logs_safely_and_returns_retryable_error(self):
        meta = {"version": 1, "ingestionStatus": "partial", "storageAction": "none"}
        entry = {"currentVersion": 1, "versions": [meta], "name": "Fixture"}
        service = MagicMock()
        service._writer.return_value = nullcontext()
        service._entry.return_value = entry
        service._snapshot.return_value = {"rows": [], "columns": []}
        with (
            patch.object(datasets, "dataset_service", service),
            patch.object(datasets, "require_dataset_access") as authorize,
            patch("api.platform.semantic.semantic_registry") as registry,
            patch(
                "api.platform.agent_chart_recommender.chart_recommender_agent"
            ) as agent,
            self.assertLogs(datasets.logger, level="WARNING") as logs,
        ):
            registry.list.return_value = [{"revision": 1}]
            agent.recommend.side_effect = RuntimeError("provider-secret-sentinel")
            with self.assertRaises(HTTPException) as raised:
                datasets.retry_ingestion("fixture", 1)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Retry ingestion", raised.exception.detail)
        self.assertIn("RuntimeError", logs.output[0])
        self.assertNotIn("provider-secret-sentinel", " ".join(logs.output))
        self.assertEqual(meta["ingestionStatus"], "partial")
        authorize.assert_called_once_with(entry, write=True)
        service._write_json.assert_not_called()


if __name__ == "__main__":
    unittest.main()
