"""Model-generated conversation titles, persistence and ownership regressions."""
import sqlite3
import unittest
from unittest.mock import Mock, patch

from api.services.history_service import ChatHistoryService


class ChatTitleTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(':memory:')
        self.addCleanup(self.connection.close)
        self.connection.execute('CREATE TABLE CHAT_SESSIONS (SESSION_ID TEXT PRIMARY KEY, USER_ID TEXT, SUBJECT TEXT)')
        self.connection.execute("INSERT INTO CHAT_SESSIONS VALUES ('session', 'owner', 'New Chat')")
        self.connection.commit()
        self.service = ChatHistoryService()
        self.service._tables_initialized = True
        manager = Mock()
        manager.get_connection.return_value = self.connection
        db = patch('api.services.history_service.db_manager', manager)
        db.start()
        self.addCleanup(db.stop)

    def test_generates_and_persists_model_title_once(self):
        with patch('api.rag.generator.generator.generate', return_value='Project Portfolio Status') as generate:
            title = self.service.ensure_session_title('session', 'owner', 'give me about PRJ-002', 'The project is in Explore.')
            self.assertEqual(title, 'Project Portfolio Status')
            self.assertEqual(self.service.ensure_session_title('session', 'owner', 'another question', 'another reply'), title)
            generate.assert_called_once()
            self.assertIn('The project is in Explore.', generate.call_args.args[0])
            self.assertEqual(generate.call_args.kwargs['generation_config']['timeout'], 8)
        self.assertEqual(self.connection.execute('SELECT SUBJECT FROM CHAT_SESSIONS').fetchone()[0], title)

    def test_failure_keeps_neutral_title_and_can_retry(self):
        with patch('api.rag.generator.generator.generate', side_effect=RuntimeError('unavailable')):
            self.assertIsNone(self.service.ensure_session_title('session', 'owner', 'do not use this as title', 'reply'))
        self.assertEqual(self.connection.execute('SELECT SUBJECT FROM CHAT_SESSIONS').fetchone()[0], 'New Chat')
        with patch('api.rag.generator.generator.generate', return_value='Revenue Performance Overview'):
            self.assertEqual(self.service.ensure_session_title('session', 'owner', 'show revenue', 'reply'), 'Revenue Performance Overview')

    def test_cannot_name_another_users_conversation(self):
        with patch('api.rag.generator.generator.generate') as generate:
            self.assertIsNone(self.service.ensure_session_title('session', 'other', 'question', 'reply'))
            generate.assert_not_called()

    def test_preserves_custom_title(self):
        self.connection.execute("UPDATE CHAT_SESSIONS SET SUBJECT = 'My weekly review'")
        self.connection.commit()
        with patch('api.rag.generator.generator.generate') as generate:
            self.assertEqual(self.service.ensure_session_title('session', 'owner', 'new topic', 'reply'), 'My weekly review')
            generate.assert_not_called()

    def test_invalid_model_output_does_not_become_a_title(self):
        for output in ('', 'one line\nanother line', 'x' * 101):
            with self.subTest(output=output), patch('api.rag.generator.generator.generate', return_value=output):
                self.assertIsNone(self.service.ensure_session_title('session', 'owner', 'question', 'reply'))
