"""Unit tests for HANAConnectionManager connection pooling and capacity limits."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.config import Settings
import api.database.connection as conn_module
from api.database.connection import HANAConnectionManager


class HANAConnectionManagerTests(unittest.TestCase):
    def test_settings_rejects_nonpositive_pool_size(self):
        """HANA_POOL_SIZE must be greater than 0 in Settings."""
        with self.assertRaises(ValueError):
            Settings(HANA_POOL_SIZE=0)
        with self.assertRaises(ValueError):
            Settings(HANA_POOL_SIZE=-5)

    def test_manager_rejects_nonpositive_pool_size(self):
        """HANAConnectionManager must reject nonpositive pool size."""
        with patch.object(conn_module.settings, "HANA_POOL_SIZE", 0):
            with self.assertRaises(ValueError):
                HANAConnectionManager()

    def test_live_connections_limited_to_pool_size(self):
        """Live connections in use cannot exceed HANA_POOL_SIZE."""
        with patch.object(conn_module.settings, "HANA_POOL_SIZE", 2), \
             patch.object(conn_module, "HDBCLI_AVAILABLE", True):
            manager = HANAConnectionManager()

            # Mock _create_connection to return distinct mock connections
            created_conns = []
            def fake_create():
                c = MagicMock()
                cursor = MagicMock()
                c.cursor.return_value = cursor
                created_conns.append(c)
                return c

            manager._create_connection = fake_create

            # Acquire first 2 connections
            c1 = manager.get_connection(timeout=0.1)
            c2 = manager.get_connection(timeout=0.1)
            self.assertIsNotNone(c1)
            self.assertIsNotNone(c2)
            self.assertEqual(len(created_conns), 2)

            # 3rd request should hit limit and time out (return None)
            c3 = manager.get_connection(timeout=0.1)
            self.assertIsNone(c3)
            self.assertEqual(len(created_conns), 2)  # No 3rd connection created!

            # Return c1
            manager.return_connection(c1)

            # Now 3rd request should succeed by reusing c1 from pool
            c3 = manager.get_connection(timeout=0.5)
            self.assertIs(c3, c1)
            self.assertEqual(len(created_conns), 2)  # Still only 2 created

            manager.return_connection(c2)
            manager.return_connection(c3)

    def test_failed_connection_creation_releases_capacity_permit(self):
        """If _create_connection fails, the reserved permit is released immediately."""
        with patch.object(conn_module.settings, "HANA_POOL_SIZE", 1), \
             patch.object(conn_module, "HDBCLI_AVAILABLE", True):
            manager = HANAConnectionManager()

            # First create fails
            manager._create_connection = MagicMock(return_value=None)
            conn = manager.get_connection(timeout=0.1)
            self.assertIsNone(conn)

            # Capacity must NOT be leaked: next attempt can still try
            mock_conn = MagicMock()
            manager._create_connection = MagicMock(return_value=mock_conn)
            conn2 = manager.get_connection(timeout=0.1)
            self.assertIs(conn2, mock_conn)
            manager.return_connection(conn2)


if __name__ == "__main__":
    unittest.main()
