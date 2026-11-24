"""Private HANA schema on the platform HANA Cloud instance."""

import json
import os
from functools import lru_cache

from fastapi import HTTPException
from api.config import settings
from api.database.connection import HANAConnectionManager, db_manager
from api.platform.store import MetadataStore


class PersonalStore(MetadataStore):
    def __init__(self, pool):
        super().__init__(backend="hana")
        self.pool = pool

    def connection_pool(self):
        return self.pool


@lru_cache(maxsize=1)
def personal_store():
    service_name = os.getenv("CONTENT_HANA_SERVICE_NAME", "analytics-content-hana")
    try:
        bindings = json.loads(os.getenv("VCAP_SERVICES") or "{}")
        matches = [
            b
            for services in bindings.values()
            for b in services
            if b.get("name") == service_name
        ]
        if len(matches) != 1:
            raise ValueError
        credentials = matches[0]["credentials"]
        user, password, schema = (
            credentials[key] for key in ("user", "password", "schema")
        )
        if not all(isinstance(v, str) and v.strip() for v in (user, password, schema)):
            raise ValueError
        if (
            not settings.HANA_ADDRESS
            or user.upper() == (settings.HANA_USER or "").upper()
            or schema.upper() == (settings.HANA_SCHEMA or "").upper()
        ):
            raise ValueError
        if credentials.get("host", settings.HANA_ADDRESS) != settings.HANA_ADDRESS:
            raise ValueError
    except (KeyError, ValueError, AttributeError, TypeError):
        raise HTTPException(
            503, "Configure the private My Files HANA Cloud service binding."
        ) from None
    verify_sql_console_isolation(schema)
    return PersonalStore(
        HANAConnectionManager(user=user, password=password, schema=schema)
    )


def verify_sql_console_isolation(schema):
    """The general-purpose SQL console must lack access to private payloads."""
    conn = db_manager.get_connection()
    if conn is None:
        raise HTTPException(503, "Cannot verify private schema isolation.")
    cursor = None
    try:
        cursor = conn.cursor()
        identifier = schema.replace('"', '""')
        cursor.execute(
            f'SELECT TOP 0 "PAYLOAD" FROM "{identifier}"."PLATFORM_DOCUMENTS"'
        )
    except Exception as exc:
        # HANA can conceal inaccessible objects as unknown tables.
        if getattr(exc, "errorcode", None) in (258, 259):
            return
        raise HTTPException(503, "Cannot verify private schema isolation.") from None
    finally:
        if cursor:
            cursor.close()
        db_manager.return_connection(conn)
    raise HTTPException(
        503,
        "Remove the platform SQL console account's access to the private content schema.",
    )
