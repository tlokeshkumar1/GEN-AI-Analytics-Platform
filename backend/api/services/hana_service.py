from api.database.hana_client import hana_client
from api.utils.logger import get_logger

logger = get_logger("services.hana_service")

class HANAService:
    def execute_query(self, sql: str, params: tuple = ()):
        return hana_client.execute_query(sql, params)

hana_service = HANAService()
