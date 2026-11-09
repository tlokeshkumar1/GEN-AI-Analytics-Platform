"""Regression checks for persistence failures, schema setup and session isolation."""
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Avoid unrelated package initializers; database operations below are isolated.
for package in ("services", "database"):
    module = types.ModuleType(f"api.{package}")
    module.__path__ = [str(Path(__file__).resolve().parents[1] / "api" / package)]
    sys.modules.setdefault(f"api.{package}", module)

from fastapi import HTTPException
from api.services import history_service as history


class ChatHistoryTests(unittest.TestCase):
    def setUp(self):
        self.service = history.ChatHistoryService()
        self.connection = Mock()
        self.cursor = self.connection.cursor.return_value
        self.manager = Mock()
        self.manager.get_connection.return_value = self.connection
        self.manager_patch = patch.object(history, "db_manager", self.manager)
        self.manager_patch.start()
        self.addCleanup(self.manager_patch.stop)

    def test_unavailable_database_is_an_error_and_initialization_can_retry(self):
        self.manager.get_connection.return_value = None
        with self.assertRaises(HTTPException) as error:
            self.service.get_all_sessions("real-user")
        self.assertEqual(error.exception.status_code, 503)
        self.assertFalse(self.service._tables_initialized)
        self.manager.get_connection.return_value = self.connection
        self.cursor.fetchone.return_value = None
        self.service.init_tables(allow_schema_changes=True)
        self.assertTrue(self.service._tables_initialized)
        self.assertTrue(any("SCHEMA_NAME = CURRENT_SCHEMA" in call.args[0] for call in self.cursor.execute.call_args_list))

    def test_schema_failure_is_not_marked_successful_and_connection_is_discarded(self):
        self.cursor.execute.side_effect = RuntimeError("private database connection details")
        with self.assertRaises(HTTPException) as error:
            self.service.init_tables()
        self.assertEqual(error.exception.status_code, 503)
        self.assertNotIn("private", error.exception.detail)
        self.assertFalse(self.service._tables_initialized)
        self.connection.rollback.assert_called_once()
        self.connection.close.assert_called_once()
        self.manager.return_connection.assert_not_called()

    def test_unowned_and_other_user_sessions_are_not_readable_or_deletable(self):
        self.service._tables_initialized = True
        for owner in (None, "another-user"):
            self.cursor.fetchone.return_value = (owner,)
            with self.assertRaises(HTTPException) as error:
                self.service.get_session_messages("saved-session", "real-user")
            self.assertEqual(error.exception.status_code, 404)
            self.assertFalse(self.service.delete_session("saved-session", "real-user"))
        self.assertFalse(any("DELETE" in call.args[0] for call in self.cursor.execute.call_args_list))

    def test_successful_empty_list_is_distinct_from_query_failure(self):
        self.service._tables_initialized = True
        self.cursor.description = [("SESSION_ID",)]
        self.cursor.fetchall.return_value = []
        self.assertEqual(self.service.get_all_sessions("real-user"), [])
        self.cursor.execute.assert_called_with(
            "SELECT SESSION_ID, SUBJECT, CREATED_AT, UPDATED_AT FROM CHAT_SESSIONS WHERE USER_ID = ? ORDER BY UPDATED_AT DESC", ("real-user",))
        self.cursor.execute.side_effect = RuntimeError("query failed")
        with self.assertRaises(HTTPException) as error:
            self.service.get_all_sessions("real-user")
        self.assertEqual(error.exception.status_code, 503)

    def test_failed_write_never_returns_a_fabricated_session_id(self):
        self.service._tables_initialized = True
        self.connection.commit.side_effect = RuntimeError("commit failed")
        with self.assertRaises(HTTPException):
            self.service.create_session("real-user")
        self.connection.rollback.assert_called_once()
        self.connection.close.assert_called_once()

    def test_startup_does_not_create_tables_when_the_schema_is_wrong(self):
        self.cursor.fetchone.return_value = None
        with self.assertRaises(HTTPException) as error:
            self.service.init_tables()
        self.assertEqual(error.exception.status_code, 503)
        self.assertFalse(self.service._tables_initialized)
        self.assertFalse(any("CREATE" in call.args[0] or "ALTER" in call.args[0]
                             for call in self.cursor.execute.call_args_list))


if __name__ == "__main__":
    unittest.main()
