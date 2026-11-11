import re
import math
import time
import struct
import datetime
from decimal import Decimal
from typing import List, Dict, Any, Optional
import pandas as pd
from api.database.connection import db_manager
from api.config import settings
from api.utils.logger import get_logger

logger = get_logger("database.hana_table_service")

# Reserved / internal tables that should not be listed as business tables by default
INTERNAL_TABLES = {
    "VECTOR_TABLE",
    "CHAT_SESSIONS",
    "CHAT_MESSAGES",
    "DATASETS_METADATA",
    "PLATFORM_METADATA",
}


def serialize_hana_value(val: Any) -> Any:
    """Safely serialize HANA data types (including REAL_VECTOR, memoryview, LOBs, Decimal) into JSON-compatible primitives."""
    if val is None:
        return None
    if isinstance(val, (datetime.datetime, datetime.date, datetime.time)):
        return val.isoformat()
    if isinstance(val, Decimal):
        return float(val) if (val % 1 != 0) else int(val)
    if isinstance(val, (memoryview, bytes, bytearray)):
        raw = bytes(val)
        # Check if it represents a float vector (e.g. REAL_VECTOR 1536 dims)
        if len(raw) % 4 == 0 and len(raw) >= 16:
            try:
                dim = len(raw) // 4
                floats = struct.unpack(f"{dim}f", raw)
                sample = ", ".join(f"{round(x, 4)}" for x in floats[:4])
                return f"[{sample}, ... ({dim} dims)]"
            except Exception:
                pass
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw[:32].hex() + ("..." if len(raw) > 32 else "")
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return None
        return val
    # Handle LOB stream reader if returned by driver
    if hasattr(val, "read"):
        try:
            lob_data = val.read()
            if isinstance(lob_data, bytes):
                return lob_data.decode("utf-8", errors="replace")
            return str(lob_data)
        except Exception:
            return str(val)
    return val


