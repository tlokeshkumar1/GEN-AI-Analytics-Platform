"""The dashboard stream reports validation errors and logs unexpected failures."""

import asyncio
import json
import unittest
from contextlib import nullcontext
from unittest.mock import patch

from fastapi import HTTPException
from api.routes.graph import (
    GenAIDashboardRequest,
    generate_genai_dashboard_stream,
    generate_genai_dashboard,
)


class GenAIStreamErrorTests(unittest.TestCase):
    def stream_error(self, error):
        def events(**kwargs):
            yield {"type": "step", "step": 4, "name": "Relate"}
            raise error

        async def consume():
            response = generate_genai_dashboard_stream(
                GenAIDashboardRequest(prompt="compare dates", dataset_id="production")
            )
            return [
                json.loads(chunk.removeprefix("data: ").strip())
                async for chunk in response.body_iterator
            ]

        with (
            patch("api.platform.data_resolution.selected_dataset"),
            patch(
                "api.platform.data_resolution.dataset_scope",
                side_effect=lambda *a: nullcontext(),
            ),
            patch(
                "api.services.genai_dashboard_service.genai_dashboard_service.generate_dashboard_stream",
                side_effect=events,
            ),
            patch("api.routes.graph.logger") as logger,
        ):
            result = asyncio.run(consume())
        return result, logger

    def test_validation_error_reaches_client(self):
        events, logger = self.stream_error(
            ValueError("Selected dataset has no Project_Start_Date.")
        )
        self.assertEqual(
            events[-1],
            {"type": "error", "message": "Selected dataset has no Project_Start_Date."},
        )
        logger.exception.assert_not_called()

    def test_http_error_reaches_client(self):
        events, _ = self.stream_error(
            HTTPException(409, "Dataset version is unavailable.")
        )
        self.assertEqual(events[-1]["message"], "Dataset version is unavailable.")

    def test_unexpected_error_is_logged_without_exposing_internal_details(self):
        events, logger = self.stream_error(RuntimeError("internal connection details"))
        self.assertEqual(
            events[-1]["message"], "Dashboard generation failed. Retry the request."
        )
        logger.exception.assert_called_once()

    def test_synchronous_validation_error_is_422(self):
        with (
            patch(
                "api.platform.data_resolution.dataset_scope", return_value=nullcontext()
            ),
            patch(
                "api.services.genai_dashboard_service.genai_dashboard_service.generate_dashboard",
                side_effect=ValueError("Requested fields are missing."),
            ),
        ):
            with self.assertRaises(HTTPException) as caught:
                generate_genai_dashboard(GenAIDashboardRequest(prompt="compare dates"))
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(caught.exception.detail, "Requested fields are missing.")
