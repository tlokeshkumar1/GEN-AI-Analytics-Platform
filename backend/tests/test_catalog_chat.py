"""Transcript regressions: catalog questions need no vectors, snapshots or model."""

import json
import asyncio
import os
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from api.models.execution_context import (
    DatasetSelection,
    ExecutionContext,
    current_selection,
)
from api.rag.catalog_chat import catalog_intent
from api.routes import chat, chat_stream
from api.services.history_service import ChatHistoryService
from api.utils.context_middleware import DatasetContextMiddleware


class CatalogChatTests(unittest.TestCase):
    def test_model_title_is_returned_and_saved_for_rest_and_stream(self):
        for endpoint in ("/api/chat", "/api/chat/stream"):
            with (
                self.subTest(endpoint=endpoint),
                patch.object(
                    self.history,
                    "_generate_subject",
                    return_value="Workspace Dataset Overview",
                ) as generate,
            ):
                result = self.result(
                    self.client.post(endpoint, json={"message": "what data i have"}),
                    endpoint,
                )
                self.assertEqual(result["session_title"], "Workspace Dataset Overview")
                generate.assert_called_once()
                saved = self.connection.execute(
                    "SELECT SUBJECT FROM CHAT_SESSIONS WHERE SESSION_ID = ?",
                    (result["session_id"],),
                ).fetchone()
                self.assertEqual(saved[0], result["session_title"])

    def setUp(self):
        self.connection = sqlite3.connect(":memory:", check_same_thread=False)
        self.addCleanup(self.connection.close)
        self.connection.executescript("""
            CREATE TABLE CHAT_SESSIONS (SESSION_ID TEXT PRIMARY KEY, USER_ID TEXT,
                SUBJECT TEXT, CREATED_AT TIMESTAMP, UPDATED_AT TIMESTAMP);
            CREATE TABLE CHAT_MESSAGES (MESSAGE_ID TEXT PRIMARY KEY, SESSION_ID TEXT,
                ROLE TEXT, CONTENT TEXT, SOURCES TEXT, INTENT TEXT, METADATA TEXT, TIMESTAMP TIMESTAMP);
        """)
        self.history = ChatHistoryService()
        self.history._tables_initialized = True
        manager = Mock()
        manager.get_connection.return_value = self.connection
        self.catalog = {"datasets": {}, "activeDatasetId": "projects"}
        for identifier, name, workspace in (
            ("projects", "Project tracker", "default"),
            ("milestones", "Project milestones", "default"),
            ("production", "Aluminium foil production", "default"),
            ("private", "Restricted dataset", "default"),
            ("foreign", "Other workspace secret", "other"),
        ):
            self.catalog["datasets"][identifier] = dict(
                id=identifier,
                name=name,
                workspaceId=workspace,
                ownerId="owner",
                readers=[] if identifier == "private" else ["member"],
                writers=[],
                currentVersion=1,
                versions=[{"version": 1, "rowCount": 1234}],
            )
        self.datasets = Mock()
        self.datasets._catalog.return_value = self.catalog
        self.datasets._snapshot.side_effect = AssertionError(
            "Catalog chat must not load a snapshot"
        )
        patches = [
            patch.dict(
                os.environ,
                {
                    "PLATFORM_CHAT_WORKSPACE_ACCESS": "false",
                    "PLATFORM_WORKSPACE_ID": "default",
                },
            ),
            patch("api.services.history_service.db_manager", manager),
            patch.object(chat, "history_service", self.history),
            patch.object(chat_stream, "history_service", self.history),
            patch("api.services.dataset_service.dataset_service", self.datasets),
            patch(
                "api.xsuaa.authenticated_profile",
                return_value={
                    "user_id": "member",
                    "role": "Member",
                    "roles": ["Member"],
                },
            ),
            patch(
                "api.platform.semantic.semantic_registry.list",
                side_effect=AssertionError("No semantic setup needed"),
            ),
            patch(
                "api.platform.ai_settings.ai_settings",
                side_effect=AssertionError("No AI settings needed"),
            ),
            patch(
                "api.rag.pipeline.retriever.retrieve",
                side_effect=AssertionError("No vector request needed"),
            ),
            patch(
                "api.rag.pipeline.generator.generate",
                return_value="Hi! How can I help?",
            ),
            patch(
                "api.rag.pipeline.generator.generate_stream",
                side_effect=lambda *a, **k: iter(["Hi! ", "How can I help?"]),
            ),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        app = FastAPI()
        app.add_middleware(DatasetContextMiddleware)
        app.include_router(chat.router)
        app.include_router(chat_stream.router)
        self.client = TestClient(app)

    def result(self, response, endpoint):
        self.assertEqual(response.status_code, 200, response.text)
        if endpoint.endswith("stream"):
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            self.assertFalse(any(e["type"] == "error" for e in events), events)
            return next(e["data"] for e in events if e["type"] == "result")
        return response.json()

    def test_transcript_sequence_on_rest_and_stream_preserves_history(self):
        for endpoint in ("/api/chat", "/api/chat/stream"):
            with self.subTest(endpoint=endpoint):
                first = self.result(
                    self.client.post(endpoint, json={"message": "hi"}), endpoint
                )
                self.assertEqual(first["sources"], [])
                self.assertNotIn("Project tracker", first["reply"])
                self.assertNotIn("all your tables are active", first["reply"].lower())
                response = self.client.post(
                    endpoint,
                    json={
                        "message": "what data i have ?",
                        "session_id": first["session_id"],
                    },
                )
                second = self.result(response, endpoint)
                self.assertEqual(second["session_id"], first["session_id"])
                self.assertIn("3 accessible datasets", second["reply"])
                for name in (
                    "Project tracker",
                    "Project milestones",
                    "Aluminium foil production",
                    "1,234",
                ):
                    self.assertIn(name, second["reply"])
                for name in (
                    "Restricted dataset",
                    "Other workspace secret",
                    "SHOW TABLES",
                ):
                    self.assertNotIn(name, second["reply"])
                self.assertEqual(len(second["sources"]), 3)
                self.assertFalse(any("SCORE" in source for source in second["sources"]))
                messages = self.client.get(
                    f"/api/chat/sessions/{first['session_id']}"
                ).json()
                self.assertEqual(
                    [m["ROLE"] for m in messages],
                    ["user", "assistant", "user", "assistant"],
                )
                self.datasets._snapshot.assert_not_called()

    def test_catalog_chat_works_with_empty_catalog_and_stale_dataset_headers(self):
        self.catalog["datasets"] = {}
        self.catalog["activeDatasetId"] = None
        response = self.client.post(
            "/api/chat",
            json={"message": "what data do i have?"},
            headers={"X-Dataset-Id": "deleted", "X-Dataset-Version": "1"},
        )
        result = self.result(response, "/api/chat")
        self.assertIn("no datasets", result["reply"])
        self.assertEqual(result["sources"], [])

    def test_greeting_streams_without_loading_or_mentioning_datasets(self):
        from api.rag.pipeline import RAGPipeline

        events = []
        with patch(
            "api.rag.pipeline.generator.generate_stream",
            return_value=iter(["Hello! ", "How can I help?"]),
        ) as generate:
            result = RAGPipeline().run_stream("hi", event_callback=events.append)
        self.assertEqual(result["reply"], "Hello! How can I help?")
        self.assertEqual(result["sources"], [])
        self.assertEqual(
            [event["content"] for event in events if event["type"] == "token"],
            ["Hello! ", "How can I help?"],
        )
        self.assertEqual(
            generate.call_args.kwargs["generation_config"]["max_tokens"], 48
        )
        self.datasets._catalog.assert_not_called()

    def test_dataset_context_is_bound_on_first_analytical_turn(self):
        session = self.result(
            self.client.post("/api/chat", json={"message": "hi"}), "/api/chat"
        )["session_id"]
        context = ExecutionContext(
            workspace_id="default",
            user_id="member",
            dataset_id="projects",
            version=1,
            semantic_revision=3,
        )
        selection = DatasetSelection(context, self.catalog["datasets"]["projects"], {})
        token = current_selection.set(selection)
        try:
            self.assertEqual(
                self.history.get_or_create_session(session, "member", "count records"),
                session,
            )
            self.assertEqual(
                self.history.get_or_create_session(session, "member", "count records"),
                session,
            )
            sessions = self.history.get_all_sessions("member")
            self.assertEqual(sessions[0]["DATASET_CONTEXT"], context.model_dump())
            self.assertEqual(
                len(self.history.get_session_messages(session, "member")), 2
            )
        finally:
            current_selection.reset(token)
        other = context.model_copy(update={"dataset_id": "milestones"})
        token = current_selection.set(
            DatasetSelection(other, self.catalog["datasets"]["milestones"], {})
        )
        try:
            with self.assertRaises(HTTPException) as raised:
                self.history.get_or_create_session(session, "member", "count records")
            self.assertEqual(raised.exception.status_code, 409)
        finally:
            current_selection.reset(token)

    def test_other_user_session_and_context_rejections_never_fall_back(self):
        other = self.history.create_session("other-user", "Private history")
        self.history.save_message(other, "user", "private contents")
        for endpoint in ("/api/chat", "/api/chat/stream"):
            response = self.client.post(
                endpoint, json={"message": "hi", "session_id": other}
            )
            self.assertEqual(response.status_code, 404, response.text)
            for status in (401, 403, 409):
                with patch.object(
                    self.history,
                    "get_or_create_session",
                    side_effect=HTTPException(status, "Rejected"),
                ):
                    response = self.client.post(
                        endpoint, json={"message": "hi", "session_id": other}
                    )
                    self.assertEqual(response.status_code, status, response.text)
        rows = self.connection.execute(
            "SELECT CONTENT FROM CHAT_MESSAGES WHERE SESSION_ID = ?", (other,)
        ).fetchall()
        self.assertEqual(rows, [("private contents",)])

    def test_storage_failure_gets_new_ephemeral_id_and_no_history_reads_or_writes(self):
        for endpoint in ("/api/chat", "/api/chat/stream"):
            with (
                patch.object(
                    self.history,
                    "get_or_create_session",
                    side_effect=HTTPException(503, "Unavailable"),
                ),
                patch.object(self.history, "get_recent_history") as recent,
                patch.object(self.history, "save_message") as save,
            ):
                result = self.result(
                    self.client.post(
                        endpoint,
                        json={"message": "hi", "session_id": "existing-session"},
                    ),
                    endpoint,
                )
                self.assertTrue(result["session_id"].startswith("ephemeral-"))
                recent.assert_not_called()
                save.assert_not_called()

    def test_invalid_json_and_non_catalog_questions_keep_normal_validation(self):
        response = self.client.post(
            "/api/chat",
            content=b"{broken",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 422)
        self.catalog["activeDatasetId"] = None
        with patch("api.platform.ai_settings.ai_settings", return_value={}):
            response = self.client.post("/api/chat", json={"message": "total revenue"})
        self.assertEqual(response.status_code, 409)

    def test_chunked_chat_body_is_replayed_unchanged(self):
        body = json.dumps(
            {"message": "what data i have ?", "session_id": "default"}
        ).encode()
        events = iter(
            [
                {"type": "http.request", "body": body[:13], "more_body": True},
                {"type": "http.request", "body": body[13:], "more_body": False},
            ]
        )
        received = []

        async def receive():
            return next(events)

        async def downstream(scope, receive, send):
            while True:
                event = await receive()
                received.append(event["body"])
                if not event.get("more_body", False):
                    break

        async def send(event):
            pass

        scope = {
            "type": "http",
            "path": "/api/chat",
            "method": "POST",
            "headers": [(b"content-type", b"application/json")],
        }
        asyncio.run(DatasetContextMiddleware(downstream)(scope, receive, send))
        self.assertEqual(b"".join(received), body)
        self.datasets._snapshot.assert_not_called()


class CatalogIntentTests(unittest.TestCase):
    def test_inventory_phrasing_and_analytical_boundaries(self):
        for message in (
            "what data i have ?",
            "What datasets do I have?",
            "list my tables",
            "show me all datasets",
            "please list available sources",
        ):
            self.assertEqual(catalog_intent(message), "catalog", message)
        for message in (
            "hi show total revenue",
            "what data i have for 2025",
            "list projects by phase",
            "summarize revenue by region",
            "explain this record",
        ):
            self.assertIsNone(catalog_intent(message), message)


if __name__ == "__main__":
    unittest.main()
