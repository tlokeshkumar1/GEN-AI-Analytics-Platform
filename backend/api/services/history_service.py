"""Persist chat history in the configured SAP HANA schema."""
import json
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from api.database.connection import db_manager
from api.utils.logger import get_logger

logger = get_logger("services.history")


class ChatHistoryService:
    def __init__(self):
        self._tables_initialized = False
        self._init_lock = threading.Lock()
        self._in_memory_sessions: Dict[str, Any] = {}
        self._in_memory_messages: Dict[str, List[Any]] = {}

    @contextmanager
    def _cursor(self, operation: str, write: bool = False):
        conn = db_manager.get_connection()
        if conn is None:
            raise HTTPException(503, "Chat history is unavailable because SAP HANA could not be reached. Please retry.")
        cursor = None
        failed = False
        try:
            cursor = conn.cursor()
            yield cursor
            if write:
                conn.commit()
        except Exception as exc:
            failed = True
            try:
                conn.rollback()
            except Exception:
                pass
            if isinstance(exc, HTTPException):
                raise
            code = getattr(exc, "errorcode", None)
            logger.error("Chat history operation %s failed (%s, code=%s).", operation, type(exc).__name__, code)
            if code == 258 and operation == "initialize tables":
                raise HTTPException(503, "The HANA runtime user cannot change table structure. Check the configured schema and use a database administrator for any required migration.") from None
            raise HTTPException(503, "Chat history could not be read or saved. Check the configured HANA schema, tables and database permissions.") from None
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    failed = True
            if failed:
                try:
                    conn.close()
                except Exception:
                    pass
            else:
                db_manager.return_connection(conn)

    def ensure_tables(self) -> None:
        if not self._tables_initialized:
            self.init_tables()

    def init_tables(self, allow_schema_changes: bool = False) -> None:
        # Retry after failure; never mark a skipped/failed migration successful.
        with self._init_lock:
            if self._tables_initialized:
                return
            with self._cursor("initialize tables", write=True) as cursor:
                def table_exists(name):
                    cursor.execute("SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?", (name,))
                    return cursor.fetchone() is not None

                if not table_exists("CHAT_SESSIONS"):
                    if not allow_schema_changes:
                        raise HTTPException(503, "CHAT_SESSIONS was not found in the configured HANA schema. Check HANA_SCHEMA before creating or migrating tables.")
                    cursor.execute("""CREATE TABLE CHAT_SESSIONS (
                        SESSION_ID VARCHAR(50) PRIMARY KEY,
                        USER_ID VARCHAR(100), SUBJECT VARCHAR(255),
                        CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )""")
                else:
                    cursor.execute("SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = 'CHAT_SESSIONS' AND COLUMN_NAME = 'USER_ID'")
                    if cursor.fetchone() is None:
                        if not allow_schema_changes:
                            raise HTTPException(503, "The configured chat table has no USER_ID ownership column. A database administrator must apply the ownership migration.")
                        # Preserve legacy records; do not guess or assign their owner.
                        cursor.execute("ALTER TABLE CHAT_SESSIONS ADD (USER_ID VARCHAR(100))")
                if not table_exists("CHAT_MESSAGES"):
                    if not allow_schema_changes:
                        raise HTTPException(503, "CHAT_MESSAGES was not found in the configured HANA schema. Check HANA_SCHEMA before creating or migrating tables.")
                    cursor.execute("""CREATE TABLE CHAT_MESSAGES (
                        MESSAGE_ID VARCHAR(50) PRIMARY KEY, SESSION_ID VARCHAR(50),
                        ROLE VARCHAR(15), CONTENT NCLOB, SOURCES NCLOB,
                        INTENT VARCHAR(50), METADATA NCLOB,
                        TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (SESSION_ID) REFERENCES CHAT_SESSIONS(SESSION_ID) ON DELETE CASCADE
                    )""")
                cursor.execute("SELECT SESSION_ID, USER_ID, SUBJECT, CREATED_AT, UPDATED_AT FROM CHAT_SESSIONS WHERE 1=0")
                cursor.execute("SELECT MESSAGE_ID, SESSION_ID, ROLE, CONTENT, SOURCES, INTENT, METADATA, TIMESTAMP FROM CHAT_MESSAGES WHERE 1=0")
            self._tables_initialized = True
            logger.info("Chat history tables verified in the configured HANA schema.")

    @staticmethod
    def _require_identity(user_id: str) -> None:
        if not user_id:
            raise HTTPException(401, "A verified SAP user is required for chat history.")

    def verify_session_owner(self, session_id: str, user_id: str) -> bool:
        self._require_identity(user_id)
        self.ensure_tables()
        with self._cursor("verify owner") as cursor:
            cursor.execute("SELECT USER_ID FROM CHAT_SESSIONS WHERE SESSION_ID = ?", (session_id,))
            row = cursor.fetchone()
            return bool(row and row[0] is not None and row[0] == user_id)

    def create_session(self, user_id: str, subject: str = "New Chat") -> str:
        self._require_identity(user_id)
        self.ensure_tables()
        session_id = f"sess-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        with self._cursor("create session", write=True) as cursor:
            cursor.execute("INSERT INTO CHAT_SESSIONS (SESSION_ID, USER_ID, SUBJECT, CREATED_AT, UPDATED_AT) VALUES (?, ?, ?, ?, ?)",
                           (session_id, user_id, subject[:255], now, now))
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            if selection is not None:
                cursor.execute("INSERT INTO CHAT_MESSAGES (MESSAGE_ID, SESSION_ID, ROLE, CONTENT, METADATA, TIMESTAMP) VALUES (?, ?, ?, ?, ?, ?)",
                               (uuid.uuid4().hex, session_id, "system", "Dataset context", json.dumps({"context": selection.context.model_dump()}), now))
        return session_id

    def get_or_create_session(self, session_id: Optional[str], user_id: str, first_message: str) -> str:
        self._require_identity(user_id)
        self.ensure_tables()
        if session_id and session_id != "default":
            if not self.verify_session_owner(session_id, user_id):
                raise HTTPException(404, "Chat session not found or access denied.")
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            if selection is not None:
                with self._cursor("verify dataset context") as cursor:
                    cursor.execute("SELECT METADATA FROM CHAT_MESSAGES WHERE SESSION_ID = ? AND ROLE = 'system' ORDER BY TIMESTAMP LIMIT 1", (session_id,))
                    row = cursor.fetchone()
                    metadata = json.loads(row[0]) if row and row[0] else {}
                if metadata.get("context") != selection.context.model_dump():
                    raise HTTPException(409, "This conversation belongs to a different dataset, version or semantic revision. Start a new conversation.")
            return session_id
        return self.create_session(user_id, self._generate_subject(first_message))

    @staticmethod
    def _rows(cursor) -> List[Dict[str, Any]]:
        columns = [col[0] for col in cursor.description]
        rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
        for row in rows:
            for key in ("CREATED_AT", "UPDATED_AT", "TIMESTAMP"):
                value = row.get(key)
                if isinstance(value, datetime):
                    row[key] = value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
                elif isinstance(value, str) and value and not value.endswith("Z"):
                    row[key] = value.replace(" ", "T") + "Z"
            for key in ("SOURCES", "METADATA"):
                if row.get(key):
                    row[key] = json.loads(row[key])
        return rows

    def get_all_sessions(self, user_id: str) -> List[Dict[str, Any]]:
        self._require_identity(user_id)
        self.ensure_tables()
        with self._cursor("list sessions") as cursor:
            cursor.execute("SELECT SESSION_ID, SUBJECT, CREATED_AT, UPDATED_AT FROM CHAT_SESSIONS WHERE USER_ID = ? ORDER BY UPDATED_AT DESC", (user_id,))
            sessions = self._rows(cursor)
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            for session in sessions:
                cursor.execute("SELECT METADATA FROM CHAT_MESSAGES WHERE SESSION_ID = ? AND ROLE = 'system' ORDER BY TIMESTAMP LIMIT 1", (session["SESSION_ID"],))
                row = cursor.fetchone()
                session["DATASET_CONTEXT"] = json.loads(row[0]).get("context") if row and row[0] else None
            if selection is not None:
                return [session for session in sessions if session["DATASET_CONTEXT"] == selection.context.model_dump()]
            return sessions

    def get_session_messages(self, session_id: str, user_id: str) -> List[Dict[str, Any]]:
        if not self.verify_session_owner(session_id, user_id):
            raise HTTPException(404, "Chat session not found or access denied.")
        with self._cursor("list messages") as cursor:
            from api.models.execution_context import current_selection
            selection = current_selection.get()
            if selection is not None:
                cursor.execute("SELECT METADATA FROM CHAT_MESSAGES WHERE SESSION_ID = ? AND ROLE = 'system' ORDER BY TIMESTAMP LIMIT 1", (session_id,))
                row = cursor.fetchone()
                context = json.loads(row[0]).get("context") if row and row[0] else None
                if context != selection.context.model_dump():
                    raise HTTPException(409, "This conversation belongs to another data context. Select its original dataset and version.")
            cursor.execute("SELECT MESSAGE_ID, SESSION_ID, ROLE, CONTENT, SOURCES, INTENT, METADATA, TIMESTAMP FROM CHAT_MESSAGES WHERE SESSION_ID = ? AND ROLE <> 'system' ORDER BY TIMESTAMP ASC", (session_id,))
            return self._rows(cursor)

    def delete_session(self, session_id: str, user_id: str) -> bool:
        if not self.verify_session_owner(session_id, user_id):
            return False
        with self._cursor("delete session", write=True) as cursor:
            cursor.execute("DELETE FROM CHAT_MESSAGES WHERE SESSION_ID = ?", (session_id,))
            cursor.execute("DELETE FROM CHAT_SESSIONS WHERE SESSION_ID = ? AND USER_ID = ?", (session_id, user_id))
        return True

    def update_session_subject(self, session_id: str, subject: str, user_id: str) -> None:
        if not self.verify_session_owner(session_id, user_id):
            raise HTTPException(404, "Chat session not found or access denied.")
        with self._cursor("rename session", write=True) as cursor:
            cursor.execute("UPDATE CHAT_SESSIONS SET SUBJECT = ? WHERE SESSION_ID = ? AND USER_ID = ?", (subject[:255], session_id, user_id))

    def save_message(self, session_id: str, role: str, content: str,
                     sources: Optional[List[Dict[str, Any]]] = None,
                     intent: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> str:
        message_id = f"msg-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        from api.models.execution_context import current_selection
        selection = current_selection.get()
        if selection is not None:
            metadata = {**(metadata or {}), "context": selection.context.model_dump()}
        self.ensure_tables()
        with self._cursor("save message", write=True) as cursor:
            cursor.execute("INSERT INTO CHAT_MESSAGES (MESSAGE_ID, SESSION_ID, ROLE, CONTENT, SOURCES, INTENT, METADATA, TIMESTAMP) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                           (message_id, session_id, role, content, json.dumps(sources) if sources else None,
                            intent, json.dumps(metadata) if metadata else None, now))
            cursor.execute("UPDATE CHAT_SESSIONS SET UPDATED_AT = ? WHERE SESSION_ID = ?", (now, session_id))
        return message_id

    def get_recent_history(self, session_id: str, limit: int = 10) -> List[Dict[str, str]]:
        self.ensure_tables()
        with self._cursor("recent messages") as cursor:
            cursor.execute("SELECT ROLE, CONTENT FROM CHAT_MESSAGES WHERE SESSION_ID = ? AND ROLE <> 'system' ORDER BY TIMESTAMP DESC LIMIT ?", (session_id, limit))
            return [{"role": row[0], "content": row[1]} for row in reversed(cursor.fetchall())]

    @staticmethod
    def _generate_subject(first_message: str) -> str:
        subject = first_message.strip().replace("\n", " ")
        return (subject[:57] + "..." if len(subject) > 60 else subject) or "New Chat"


history_service = ChatHistoryService()
