"""Track and persist user logins and active sessions specifically for this project (GEN-AI Analytics Platform)."""
import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_LOGINS_LOCK = threading.Lock()
_LOGINS_CACHE: dict[str, str] = {}
_ACTIVE_SESSIONS: set[str] = set()
_INITIALIZED = False

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOCAL_FILE = DATA_DIR / "project_user_logins.json"
ACTIVE_FILE = DATA_DIR / "active_project_sessions.json"
NAMESPACE = "project_user_logins"


def _load_local_file() -> dict[str, str]:
    try:
        if LOCAL_FILE.exists():
            return json.loads(LOCAL_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Could not read local project logins file: %s", exc)
    return {}


def _save_local_file(data: dict[str, str]) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        LOCAL_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not write local project logins file: %s", exc)


def _load_active_file() -> set[str]:
    try:
        if ACTIVE_FILE.exists():
            return set(json.loads(ACTIVE_FILE.read_text(encoding="utf-8")))
    except Exception as exc:
        logger.warning("Could not read active project sessions file: %s", exc)
    return set()


def _save_active_file(active_set: set[str]) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        ACTIVE_FILE.write_text(json.dumps(sorted(list(active_set)), indent=2), encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not write active project sessions file: %s", exc)


def _init_cache_if_needed():
    global _INITIALIZED, _LOGINS_CACHE, _ACTIVE_SESSIONS
    if _INITIALIZED:
        return
    with _LOGINS_LOCK:
        if _INITIALIZED:
            return
        merged = _load_local_file()
        _ACTIVE_SESSIONS = _load_active_file()

        try:
            from api.platform.store import metadata_store
            store = metadata_store()
            docs = store.list(NAMESPACE)
            for doc in docs:
                val = doc.get("value") or {}
                login_time = val.get("last_login")
                doc_id = doc.get("id")
                if doc_id and login_time:
                    merged[doc_id] = login_time
        except Exception as exc:
            logger.debug("Could not load project logins from MetadataStore: %s", exc)

        _LOGINS_CACHE = merged
        _INITIALIZED = True


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
        _save_local_file(_LOGINS_CACHE)
        _save_active_file(_ACTIVE_SESSIONS)

    # Invalidate cached user list so the updated status is reflected immediately
    try:
        from api.services.xsuaa_users_service import clear_users_cache
        clear_users_cache()
    except Exception:
        pass

    def _persist_remote():
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
        _save_active_file(_ACTIVE_SESSIONS)

    # Invalidate cached user list so the updated status is reflected immediately
    try:
        from api.services.xsuaa_users_service import clear_users_cache
        clear_users_cache()
    except Exception:
        pass

    def _persist_remote_logout():
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
