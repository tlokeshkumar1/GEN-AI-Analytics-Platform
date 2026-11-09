"""Unit tests for chat route session ID retention and streaming generator cancellation."""
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import Request
from api.models.request_models import ChatRequest
from api.routes.chat import chat_with_rag
from api.rag.generator import RAGGenerator


class ChatRouteSessionResilienceTests(unittest.TestCase):
    def test_retains_session_id_when_get_recent_history_fails(self):
        """If get_recent_history fails after session creation, session_id must still be retained."""
        req = ChatRequest(message="Hello world", session_id=None)
        request = MagicMock(spec=Request)
        request.headers = {}
        request.state = MagicMock()
        request.state.user = None

        with patch("api.routes.chat.get_user_id_from_request", return_value="user-123"), \
             patch("api.routes.chat.history_service") as mock_history, \
             patch("api.routes.chat.RAGPipeline") as mock_rag:

            mock_history.get_or_create_session.return_value = "session-valid-created"
            mock_history.save_message.return_value = None
            mock_history.get_recent_history.side_effect = RuntimeError("HANA transient timeout during history fetch")

            mock_pipeline_instance = MagicMock()
            mock_pipeline_instance.run.return_value = {
                "reply": "Test response",
                "sources": [],
            }
            mock_rag.return_value = mock_pipeline_instance

            resp = chat_with_rag(req, request)

            # Assert that the created session_id was RETAINED in the response, not replaced with ephemeral-
            self.assertEqual(resp.session_id, "session-valid-created")
            # Verify RAG was called with empty history
            mock_pipeline_instance.run.assert_called_once_with(req.message, req.top_k, chat_history=[])

    def test_ephemeral_fallback_only_when_creation_fails(self):
        """If get_or_create_session fails, an ephemeral session ID is generated."""
        req = ChatRequest(message="Hello world", session_id=None)
        request = MagicMock(spec=Request)
        request.headers = {}
        request.state = MagicMock()
        request.state.user = None

        with patch("api.routes.chat.get_user_id_from_request", return_value="user-123"), \
             patch("api.routes.chat.history_service") as mock_history, \
             patch("api.routes.chat.RAGPipeline") as mock_rag:

            mock_history.get_or_create_session.side_effect = RuntimeError("Database down")
            mock_pipeline_instance = MagicMock()
            mock_pipeline_instance.run.return_value = {
                "reply": "Test response",
                "sources": [],
            }
            mock_rag.return_value = mock_pipeline_instance

            resp = chat_with_rag(req, request)

            # Response should have an ephemeral session_id
            self.assertTrue(resp.session_id.startswith("ephemeral-"))

    def test_chat_stream_ephemeral_fallback_initializes_chat_history(self):
        """When session creation fails or session is ephemeral, chat_stream initializes chat_history = []."""
        import asyncio
        from api.routes.chat_stream import chat_stream

        req = ChatRequest(message="Hello stream", session_id=None)
        request = MagicMock(spec=Request)
        request.headers = {}
        request.state = MagicMock()
        request.state.user = None

        async def fake_is_disconnected():
            return False

        request.is_disconnected = fake_is_disconnected

        async def run_test():
            with patch("api.utils.auth.get_user_id_from_request", return_value="user-123"), \
                 patch("api.routes.chat_stream.history_service") as mock_history, \
                 patch("api.routes.chat_stream.RAGPipeline") as mock_rag:

                mock_history.get_or_create_session.side_effect = RuntimeError("HANA down")
                mock_pipeline_instance = MagicMock()

                def fake_run_stream(msg, top_k, cb, history, stop):
                    cb({"type": "stage", "stage": "intent_detection", "status": "completed"})
                    return {"reply": "Stream reply", "sources": []}

                mock_pipeline_instance.run_stream.side_effect = fake_run_stream
                mock_rag.return_value = mock_pipeline_instance

                streaming_resp = await chat_stream(req, request)
                events = []
                async for chunk in streaming_resp.body_iterator:
                    events.append(chunk)

                all_output = "".join(events)
                self.assertIn("request_started", all_output)
                self.assertIn("Stream reply", all_output)
                self.assertNotIn('"type": "error"', all_output)
                mock_pipeline_instance.run_stream.assert_called_once()
                args, _ = mock_pipeline_instance.run_stream.call_args
                # args[3] is chat_history
                self.assertEqual(args[3], [])

        asyncio.run(run_test())


class GeneratorCancellationTests(unittest.TestCase):
    def test_stream_cancellation_closes_response_and_skips_fallback(self):
        """When stop_event is set, streaming terminates immediately without fallback to generate()."""
        gen = RAGGenerator()
        gen.api_key = "test-key"

        mock_resp = MagicMock()
        # Mock iter_lines to block until stop_event is set or timeout
        stop_event = threading.Event()

        def slow_iter_lines():
            # Yield one line, then wait for stop
            yield b'data: {"choices": [{"delta": {"content": "Hello"}}]}\n\n'
            # Now simulate blocking read until closed
            while not stop_event.is_set():
                time.sleep(0.05)
            # Once closed or stop_event is set, simulate an exception or end
            raise ConnectionResetError("Socket closed")

        mock_resp.status_code = 200
        mock_resp.iter_lines = slow_iter_lines

        with patch("requests.post", return_value=mock_resp), \
             patch.object(gen, "generate") as mock_sync_generate:

            stream = gen.generate_stream("prompt", stop_event=stop_event)

            # Get first chunk
            first_chunk = next(stream)
            self.assertEqual(first_chunk, "Hello")

            # Signal client disconnect
            stop_event.set()

            # Next iteration should finish without calling generate()
            remaining_chunks = list(stream)
            self.assertEqual(remaining_chunks, [])

            # Synchronous fallback must NOT have been called!
            mock_sync_generate.assert_not_called()
            # Response must have been closed
            mock_resp.close.assert_called()


if __name__ == "__main__":
    unittest.main()
