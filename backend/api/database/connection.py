import logging
import queue
import threading
from typing import Optional
from api.config import settings
from api.utils.logger import get_logger

logger = get_logger("database.connection")

try:
    from hdbcli import dbapi
    HDBCLI_AVAILABLE = True
except ImportError:
    HDBCLI_AVAILABLE = False
    logger.warning("hdbcli module not available. SAP HANA database integration is disabled.")


class HANAConnectionManager:
    def __init__(self):
        self.address = settings.HANA_ADDRESS
        self.port = settings.HANA_PORT
        self.user = settings.HANA_USER
        self.password = settings.HANA_PASSWORD
        self.schema = settings.HANA_SCHEMA
        self._max_pool_size = settings.HANA_POOL_SIZE
        if self._max_pool_size <= 0:
            raise ValueError(f"HANA_POOL_SIZE must be greater than 0, got {self._max_pool_size}")
        self._pool_timeout = getattr(settings, "HANA_POOL_TIMEOUT", 30.0)
        self._pool = queue.Queue(maxsize=self._max_pool_size)
        self._semaphore = threading.BoundedSemaphore(self._max_pool_size)

    def _create_connection(self):
        conn = None
        try:
            conn = dbapi.connect(
                address=self.address,
                port=self.port,
                user=self.user,
                password=self.password,
                encrypt="true",
                sslValidateCertificate="true" if settings.HANA_VALIDATE_CERT else "false"
            )
            if self.schema:
                cursor = conn.cursor()
                try:
                    schema_identifier = self.schema.replace('"', '""')
                    cursor.execute(f'SET SCHEMA "{schema_identifier}"')
                finally:
                    cursor.close()
            return conn
        except Exception as e:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            logger.error("Failed to connect to the configured SAP HANA schema (%s).", type(e).__name__)
            return None

    def get_connection(self, timeout: Optional[float] = None):
        """
        Get a connection from the pool or create a new one, strictly capping
        the total number of live (idle + active) connections at HANA_POOL_SIZE.
        If all connections are in use, waits up to timeout (default HANA_POOL_TIMEOUT) seconds.
        """
        if not HDBCLI_AVAILABLE:
            return None

        wait_time = self._pool_timeout if timeout is None else timeout
        acquired = self._semaphore.acquire(timeout=wait_time)
        if not acquired:
            logger.error(
                "HANA connection pool capacity reached (%d live connections). "
                "Timed out after %.1fs waiting for an available connection.",
                self._max_pool_size,
                wait_time,
            )
            return None

        # Try to get an existing healthy connection from the pool
        while True:
            try:
                conn = self._pool.get_nowait()
            except queue.Empty:
                conn = None

            if conn is not None:
                try:
                    cursor = conn.cursor()
                    cursor.execute("SELECT 1 FROM DUMMY")
                    cursor.close()
                    return conn
                except Exception:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    continue

            # Pool is empty; create a new connection using the reserved capacity permit
            conn = self._create_connection()
            if conn is None:
                try:
                    self._semaphore.release()
                except ValueError:
                    pass
                return None
            return conn

    def return_connection(self, conn):
        """Return a connection to the pool and release a live connection slot."""
        if not conn:
            return
        try:
            try:
                self._pool.put_nowait(conn)
            except queue.Full:
                try:
                    conn.close()
                except Exception:
                    pass
        finally:
            try:
                self._semaphore.release()
            except ValueError:
                pass

    def is_connected(self) -> bool:
        conn = self.get_connection(timeout=5.0)
        if conn:
            self.return_connection(conn)
            return True
        return False


db_manager = HANAConnectionManager()

