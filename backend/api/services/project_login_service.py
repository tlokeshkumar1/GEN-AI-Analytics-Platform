"""Track and persist user logins and active sessions specifically for this project (GEN-AI Analytics Platform).

Persistence architecture:
100% Cloud-Native: SAP HANA Cloud `DATASETS_METADATA` table using
reserved system dataset id `__project_sessions__` and `PLATFORM_METADATA` store.
Zero local disk dependencies or file creation.
"""
import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Tuple

logger = logging.getLogger(__name__)

_LOGINS_LOCK = threading.Lock()
_LOGINS_CACHE: dict[str, str] = {}
_ACTIVE_SESSIONS: set[str] = set()
_INITIALIZED = False

NAMESPACE = "project_user_logins"
HANA_SYSTEM_DATASET_ID = "__project_sessions__"


def _load_from_hana() -> Tuple[dict[str, str], set[str]]:
    """Load logins and active sessions from SAP HANA Cloud DATASETS_METADATA."""
    try:
        from api.database.hana_client import hana_client
        if not hana_client:
            return {}, set()

        workspace_id = os.getenv("PLATFORM_WORKSPACE_ID", "default")
        sql = """
            SELECT METADATA_JSON
            FROM DATASETS_METADATA
            WHERE WORKSPACE_ID = ? AND DATASET_ID = ?
        """
        rows = hana_client.execute_query(sql, (workspace_id, HANA_SYSTEM_DATASET_ID))
        if rows and rows[0].get("METADATA_JSON"):
            meta_raw = rows[0]["METADATA_JSON"]
            meta = json.loads(meta_raw) if isinstance(meta_raw, str) else (meta_raw or {})
            logins = meta.get("logins") or {}
            active = set(meta.get("active_sessions") or [])
            logger.info(
                f"[Cloud Persistence] Loaded {len(logins)} logins and {len(active)} active sessions "
                f"from HANA DATASETS_METADATA ({HANA_SYSTEM_DATASET_ID})"
            )
            return logins, active
    except Exception as exc:
        logger.debug(f"[Cloud Persistence] Could not load from HANA DATASETS_METADATA: {exc}")
    return {}, set()


