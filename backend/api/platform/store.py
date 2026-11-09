import tempfile
"""Revision-checked metadata storage: SQLite for development, HANA for production.

HANA tables must be provisioned with the supplied migration; API reads never run DDL.
"""
import json
import os
import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException


class MetadataStore:
    def __init__(self, path=None, backend=None):
        self.backend = backend or os.getenv("PLATFORM_METADATA_BACKEND", "hana")
        self.path = Path(path or os.getenv("PLATFORM_METADATA_PATH", str(Path(tempfile.gettempdir()) / "platform_runtime" / ".platform.sqlite3")))
        self._cursor = ContextVar(f"metadata_transaction_{id(self)}", default=None)
        if self.backend not in ("sqlite", "hana"):
            raise ValueError("Unsupported metadata backend")
        if os.getenv("VCAP_APPLICATION") and self.backend != "hana":
            raise RuntimeError("Production metadata requires the persistent HANA backend")

    @contextmanager
    def transaction(self):
        active = self._cursor.get()
        if active is not None:
            yield active
            return
        conn = cursor = None
        token = None
        failed = False
        try:
            if self.backend == "sqlite":
                self.path.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(self.path, timeout=15)
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("CREATE TABLE IF NOT EXISTS PLATFORM_DOCUMENTS (NAMESPACE TEXT NOT NULL, DOCUMENT_ID TEXT NOT NULL, REVISION INTEGER NOT NULL, PAYLOAD TEXT NOT NULL, PRIMARY KEY (NAMESPACE, DOCUMENT_ID))")
                conn.execute("BEGIN IMMEDIATE")
            else:
                from api.database.connection import db_manager
                conn = db_manager.get_connection()
                if conn is None:
                    raise HTTPException(503, "Persistent metadata storage is unavailable.")
            cursor = conn.cursor()
            token = self._cursor.set(cursor)
            yield cursor
            conn.commit()
        except Exception as exc:
            failed = True
            if conn:
                conn.rollback()
            if isinstance(exc, (HTTPException, ValueError)):
                raise
            raise HTTPException(503, "Metadata storage failed. Check configuration and apply the documented migration.") from None
        finally:
            if token is not None:
                self._cursor.reset(token)
            if cursor:
                cursor.close()
            if conn:
                if self.backend == "sqlite" or failed:
                    conn.close()
                else:
                    from api.database.connection import db_manager
                    db_manager.return_connection(conn)

    @staticmethod
    def _decode(row):
        if row is None:
            return None
        payload = row[1].read() if hasattr(row[1], "read") else row[1]
        return {"revision": row[0], "value": json.loads(payload)}

    def get(self, namespace, key):
        with self.transaction() as cursor:
            cursor.execute("SELECT REVISION, PAYLOAD FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID=?", (namespace, key))
            return self._decode(cursor.fetchone())

    def list(self, namespace):
        with self.transaction() as cursor:
            cursor.execute("SELECT DOCUMENT_ID, REVISION, PAYLOAD FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? ORDER BY DOCUMENT_ID", (namespace,))
            return [{"id": row[0], **self._decode(row[1:])} for row in cursor.fetchall()]

    def put(self, namespace, key, value, expected_revision=0):
        payload = json.dumps(value, ensure_ascii=False, allow_nan=False, default=str)
        with self.transaction() as cursor:
            cursor.execute("SELECT REVISION FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID=?", (namespace, key))
            row = cursor.fetchone()
            revision = row[0] if row else 0
            if revision != expected_revision:
                raise HTTPException(409, "This record changed. Refresh and retry.")
            if row:
                cursor.execute("UPDATE PLATFORM_DOCUMENTS SET REVISION=?, PAYLOAD=? WHERE NAMESPACE=? AND DOCUMENT_ID=? AND REVISION=?",
                               (revision + 1, payload, namespace, key, revision))
                if cursor.rowcount != 1:
                    raise HTTPException(409, "Concurrent update. Refresh and retry.")
            else:
                cursor.execute("INSERT INTO PLATFORM_DOCUMENTS (NAMESPACE, DOCUMENT_ID, REVISION, PAYLOAD) VALUES (?, ?, ?, ?)",
                               (namespace, key, 1, payload))
        return {"revision": revision + 1, "value": value}

    def delete_dataset_metadata(self, workspace_id: str, dataset_id: str) -> int:
        """Purge all metadata documents (semantics, reviews, analytics items, dashboards) for a dataset."""
        patterns = [
            f"{workspace_id}:%:{dataset_id}:%",
            f"%:{dataset_id}:%",
            f"%:{dataset_id}",
        ]
        with self.transaction() as cursor:
            total_deleted = 0
            for pattern in patterns:
                cursor.execute("DELETE FROM PLATFORM_DOCUMENTS WHERE NAMESPACE LIKE ?", (pattern,))
                total_deleted += cursor.rowcount if cursor.rowcount > 0 else 0
            return total_deleted


@lru_cache(maxsize=1)
def metadata_store():
    return MetadataStore()
