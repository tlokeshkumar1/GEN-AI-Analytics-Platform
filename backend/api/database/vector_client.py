from typing import List, Dict, Any, Optional
import json
import threading
from api.database.hana_client import hana_client
from api.utils.logger import get_logger

logger = get_logger("database.vector_client")

# Module-level flag to ensure schema check runs only once per process
_schema_initialized = False
_schema_lock = threading.Lock()

class HANAVectorClient:
    def replace_dataset_version(self, dataset_id, version, chunks, embeddings, source, previous_version=None, previous_chunks=None, metadata_extra=None):
        """Publish a complete version in one transaction; preserve other versions.
        If previous_version has matching chunks in HANA, performs instant server-side delta clone.
        """
        if len(chunks) != len(embeddings):
            raise ValueError("Every chunk must have a matching embedding")
        from api.database.connection import db_manager
        conn = db_manager.get_connection()
        if conn is None:
            raise RuntimeError("HANA vector database is unavailable")
        cursor = None
        try:
            conn.setautocommit(False)
            cursor = conn.cursor()
            prefix = f"{dataset_id}:v{version}:"
            cursor.execute("DELETE FROM VECTOR_TABLE WHERE ID LIKE ?", (prefix + "%",))
            metadata = json.dumps({"dataset_id": dataset_id, "version": version, "source": source, **(metadata_extra or {})})

            delta_synced = False
            if previous_version is not None and previous_chunks is not None and len(previous_chunks) == len(chunks):
                prev_prefix = f"{dataset_id}:v{previous_version}:"
                cursor.execute("SELECT COUNT(*) FROM VECTOR_TABLE WHERE ID LIKE ?", (prev_prefix + "%",))
                row = cursor.fetchone()
                prev_count = row[0] if row else 0
                if prev_count == len(chunks):
                    # Clone unchanged vectors in HANA; elapsed time depends on the deployment.
                    clone_sql = """
                    INSERT INTO VECTOR_TABLE (ID, TEXT_CHUNK, EMBEDDING, METADATA)
                    SELECT REPLACE(ID, ?, ?), TEXT_CHUNK, EMBEDDING, ?
                    FROM VECTOR_TABLE WHERE ID LIKE ?
                    """
                    cursor.execute(clone_sql, (prev_prefix, prefix, metadata, prev_prefix + "%"))

                    # Identify changed chunk indices
                    changed_indices = [i for i in range(len(chunks)) if chunks[i] != previous_chunks[i]]
                    for idx in changed_indices:
                        target_id = f"{prefix}{idx}"
                        cursor.execute("DELETE FROM VECTOR_TABLE WHERE ID = ?", (target_id,))
                        cursor.execute(
                            "INSERT INTO VECTOR_TABLE (ID, TEXT_CHUNK, EMBEDDING, METADATA) VALUES (?, ?, TO_REAL_VECTOR(?), ?)",
                            (target_id, chunks[idx], str(embeddings[idx]), metadata)
                        )
                    delta_synced = True
                    logger.info(f"HANA delta sync: cloned {len(chunks) - len(changed_indices)} vectors, updated {len(changed_indices)} vectors")

            if not delta_synced:
                sql = "INSERT INTO VECTOR_TABLE (ID, TEXT_CHUNK, EMBEDDING, METADATA) VALUES (?, ?, TO_REAL_VECTOR(?), ?)"
                batch_size = 256
                total = len(chunks)
                for start in range(0, total, batch_size):
                    end = min(start + batch_size, total)
                    cursor.executemany(sql, [(prefix + str(i), chunks[i], str(embeddings[i]), metadata)
                                            for i in range(start, end)])
                    if end % 2560 == 0 or end == total:
                        logger.info(f"HANA sync progress: {end}/{total} vectors inserted into VECTOR_TABLE")

            conn.commit()
            cursor.close()
            cursor = None
        except Exception:
            try:
                conn.rollback()
            finally:
                conn.close()
            raise
        else:
            db_manager.return_connection(conn)
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    pass

    def search_dataset_version(self, dataset_id, version, embedding, top_k, text_query: Optional[str] = None):
        """
        Query SAP HANA Cloud Vector Engine using native COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR(?)).
        When text_query specifies particular entity identifiers (e.g. Order ID SO-XXXXX),
        performs hybrid lookup against VECTOR_TABLE to ensure exact matches are included.
        """
        exact_chunks = []
        target_pattern = f"%{dataset_id}%" if dataset_id else "%"
        if text_query:
            import re
            matches = re.findall(r'\b(SO-\d+|P\d{4}|C\d{4})\b', text_query, re.IGNORECASE)
            for m in matches[:2]:
                keyword_sql = f"""SELECT TOP 2 ID, TEXT_CHUNK, METADATA, 1.0 AS SCORE
                                  FROM VECTOR_TABLE
                                  WHERE ID LIKE ? AND (TEXT_CHUNK LIKE ? OR ID LIKE ?)"""
                found = hana_client.execute_query(keyword_sql, (target_pattern, f"%{m}%", f"%{m}%"))
                if not found:
                    legacy_sql = """SELECT TOP 2 ID, TEXT_CHUNK, METADATA, 1.0 AS SCORE
                                    FROM VECTOR_TABLE
                                    WHERE (TEXT_CHUNK LIKE ? OR ID LIKE ?)"""
                    found = hana_client.execute_query(legacy_sql, (f"%{m}%", f"%{m}%"))
                for row in found:
                    if not any(r["ID"] == row["ID"] for r in exact_chunks):
                        exact_chunks.append(row)

        vector_results = []
        if embedding:
            sql = f"""SELECT TOP {int(top_k)} ID, TEXT_CHUNK, METADATA,
                      COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR(?)) AS SCORE
                      FROM VECTOR_TABLE WHERE ID LIKE ? ORDER BY SCORE DESC"""
            try:
                vector_results = hana_client.execute_query(sql, (str(embedding), target_pattern))
            except Exception as e:
                logger.warning(f"HANA Cloud vector search with pattern {target_pattern} failed: {e}")

            if not vector_results:
                sql_all = f"""SELECT TOP {int(top_k)} ID, TEXT_CHUNK, METADATA,
                              COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR(?)) AS SCORE
                              FROM VECTOR_TABLE ORDER BY SCORE DESC"""
                try:
                    vector_results = hana_client.execute_query(sql_all, (str(embedding),))
                except Exception as e:
                    logger.warning(f"HANA Cloud fallback vector search failed: {e}")

        # Combine exact matches with top semantic vector results
        combined = []
        seen_ids = set()
        for r in exact_chunks:
            if r["ID"] not in seen_ids:
                combined.append(r)
                seen_ids.add(r["ID"])
        for r in vector_results:
            if r["ID"] not in seen_ids:
                combined.append(r)
                seen_ids.add(r["ID"])
        return combined[:top_k]

    def update_row_vector(self, dataset_id: str, row_identifier: str, text_chunk: str, embedding: List[float], metadata: Optional[Dict[str, Any]] = None) -> bool:
        """
        Incrementally update or insert a single row's vector in VECTOR_TABLE without recreating the whole table.
        """
        from api.database.connection import db_manager
        conn = db_manager.get_connection()
        if not conn:
            return False
        cursor = None
        try:
            conn.setautocommit(True)
            cursor = conn.cursor()
            meta_str = json.dumps(metadata) if metadata else "{}"

            target_pattern = f"%{dataset_id}%"
            row_pattern = f"%{row_identifier}%"
            cursor.execute(
                "SELECT ID FROM VECTOR_TABLE WHERE ID LIKE ? AND (ID LIKE ? OR TEXT_CHUNK LIKE ?) LIMIT 10",
                (target_pattern, row_pattern, row_pattern)
            )
            found_rows = cursor.fetchall()
            if found_rows:
                for r in found_rows:
                    v_id = r[0]
                    cursor.execute(
                        "UPDATE VECTOR_TABLE SET TEXT_CHUNK = ?, EMBEDDING = TO_REAL_VECTOR(?), METADATA = ? WHERE ID = ?",
                        (text_chunk, str(embedding), meta_str, v_id)
                    )
                logger.info(f"Incrementally updated {len(found_rows)} vector(s) in VECTOR_TABLE for record {row_identifier}")
            else:
                target_id = f"{dataset_id}:{row_identifier}"
                cursor.execute(
                    "INSERT INTO VECTOR_TABLE (ID, TEXT_CHUNK, EMBEDDING, METADATA) VALUES (?, ?, TO_REAL_VECTOR(?), ?)",
                    (target_id, text_chunk, str(embedding), meta_str)
                )
                logger.info(f"Inserted new single vector in VECTOR_TABLE for record {row_identifier}")
            return True
        except Exception as exc:
            logger.warning(f"Could not incrementally update vector for {row_identifier}: {exc}")
            return False
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def delete_row_vector(self, dataset_id: str, row_identifier: str) -> bool:
        """Delete vector for a deleted record from VECTOR_TABLE."""
        try:
            target_pattern = f"%{dataset_id}%"
            row_pattern = f"%{row_identifier}%"
            hana_client.execute_query(
                "DELETE FROM VECTOR_TABLE WHERE ID LIKE ? AND (ID LIKE ? OR TEXT_CHUNK LIKE ?)",
                (target_pattern, row_pattern, row_pattern)
            )
            return True
        except Exception as exc:
            logger.warning(f"Could not delete vector for row {row_identifier}: {exc}")
            return False

    def delete_dataset_version(self, dataset_id: str, version: int):
        """Delete all vectors for a specific dataset version."""
        try:
            hana_client.execute_query(
                "DELETE FROM VECTOR_TABLE WHERE ID LIKE ? OR ID LIKE ? OR (METADATA LIKE ? AND METADATA LIKE ?)",
                (f"{dataset_id}:v{version}:%", f"%:{dataset_id}:%:v{version}:%", f'%"dataset_id": "{dataset_id}"%', f'%"version": {version}%')
            )
        except Exception as e:
            logger.warning(f"Could not prune HANA vectors for dataset {dataset_id} v{version}: {e}")
        try:
            from api.services.vector_service import vector_service
            vector_service.cache.clear()
        except Exception:
            pass

    def delete_dataset(self, dataset_id: str):
        """Delete all vectors for an entire dataset across all versions."""
        try:
            # Match both raw dataset_id prefixes and workspace-hashed namespaces (e.g. w<hash>:<dataset_id>:i<hash>:v<ver>:...)
            hana_client.execute_query(
                "DELETE FROM VECTOR_TABLE WHERE ID LIKE ? OR ID LIKE ? OR METADATA LIKE ?",
                (f"{dataset_id}:%", f"%:{dataset_id}:%", f'%"dataset_id": "{dataset_id}"%')
            )
            logger.info(f"Purged vector embeddings for dataset '{dataset_id}' from VECTOR_TABLE")
        except Exception as e:
            logger.warning(f"Could not delete HANA vectors for dataset {dataset_id}: {e}")
        try:
            from api.services.vector_service import vector_service
            vector_service.cache.clear()
        except Exception:
            pass

    def __init__(self):
        # Production schemas are provisioned by explicit migrations, never imports.
        pass

    def _ensure_schema_once(self):
        global _schema_initialized
        # Thread-safe one-time schema initialization per process
        with _schema_lock:
            if _schema_initialized:
                return
            try:
                # Create VECTOR_TABLE if it doesn't exist
                sql = """
                CREATE COLUMN TABLE VECTOR_TABLE (
                    ID NVARCHAR(100) NOT NULL,
                    TEXT_CHUNK NCLOB,
                    EMBEDDING REAL_VECTOR(1536),
                    METADATA NCLOB,
                    CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (ID)
                )
                """
                hana_client.execute_query(sql)
                logger.info("Successfully created VECTOR_TABLE in database")
            except Exception as e:
                # If the table already exists, ignore silently (not a warning)
                if "already exists" not in str(e).lower() and "duplicate table name" not in str(e).lower():
                    logger.warning(f"Could not create VECTOR_TABLE: {e}")
            
            try:
                # Try to add METADATA column if it doesn't exist
                hana_client.execute_query("ALTER TABLE VECTOR_TABLE ADD (METADATA NCLOB)")
                logger.info("Checked and updated VECTOR_TABLE to support METADATA")
            except Exception as e:
                # Column already exists is fine - suppress warning
                if "already exists" not in str(e).lower() and "column name already exists" not in str(e).lower():
                    logger.debug(f"METADATA column check: {e}")
            _schema_initialized = True


    def similarity_search(self, query_embedding: List[float], top_k: int = 5, metadata_filters: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        # Uses SAP HANA Vector Engine COSINE_SIMILARITY with optional metadata filtering
        vector_str = f"'{query_embedding}'"
        where_clause = ""
        
        if metadata_filters:
            conditions = []
            for k, v in metadata_filters.items():
                if v:
                    clean_val = str(v).replace("'", "''")
                    conditions.append(f"LIKE(METADATA, '%\"{k}\": \"{clean_val}\"%')")
            if conditions:
                where_clause = "WHERE " + " AND ".join(conditions)

        sql = f"""
            SELECT TOP {top_k} ID, TEXT_CHUNK, METADATA, COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR({vector_str})) AS SCORE
            FROM VECTOR_TABLE
            {where_clause}
            ORDER BY SCORE DESC
        """
        try:
            return hana_client.execute_query(sql)
        except Exception as e:
            logger.warning(f"Vector search returned empty results due to DB state: {e}")
            return []

    def store_vector(self, doc_id: str, text_chunk: str, embedding: List[float], metadata: Optional[Any] = None):
        # Schema already initialized in __init__, no need to check again
        vector_str = str(embedding)
        metadata_str = None
        if metadata is not None:
            if isinstance(metadata, str):
                metadata_str = metadata
            else:
                try:
                    metadata_str = json.dumps(metadata)
                except Exception:
                    metadata_str = str(metadata)

        sql = """
            INSERT INTO VECTOR_TABLE (ID, TEXT_CHUNK, EMBEDDING, METADATA)
            VALUES (?, ?, TO_REAL_VECTOR(?), ?)
        """
        try:
            hana_client.execute_query(sql, (doc_id, text_chunk, vector_str, metadata_str))
        except Exception as e:
            logger.warning(f"Vector store fallback: {e}")

vector_client = HANAVectorClient()