def _save_to_hana(logins: dict[str, str], active_sessions: set[str]) -> bool:
    """Persist logins and active sessions directly into SAP HANA Cloud DATASETS_METADATA."""
    try:
        from api.database.hana_client import hana_client
        if not hana_client:
            return False

        workspace_id = os.getenv("PLATFORM_WORKSPACE_ID", "default")
        payload = json.dumps({
            "logins": logins,
            "active_sessions": sorted(list(active_sessions)),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False)

        sql = """
            UPSERT DATASETS_METADATA (
                WORKSPACE_ID, DATASET_ID, NAME, FOLDER, CURRENT_VERSION,
                IS_ACTIVE, OWNER_ID, VERSIONS_JSON, METADATA_JSON, UPDATED_AT
            ) VALUES (?, ?, 'Project Session & Login Tracking', '__system__', 1, FALSE, 'SYSTEM', '[]', ?, CURRENT_TIMESTAMP)
            WITH PRIMARY KEY
        """
        hana_client.execute_query(sql, (workspace_id, HANA_SYSTEM_DATASET_ID, payload))
        return True
    except Exception as exc:
        logger.warning(f"[Cloud Persistence] Could not save to HANA DATASETS_METADATA: {exc}")
        return False


def _init_cache_if_needed():
    global _INITIALIZED, _LOGINS_CACHE, _ACTIVE_SESSIONS
    if _INITIALIZED:
        return
    with _LOGINS_LOCK:
        if _INITIALIZED:
            return

        # 1. Primary: Load from SAP HANA Cloud DATASETS_METADATA
        cloud_logins, cloud_active = _load_from_hana()
        merged_logins: dict[str, str] = dict(cloud_logins)
        merged_active: set[str] = set(cloud_active)

        # 2. Supplemental PLATFORM_METADATA check
        try:
            from api.platform.store import metadata_store
            store = metadata_store()
            docs = store.list(NAMESPACE)
            for doc in docs:
                val = doc.get("value") or {}
                login_time = val.get("last_login")
                doc_id = doc.get("id")
                if doc_id and login_time and doc_id not in merged_logins:
                    merged_logins[doc_id] = login_time
                if doc_id and val.get("is_active"):
                    merged_active.add(doc_id)
        except Exception as exc:
            logger.debug("Could not load project logins from MetadataStore: %s", exc)

        _LOGINS_CACHE = merged_logins
        _ACTIVE_SESSIONS = merged_active
        _INITIALIZED = True

        # If HANA was initially empty but metadata_store had records, persist to HANA
        if not cloud_logins and merged_logins:
            _save_to_hana(_LOGINS_CACHE, _ACTIVE_SESSIONS)


def record_project_login(user_id: str | None = None, email: str | None = None) -> str:
    """Record that a user has logged into THIS project right now and activate their session."""
    now_iso = datetime.now(timezone.utc).isoformat()
    _init_cache_if_needed()

    keys = []
    if user_id and str(user_id).strip():
        keys.append(str(user_id).strip())
    if email and str(email).strip():
        clean_email = str(email).strip().lower()
        keys.append(clean_email)

    if not keys:
        return now_iso

    with _LOGINS_LOCK:
        for key in keys:
            _LOGINS_CACHE[key] = now_iso
            _ACTIVE_SESSIONS.add(key)
        snapshot_logins = dict(_LOGINS_CACHE)
        snapshot_active = set(_ACTIVE_SESSIONS)

    # Invalidate cached user list so the updated status is reflected immediately
    try:
        from api.services.xsuaa_users_service import clear_users_cache
        clear_users_cache()
    except Exception:
        pass

    def _persist_remote():
        # Persist directly to SAP HANA Cloud DATASETS_METADATA
        _save_to_hana(snapshot_logins, snapshot_active)

        # Also persist to PLATFORM_METADATA store for backwards compatibility
        try:
            from api.platform.store import metadata_store
            store = metadata_store()
            for key in keys:
                existing = store.get(NAMESPACE, key)
                rev = existing.get("revision", 0) if existing else 0
                store.put(
                    NAMESPACE,
                    key,
                    {"last_login": now_iso, "user_id": user_id, "email": email, "is_active": True},
                    expected_revision=rev,
                )
        except Exception as exc:
            logger.debug("Could not persist login to MetadataStore: %s", exc)

    threading.Thread(target=_persist_remote, daemon=True).start()
    return now_iso


def record_project_logout(user_id: str | None = None, email: str | None = None) -> None:
    """Record that a user has logged out of THIS project, terminating their active session."""
    _init_cache_if_needed()

    keys = []
    if user_id and str(user_id).strip():
        keys.append(str(user_id).strip())
    if email and str(email).strip():
        clean_email = str(email).strip().lower()
        keys.append(clean_email)

    if not keys:
        return

    with _LOGINS_LOCK:
        for key in keys:
            _ACTIVE_SESSIONS.discard(key)
        snapshot_logins = dict(_LOGINS_CACHE)
        snapshot_active = set(_ACTIVE_SESSIONS)

    # Invalidate cached user list so the updated status is reflected immediately
    try:
        from api.services.xsuaa_users_service import clear_users_cache
        clear_users_cache()
    except Exception:
        pass

    def _persist_remote_logout():
        # Persist to SAP HANA Cloud DATASETS_METADATA
        _save_to_hana(snapshot_logins, snapshot_active)

        # Also persist to PLATFORM_METADATA
        try:
            from api.platform.store import metadata_store
            store = metadata_store()
            for key in keys:
                existing = store.get(NAMESPACE, key)
                if existing and existing.get("value"):
                    val = dict(existing["value"])
                    val["is_active"] = False
                    val["last_logout"] = datetime.now(timezone.utc).isoformat()
                    store.put(NAMESPACE, key, val, expected_revision=existing.get("revision", 0))
        except Exception as exc:
            logger.debug("Could not persist logout to MetadataStore: %s", exc)

    threading.Thread(target=_persist_remote_logout, daemon=True).start()


def is_user_active_session(user_id: str | None = None, email: str | None = None) -> bool:
    """Check if the user currently has an active project session (has logged in and not logged out)."""
    _init_cache_if_needed()
    with _LOGINS_LOCK:
        if user_id and str(user_id).strip() in _ACTIVE_SESSIONS:
            return True
        if email and str(email).strip().lower() in _ACTIVE_SESSIONS:
            return True
    return False


def get_all_active_sessions() -> set[str]:
    """Return all currently active user IDs and emails."""
    _init_cache_if_needed()
    with _LOGINS_LOCK:
        return set(_ACTIVE_SESSIONS)


def get_all_project_logins() -> dict[str, str]:
    """Return a dictionary of all recorded project logins {user_id_or_email: iso_timestamp}."""
    _init_cache_if_needed()
    with _LOGINS_LOCK:
        return dict(_LOGINS_CACHE)


def get_project_last_login(user_id: str | None = None, email: str | None = None) -> str | None:
    """Retrieve the project-specific last login timestamp for a user, or None if never logged into this project."""
    _init_cache_if_needed()
    with _LOGINS_LOCK:
        if user_id and str(user_id).strip() in _LOGINS_CACHE:
            return _LOGINS_CACHE[str(user_id).strip()]
        if email and str(email).strip().lower() in _LOGINS_CACHE:
            return _LOGINS_CACHE[str(email).strip().lower()]
    return None