class HANATableService:
    def sanitize_identifier(self, name: str) -> str:
        """Sanitize table or column name into a valid SAP HANA SQL identifier."""
        # Strip file extensions if present
        name = re.sub(r"\.(xlsx|xls|csv)$", "", str(name or ""), flags=re.IGNORECASE)
        # Replace invalid characters with underscore
        clean = re.sub(r"[^A-Za-z0-9_]", "_", name.strip())
        # Collapse multiple underscores
        clean = re.sub(r"_+", "_", clean).strip("_").upper()
        if not clean:
            clean = "UPLOADED_TABLE"
        # Ensure it doesn't start with a digit
        if clean[0].isdigit():
            clean = f"T_{clean}"
        return clean[:64]

    def list_user_tables(self, include_internal: bool = False) -> List[Dict[str, Any]]:
        """List user-accessible tables in the configured HANA schema. Automatically detects new tables."""
        conn = db_manager.get_connection()
        if not conn:
            logger.warning("HANA Database connection unavailable for table listing.")
            return []

        cursor = None
        tables = []
        try:
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            # Fetch live table names from SYS.TABLES in CURRENT_SCHEMA
            cursor.execute(
                """
                SELECT SCHEMA_NAME, TABLE_NAME, TABLE_TYPE 
                FROM SYS.TABLES 
                WHERE SCHEMA_NAME = CURRENT_SCHEMA
                ORDER BY TABLE_NAME ASC
                """
            )
            rows = cursor.fetchall()

            # Batch query row counts in a single query from SYS.M_TABLES
            table_counts = {}
            try:
                cursor.execute(
                    """
                    SELECT TABLE_NAME, RECORD_COUNT 
                    FROM SYS.M_TABLES 
                    WHERE SCHEMA_NAME = CURRENT_SCHEMA
                    """
                )
                for rc_table, rc_count in cursor.fetchall():
                    table_counts[rc_table] = int(rc_count) if rc_count is not None else 0
            except Exception as e:
                logger.debug(f"SYS.M_TABLES bulk count query unavailable ({e}), will use fallback if needed.")

            # Batch query all column definitions in one single query
            cols_by_table = {}
            try:
                cursor.execute(
                    """
                    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE 
                    FROM SYS.TABLE_COLUMNS 
                    WHERE SCHEMA_NAME = CURRENT_SCHEMA
                    ORDER BY TABLE_NAME ASC, POSITION ASC
                    """
                )
                for col_table, col_name, data_type, length, scale in cursor.fetchall():
                    cols_by_table.setdefault(col_table, []).append(
                        {
                            "name": col_name,
                            "type": data_type,
                            "length": length,
                            "scale": scale,
                        }
                    )
            except Exception as e:
                logger.debug(f"SYS.TABLE_COLUMNS bulk query unavailable ({e}), will use fallback if needed.")

            for schema_name, table_name, table_type in rows:
                is_internal = table_name.upper() in INTERNAL_TABLES
                if not include_internal and is_internal:
                    continue

                # Query row count safely with fallback
                row_count = table_counts.get(table_name)
                if row_count is None:
                    try:
                        cursor.execute(f'SELECT COUNT(*) FROM "{schema_name}"."{table_name}"')
                        rc_row = cursor.fetchone()
                        row_count = int(rc_row[0]) if rc_row else 0
                    except Exception as e:
                        logger.debug(f"Could not count rows for {schema_name}.{table_name}: {e}")
                        row_count = 0

                columns = cols_by_table.get(table_name)
                if columns is None:
                    try:
                        cursor.execute(
                            """
                            SELECT COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE 
                            FROM SYS.TABLE_COLUMNS 
                            WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
                            ORDER BY POSITION ASC
                            """,
                            (schema_name, table_name),
                        )
                        cols = cursor.fetchall()
                        columns = [
                            {
                                "name": col[0],
                                "type": col[1],
                                "length": col[2],
                                "scale": col[3],
                            }
                            for col in cols
                        ]
                    except Exception as e:
                        logger.debug(f"Could not fetch columns for {schema_name}.{table_name}: {e}")
                        columns = []

                tables.append(
                    {
                        "name": table_name,
                        "schema": schema_name,
                        "type": table_type,
                        "rowCount": row_count,
                        "columnCount": len(columns),
                        "columns": columns,
                        "isInternal": is_internal,
                    }
                )
            return tables
            return tables
        except Exception as e:
            logger.error(f"Failed to list HANA tables: {e}")
            return []
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def table_exists(self, table_name: str) -> bool:
        """Check if a table exists in the current schema."""
        clean_name = self.sanitize_identifier(table_name)
        conn = db_manager.get_connection()
        if not conn:
            return False
        cursor = None
        try:
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')
            cursor.execute(
                "SELECT 1 FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?",
                (clean_name,),
            )
            return cursor.fetchone() is not None
        except Exception as e:
            logger.error(f"Error checking table existence for {clean_name}: {e}")
            return False
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def infer_column_types(self, df: pd.DataFrame) -> List[tuple[str, str]]:
        """Map DataFrame columns to appropriate SAP HANA Cloud SQL data types."""
        cols = []
        for col in df.columns:
            clean_col = self.sanitize_identifier(str(col))
            series = df[col].dropna()
            
            if series.empty:
                cols.append((clean_col, "NVARCHAR(500)"))
                continue

            dtype = df[col].dtype
            if pd.api.types.is_bool_dtype(dtype):
                hana_type = "BOOLEAN"
            elif pd.api.types.is_integer_dtype(dtype):
                hana_type = "BIGINT"
            elif pd.api.types.is_float_dtype(dtype):
                hana_type = "DECIMAL(15, 2)"
            elif pd.api.types.is_datetime64_any_dtype(dtype):
                has_time = any(getattr(t, 'hour', 0) != 0 or getattr(t, 'minute', 0) != 0 for t in series.head(20))
                hana_type = "TIMESTAMP" if has_time else "DATE"
            else:
                max_len = series.astype(str).str.len().max()
                if max_len > 500:
                    hana_type = "NCLOB"
                elif max_len > 255:
                    hana_type = "NVARCHAR(500)"
                else:
                    hana_type = "NVARCHAR(255)"
            
            cols.append((clean_col, hana_type))
        return cols

    def create_table(self, table_name: str, column_defs: List[tuple[str, str]]) -> bool:
        """Create a new COLUMN TABLE in SAP HANA Cloud."""
        clean_table = self.sanitize_identifier(table_name)
        col_sql_parts = [f'"{col_name}" {data_type}' for col_name, data_type in column_defs]
        sql = f'CREATE COLUMN TABLE "{clean_table}" ({", ".join(col_sql_parts)})'

        conn = db_manager.get_connection()
        if not conn:
            raise RuntimeError("HANA database is unavailable.")

        cursor = None
        try:
            conn.setautocommit(False)
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            logger.info(f"Creating HANA column table '{clean_table}' with {len(column_defs)} columns...")
            cursor.execute(sql)
            conn.commit()
            logger.info(f"Successfully created table '{clean_table}' in SAP HANA Cloud.")
            return True
        except Exception as e:
            conn.rollback()
            logger.error(f"Failed to create table '{clean_table}': {e}")
            raise e
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def drop_table(self, table_name: str) -> Dict[str, Any]:
        """
        Safely drop a user-created column table in SAP HANA Cloud.
        Guards strictly prevent dropping core system tables.
        """
        clean_table = self.sanitize_identifier(table_name)
        protected_system_tables = {
            "DATASETS_METADATA", "PLATFORM_METADATA", "PLATFORM_DOCUMENTS",
            "VECTOR_TABLE", "CHAT_MESSAGES", "CHAT_SESSIONS"
        }
        if clean_table.upper() in protected_system_tables:
            raise ValueError(f"Dropping protected system table '{clean_table}' is strictly prohibited.")

        conn = db_manager.get_connection()
        if not conn:
            raise RuntimeError("HANA database is unavailable.")

        cursor = None
        try:
            conn.setautocommit(False)
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            # Check if table exists in current schema
            cursor.execute(
                "SELECT 1 FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?",
                (clean_table,),
            )
            exists = cursor.fetchone() is not None
            if not exists:
                logger.info(f"Table '{clean_table}' does not exist in SAP HANA Cloud. Skipping drop.")
                return {"success": True, "dropped": False, "table_name": clean_table, "reason": "not_found"}

            logger.info(f"Dropping HANA column table '{clean_table}'...")
            cursor.execute(f'DROP TABLE "{clean_table}"')
            conn.commit()
            logger.info(f"Successfully dropped table '{clean_table}' from SAP HANA Cloud.")
            return {"success": True, "dropped": True, "table_name": clean_table}
        except Exception as e:
            conn.rollback()
            logger.error(f"Failed to drop table '{clean_table}': {e}")
            raise e
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def persist_dataframe(
        self,
        df: pd.DataFrame,
        table_name: str,
        action: str = "create",
    ) -> Dict[str, Any]:
        """
        Persist structured rows from a DataFrame into a SAP HANA Cloud relational table.
        action: 'create', 'append', or 'replace'
        """
        clean_table = self.sanitize_identifier(table_name)
        if df is None or df.empty:
            return {"success": False, "message": "DataFrame contains no rows to insert.", "table_name": clean_table, "rows_inserted": 0}

        conn = db_manager.get_connection()
        if not conn:
            raise RuntimeError("HANA database is unavailable.")

        cursor = None
        try:
            schema = settings.HANA_SCHEMA
            conn.setautocommit(False)
            cursor = conn.cursor()
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            # Check if table exists
            cursor.execute(
                "SELECT 1 FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?",
                (clean_table,),
            )
            exists = cursor.fetchone() is not None

            # Generate column definitions
            col_defs = self.infer_column_types(df)
            col_names = [c[0] for c in col_defs]

            if not exists or action == "create":
                if not exists:
                    # Create the table
                    col_sql_parts = [f'"{col_name}" {data_type}' for col_name, data_type in col_defs]
                    create_sql = f'CREATE COLUMN TABLE "{clean_table}" ({", ".join(col_sql_parts)})'
                    logger.info(f"Creating new table: {create_sql}")
                    cursor.execute(create_sql)
                elif action == "replace":
                    cursor.execute(f'DELETE FROM "{clean_table}"')
            elif action == "replace":
                cursor.execute(f'DELETE FROM "{clean_table}"')

            # Fetch existing columns from HANA to ensure column alignment
            cursor.execute(
                "SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ? ORDER BY POSITION",
                (clean_table,),
            )
            table_cols = [r[0] for r in cursor.fetchall()]

            # Align DataFrame columns with table columns
            col_mapping = {self.sanitize_identifier(str(c)): c for c in df.columns}
            matched_cols = [c for c in table_cols if c in col_mapping]
            if not matched_cols:
                matched_cols = col_names

            # Prepare values for parameterized insert
            quoted_cols = ", ".join([f'"{c}"' for c in matched_cols])
            placeholders = ", ".join(["?" for _ in matched_cols])
            insert_sql = f'INSERT INTO "{clean_table}" ({quoted_cols}) VALUES ({placeholders})'

            def clean_val(v):
                if pd.isna(v) or v is None:
                    return None
                if hasattr(v, 'strftime'):
                    return v.strftime("%Y-%m-%d %H:%M:%S")
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    return None
                return v

            records = []
            for _, row in df.iterrows():
                row_tuple = tuple(clean_val(row.get(col_mapping.get(c, c))) for c in matched_cols)
                records.append(row_tuple)

            # Insert in batches of 500
            batch_size = 500
            for start_idx in range(0, len(records), batch_size):
                batch = records[start_idx : start_idx + batch_size]
                cursor.executemany(insert_sql, batch)

            conn.commit()
            logger.info(f"Successfully stored {len(records)} rows into HANA table '{clean_table}'.")

            return {
                "success": True,
                "table_name": clean_table,
                "rows_inserted": len(records),
                "action": action,
                "message": f"Successfully loaded {len(records)} rows into SAP HANA Cloud table '{clean_table}'.",
            }
        except Exception as e:
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.error(f"Failed to persist DataFrame into HANA table '{clean_table}': {e}")
            raise e
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def get_table_columns(self, table_name: str) -> List[Dict[str, Any]]:
        """Get column metadata for a specific table in SAP HANA Cloud."""
        clean_table = self.sanitize_identifier(table_name)
        conn = db_manager.get_connection()
        if not conn:
            return []
        cursor = None
        try:
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')
            cursor.execute(
                """
                SELECT COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE, POSITION, DEFAULT_VALUE, COMMENTS
                FROM SYS.TABLE_COLUMNS
                WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?
                ORDER BY POSITION ASC
                """,
                (clean_table,),
            )
            cols = []
            for row in cursor.fetchall():
                cols.append({
                    "name": row[0],
                    "type": row[1],
                    "length": row[2],
                    "scale": row[3],
                    "isNullable": row[4] == "TRUE",
                    "position": row[5],
                    "defaultValue": row[6],
                    "comments": row[7],
                })
            return cols
        except Exception as e:
            logger.error(f"Error fetching columns for {clean_table}: {e}")
            return []
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def get_table_data(
        self,
        table_name: str,
        page: int = 1,
        page_size: int = 25,
        sort_col: Optional[str] = None,
        sort_dir: str = "ASC",
        search: str = "",
    ) -> Dict[str, Any]:
        """
        Fetch paginated data for any SAP HANA Cloud table with optional search filtering and sorting.
        Safely automatically handles any existing or future table.
        """
        clean_table = self.sanitize_identifier(table_name)
        conn = db_manager.get_connection()
        if not conn:
            raise RuntimeError("HANA Database connection unavailable.")

        page = max(1, page)
        page_size = max(1, min(500, page_size))
        offset = (page - 1) * page_size
        sort_direction = "DESC" if str(sort_dir).upper() == "DESC" else "ASC"

        cursor = None
        try:
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            # Verify table exists in current schema
            cursor.execute(
                "SELECT 1 FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?",
                (clean_table,),
            )
            if not cursor.fetchone():
                raise ValueError(f"Table '{clean_table}' does not exist in schema '{schema}'.")

            # Fetch columns
            cols = self.get_table_columns(clean_table)
            if not cols:
                cursor.execute(
                    "SELECT COLUMN_NAME, DATA_TYPE_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ? ORDER BY POSITION ASC",
                    (clean_table,),
                )
                cols = [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]

            col_names = [c["name"] for c in cols]

            # Validate sort column
            matched_sort = None
            if sort_col:
                for c in col_names:
                    if c.upper() == sort_col.strip().upper():
                        matched_sort = c
                        break
            if not matched_sort and col_names:
                matched_sort = col_names[0]

            # Determine string columns for text searching
            string_types = {"NVARCHAR", "VARCHAR", "ALPHANUM", "CHAR", "NCHAR", "SHORTTEXT", "TEXT", "NCLOB", "CLOB"}
            searchable_cols = [c["name"] for c in cols if str(c.get("type", "")).upper() in string_types][:10]

            where_clauses = []
            params: List[Any] = []

            if search and search.strip() and searchable_cols:
                term = f"%{search.strip().upper()}%"
                col_predicates = [f'UPPER("{c}") LIKE ?' for c in searchable_cols]
                where_clauses.append(f"({' OR '.join(col_predicates)})")
                params.extend([term] * len(searchable_cols))

            where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

            # Query total row count
            cursor.execute(f'SELECT COUNT(*) FROM "{clean_table}"')
            total_rows_res = cursor.fetchone()
            total_rows = int(total_rows_res[0]) if total_rows_res else 0

            # Query filtered row count
            if where_sql:
                cursor.execute(f'SELECT COUNT(*) FROM "{clean_table}" {where_sql}', tuple(params))
                filtered_res = cursor.fetchone()
                filtered_rows = int(filtered_res[0]) if filtered_res else 0
            else:
                filtered_rows = total_rows

            # Query page rows
            order_clause = f'ORDER BY "{matched_sort}" {sort_direction}' if matched_sort else ""
            data_sql = f'SELECT * FROM "{clean_table}" {where_sql} {order_clause} LIMIT ? OFFSET ?'
            data_params = tuple(params + [page_size, offset])
            cursor.execute(data_sql, data_params)

            desc = [d[0] for d in cursor.description] if cursor.description else col_names
            raw_rows = cursor.fetchall()

            rows_data = []
            for r in raw_rows:
                row_dict = {desc[i]: serialize_hana_value(r[i]) for i in range(len(desc))}
                rows_data.append(row_dict)

            total_pages = max(1, math.ceil(filtered_rows / page_size)) if filtered_rows > 0 else 1

            return {
                "tableName": clean_table,
                "totalRows": total_rows,
                "filteredRows": filtered_rows,
                "page": page,
                "pageSize": page_size,
                "totalPages": total_pages,
                "columns": cols,
                "rows": rows_data,
            }
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def get_database_stats(self) -> Dict[str, Any]:
        """Get SAP HANA Cloud database overview statistics."""
        conn = db_manager.get_connection()
        if not conn:
            return {"connected": False, "error": "HANA Database unavailable"}

        cursor = None
        try:
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            # Version
            hana_version = "Unknown"
            try:
                cursor.execute("SELECT VERSION FROM SYS.M_DATABASE")
                ver_row = cursor.fetchone()
                if ver_row:
                    hana_version = str(ver_row[0])
            except Exception:
                pass

            # Tables count and total records
            cursor.execute("SELECT COUNT(*) FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA")
            total_tables_row = cursor.fetchone()
            total_tables = int(total_tables_row[0]) if total_tables_row else 0

            total_records = 0
            try:
                cursor.execute("SELECT SUM(RECORD_COUNT) FROM SYS.M_TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA")
                rec_row = cursor.fetchone()
                if rec_row and rec_row[0] is not None:
                    total_records = int(rec_row[0])
            except Exception:
                pass

            return {
                "connected": True,
                "host": settings.HANA_ADDRESS,
                "port": settings.HANA_PORT,
                "schema": schema,
                "version": hana_version,
                "totalTables": total_tables,
                "totalRecords": total_records,
            }
        except Exception as e:
            logger.error(f"Error getting database stats: {e}")
            return {
                "connected": False,
                "host": settings.HANA_ADDRESS,
                "schema": settings.HANA_SCHEMA,
                "error": str(e),
            }
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def execute_read_only_query(self, sql_query: str, max_rows: int = 100) -> Dict[str, Any]:
        """
        Execute an arbitrary read-only SQL SELECT statement safely against SAP HANA Cloud.
        Blocks all write, mutate, DDL, DCL, and procedure call commands.
        """
        query_clean = sql_query.strip().rstrip(";")
        if not query_clean:
            raise ValueError("SQL query cannot be empty.")

        if ";" in query_clean:
            raise ValueError("Multiple SQL statements in a single request are not permitted.")

        first_token = query_clean.split()[0].upper()
        if first_token not in ("SELECT", "WITH"):
            raise ValueError("Only read-only SELECT and WITH statements are allowed.")

        forbidden_keywords = [
            r"\bINSERT\b", r"\bUPDATE\b", r"\bDELETE\b", r"\bDROP\b",
            r"\bALTER\b", r"\bCREATE\b", r"\bTRUNCATE\b", r"\bREPLACE\b",
            r"\bEXEC\b", r"\bCALL\b", r"\bGRANT\b", r"\bREVOKE\b",
            r"\bMERGE\b", r"\bINTO\b"
        ]
        for pattern in forbidden_keywords:
            if re.search(pattern, query_clean, flags=re.IGNORECASE):
                raise ValueError(f"Prohibited SQL operation detected matching: {pattern}")

        conn = db_manager.get_connection()
        if not conn:
            raise RuntimeError("HANA Database connection unavailable.")

        cursor = None
        max_rows = max(1, min(500, max_rows))
        try:
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            start_time = time.time()
            cursor.execute(query_clean)
            desc = [d[0] for d in cursor.description] if cursor.description else []
            fetched_rows = cursor.fetchmany(max_rows)
            elapsed_ms = round((time.time() - start_time) * 1000, 2)

            rows_data = []
            for r in fetched_rows:
                row_dict = {desc[i]: serialize_hana_value(r[i]) for i in range(len(desc))}
                rows_data.append(row_dict)

            return {
                "success": True,
                "columns": desc,
                "rows": rows_data,
                "rowCount": len(rows_data),
                "executionTimeMs": elapsed_ms,
                "truncated": len(rows_data) == max_rows,
            }
        except Exception as e:
            logger.error(f"SQL execution error for query [{query_clean[:100]}...]: {e}")
            raise e
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

    def delete_table_records_range(
        self,
        table_name: str,
        mode: str = "row_range",
        from_row: Optional[int] = None,
        to_row: Optional[int] = None,
        id_col: Optional[str] = None,
        from_id: Optional[str] = None,
        to_id: Optional[str] = None,
        condition: Optional[str] = None,
        key_values: Optional[Dict[str, List[Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Delete a specified range of records from a SAP HANA Cloud table safely with parameterized SQL.
        Supports:
        - row_range: delete rows from row N to row M (e.g. from row 1 to row 50)
        - id_range: delete rows where ID >= from_id and ID <= to_id
        - key_values: delete rows matching parameterized column values (no raw SQL injection)
        """
        clean_table = self.sanitize_identifier(table_name)
        conn = db_manager.get_connection()
        if not conn:
            raise RuntimeError("HANA Database connection unavailable.")

        cursor = None
        try:
            conn.setautocommit(False)
            cursor = conn.cursor()
            schema = settings.HANA_SCHEMA
            if schema:
                schema_id = schema.replace('"', '""')
                cursor.execute(f'SET SCHEMA "{schema_id}"')

            # Verify table exists
            cursor.execute(
                "SELECT 1 FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?",
                (clean_table,),
            )
            if not cursor.fetchone():
                raise ValueError(f"Table '{clean_table}' does not exist.")

            # Get columns to identify ID column
            cols = self.get_table_columns(clean_table)
            col_names = [c["name"] for c in cols]
            if not col_names:
                raise ValueError(f"No columns found for table '{clean_table}'.")

            target_id_col = col_names[0]
            if id_col and id_col.upper() in [c.upper() for c in col_names]:
                target_id_col = next(c for c in col_names if c.upper() == id_col.upper())
            else:
                for candidate in ["ID", "ORDERID", "SESSION_ID", "ROW_ID", "KEY", col_names[0]]:
                    matched = next((c for c in col_names if c.upper() == candidate.upper()), None)
                    if matched:
                        target_id_col = matched
                        break

            deleted_count = 0
            clean_id_col = target_id_col.replace('"', '""')

            if mode == "row_range":
                if from_row is None or to_row is None:
                    raise ValueError("Both 'fromRow' and 'toRow' must be specified for row_range mode.")
                if from_row < 1 or to_row < from_row:
                    raise ValueError(f"Invalid row range: from {from_row} to {to_row}. 'fromRow' must be >= 1 and <= 'toRow'.")

                limit = to_row - from_row + 1
                offset = from_row - 1

                delete_sql = f"""
                    DELETE FROM "{clean_table}" WHERE "{clean_id_col}" IN (
                        SELECT "{clean_id_col}" FROM "{clean_table}" ORDER BY "{clean_id_col}" ASC LIMIT ? OFFSET ?
                    )
                """
                cursor.execute(delete_sql, (limit, offset))
                deleted_count = cursor.rowcount if cursor.rowcount >= 0 else limit
                conn.commit()

            elif mode == "id_range":
                if from_id is None or to_id is None:
                    raise ValueError("Both 'fromId' and 'toId' must be specified for id_range mode.")

                delete_sql = f'DELETE FROM "{clean_table}" WHERE "{clean_id_col}" >= ? AND "{clean_id_col}" <= ?'
                cursor.execute(delete_sql, (str(from_id), str(to_id)))
                deleted_count = cursor.rowcount if cursor.rowcount >= 0 else 0
                conn.commit()

            elif mode in ("key_values", "condition"):
                where_clauses = []
                params = []
                if key_values:
                    for col_key, val_list in key_values.items():
                        matched_col = next((c for c in col_names if c.upper() == col_key.upper()), None)
                        if not matched_col:
                            raise ValueError(f"Unknown column '{col_key}' in deletion filter.")
                        clean_col = matched_col.replace('"', '""')
                        if isinstance(val_list, list) and val_list:
                            placeholders = ", ".join(["?"] * len(val_list))
                            where_clauses.append(f'"{clean_col}" IN ({placeholders})')
                            params.extend(val_list)
                        elif val_list is not None:
                            where_clauses.append(f'"{clean_col}" = ?')
                            params.append(val_list)
                elif condition:
                    # Parse simple equality condition safely (e.g. "STATUS = 'archived'" or "YEAR = 2023")
                    cond_clean = condition.strip().rstrip(";")
                    # Block any dangerous SQL keywords or comment syntax
                    if ";" in cond_clean or "--" in cond_clean or "/*" in cond_clean:
                        raise ValueError("Comments or statement terminators are not permitted in condition.")
                    m = re.match(r'^["\']?([A-Za-z0-9_]+)["\']?\s*(=|!=|>|<|>=|<=)\s*["\']?([^"\']+)["\']?$', cond_clean)
                    if not m:
                        raise ValueError("Conditions must use simple parameterized comparisons (e.g. COLUMN = VALUE) or keyValues.")
                    c_col, c_op, c_val = m.groups()
                    matched_col = next((c for c in col_names if c.upper() == c_col.upper()), None)
                    if not matched_col:
                        raise ValueError(f"Unknown column '{c_col}' in condition.")
                    clean_col = matched_col.replace('"', '""')
                    where_clauses.append(f'"{clean_col}" {c_op} ?')
                    params.append(c_val)
                else:
                    raise ValueError("Either 'keyValues' or a simple equality 'condition' must be specified.")

                if not where_clauses:
                    raise ValueError("No valid deletion criteria provided.")

                delete_sql = f'DELETE FROM "{clean_table}" WHERE {" AND ".join(where_clauses)}'
                cursor.execute(delete_sql, tuple(params))
                deleted_count = cursor.rowcount if cursor.rowcount >= 0 else 0
                conn.commit()
            else:
                raise ValueError(f"Unsupported delete mode '{mode}'. Choose 'row_range', 'id_range', or 'key_values'.")

            # Fetch updated total row count
            cursor.execute(f'SELECT COUNT(*) FROM "{clean_table}"')
            new_total = cursor.fetchone()[0]

            logger.info(f"Successfully deleted {deleted_count} rows from '{clean_table}'. New total: {new_total}.")
            return {
                "success": True,
                "tableName": clean_table,
                "deletedCount": deleted_count,
                "remainingRows": new_total,
                "message": f"Successfully deleted {deleted_count} records from table '{clean_table}'.",
            }
        except Exception as e:
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.error(f"Failed to delete records from '{clean_table}': {e}")
            raise e
        finally:
            if cursor:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)


hana_table_service = HANATableService()
