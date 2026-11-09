from typing import List, Dict, Any
import decimal
import datetime
from api.database.connection import db_manager
from api.utils.logger import get_logger

logger = get_logger("database.hana_client")

class HANAClient:
    def execute_query(self, sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
        conn = db_manager.get_connection()
        if not conn:
            logger.error("HANA Database connection is not active.")
            return []
        
        cursor = None
        try:
            cursor = conn.cursor()
            cursor.execute(sql, params)
            if cursor.description:
                columns = [col[0] for col in cursor.description]
                raw_results = cursor.fetchall()
                results = []
                for row in raw_results:
                    row_dict = {}
                    for col, val in zip(columns, row):
                        if isinstance(val, decimal.Decimal):
                            row_dict[col] = int(val) if val % 1 == 0 else float(val)
                        elif isinstance(val, (datetime.date, datetime.datetime)):
                            row_dict[col] = val.isoformat()
                        else:
                            row_dict[col] = val
                    results.append(row_dict)
            else:
                results = []
            conn.commit()
            return results
        except Exception as e:
            logger.error(f"Error executing SQL in HANA: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            raise e
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    pass
            db_manager.return_connection(conn)

hana_client = HANAClient()
