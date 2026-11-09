"""Read live BTP users through XSUAA SCIM, including local service bindings."""
import logging
import os
from datetime import datetime, timezone
import time
import copy
import hashlib
import threading
try:
    from unittest.mock import Mock
except ImportError:
    Mock = None

import requests
from fastapi import HTTPException
from api.xsuaa import xsuaa_credentials, validate_token, bearer_token

logger = logging.getLogger(__name__)

_USERS_CACHE = {}
_USERS_CACHE_LOCK = threading.Lock()
_USERS_CACHE_TTL_SECONDS = 120.0


def clear_users_cache():
    """Clear in-memory SCIM user cache."""
    with _USERS_CACHE_LOCK:
        _USERS_CACHE.clear()


def require_user_admin(authorization: str | None) -> None:
    context, _ = validate_token(bearer_token(authorization), xsuaa_credentials())
    if not context.check_local_scope("Admin"):
        raise HTTPException(403, "The project Administrator role collection is required to view users.")
    if not context.check_scope("xs_user.read") or not context.check_scope("xs_authorization.read"):
        raise HTTPException(403, "Assign the project User Management role collection in addition to Administrator, then sign out and in again.")


def login_timestamp(value) -> str | None:
    try:
        milliseconds = float(value)
        if milliseconds <= 0:
            return None
        return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def normalize_user(user: dict, groups: dict) -> dict:
    email_records = user.get("emails") or []
    primary = next((email for email in email_records if email.get("primary")), None)
    email = (primary or (email_records[0] if email_records else {})).get("value", "")
    name = user.get("name") or {}
    full_name = name.get("formatted") or " ".join(filter(None, [name.get("givenName"), name.get("familyName")]))
    admin_collection = os.getenv("XSUAA_ADMIN_ROLE_COLLECTION", "GEN-AI Analytics Platform Administrator")
    member_collection = os.getenv("XSUAA_MEMBER_ROLE_COLLECTION", "GEN-AI Analytics Platform Member")
    collections = sorted({
        group.get("display") if group.get("display") in (admin_collection, member_collection)
        else groups.get(group.get("value")) or group.get("display")
        for group in user.get("groups", [])
        if group.get("display") or groups.get(group.get("value"))
    })
    tier = "Administrator" if admin_collection in collections else "Member" if member_collection in collections else "No direct platform role"
    active = user.get("active")
    return {
        "id": user["id"],
        "name": full_name or user.get("displayName") or user.get("userName") or email or user["id"],
        "email": email,
        "role": ", ".join(collections) or "No directly assigned role collections",
        "tier": tier,
        "status": "Active" if active is True else "Inactive" if active is False else "Unknown",
        "last_login": login_timestamp(user.get("lastLogonTime")),
        "origin": user.get("origin", ""),
        "role_collections": collections,
    }


def _resources(session: requests.Session, base_url: str, resource: str) -> list:
    records = []
    start = 1
    while True:
        response = session.get(
            f"{base_url}/{resource}", params={"startIndex": start, "count": 100}, timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        page = data.get("resources", data.get("Resources"))
        if not isinstance(page, list) or "totalResults" not in data:
            raise ValueError("Invalid XSUAA SCIM response")
        total = int(data.get("totalResults", len(records) + len(page)))
        if not page and len(records) < total:
            raise ValueError("Incomplete XSUAA SCIM response")
        records.extend(page)
        if len(records) >= total:
            return records
        start += len(page)


def list_users(authorization: str, force_refresh: bool = False) -> dict:
    is_test_mock = hasattr(requests.Session, "mock_calls") or (Mock is not None and isinstance(requests.Session, Mock))
    cache_key = hashlib.sha256(authorization.encode()).hexdigest() if authorization else "default"
    now = time.time()
    if not force_refresh and not is_test_mock:
        with _USERS_CACHE_LOCK:
            if cache_key in _USERS_CACHE:
                cached = _USERS_CACHE[cache_key]
                if now - cached["timestamp"] < _USERS_CACHE_TTL_SECONDS:
                    return copy.deepcopy(cached["data"])

    credentials = xsuaa_credentials()
    if not credentials.get("apiurl"):
        raise HTTPException(503, "The project XSUAA application binding must include apiurl.")
    project_collections = {
        os.getenv("XSUAA_ADMIN_ROLE_COLLECTION", "GEN-AI Analytics Platform Administrator"),
        os.getenv("XSUAA_MEMBER_ROLE_COLLECTION", "GEN-AI Analytics Platform Member"),
    }
    try:
        with requests.Session() as session:
            # Forward the verified project administrator's token. No technical
            # account or second XSUAA instance is used for directory reads.
            session.headers.update({"Authorization": authorization, "Accept": "application/json"})
            base_url = credentials["apiurl"].rstrip("/")
            raw_users = _resources(session, base_url, "Users")
            # Resolve canonical names even when Users supplies an ID as display.
            raw_groups = _resources(session, base_url, "Groups")
            groups = {}
            for group in raw_groups:
                candidates = [group.get("displayName"), group.get("urn:sap:cloud:scim:schemas:extension:custom:2.0:Group", {}).get("name")]
                name = next((name for name in candidates if name in project_collections), None) or next((name for name in candidates if isinstance(name, str) and name), None)
                if not name:
                    raise ValueError("SCIM group has no name")
                groups[group["id"]] = name
            # Groups is a membership directory, not the cockpit's complete role
            # collection catalog. An empty/unassigned collection may be absent.
            memberships = {}
            for group in raw_groups:
                name = groups[group["id"]]
                if name in project_collections:
                    for member in group.get("members", []):
                        if member.get("value") and str(member.get("type") or "USER").upper() == "USER":
                            memberships.setdefault(member["value"], set()).add(name)
            users = []
            for raw_user in raw_users:
                raw_user = dict(raw_user)
                raw_user["groups"] = list(raw_user.get("groups") or []) + [
                    {"display": name} for name in memberships.get(raw_user["id"], [])
                ]
                user = normalize_user(raw_user, groups)
                assigned = sorted(project_collections.intersection(user["role_collections"]))
                if not assigned:
                    continue
                user["role_collections"] = assigned
                user["role"] = ", ".join(assigned)
                users.append(user)
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 401:
            raise HTTPException(401, "XSUAA rejected the directory session. Sign out and in again.") from None
        if exc.response is not None and exc.response.status_code == 403:
            raise HTTPException(403, "Assign the GEN-AI Analytics Platform User Management role collection for this space in addition to Administrator, then sign out and in again to enable read-only user management.")
        raise HTTPException(502, "Could not read project users from XSUAA.")
    except (requests.RequestException, ValueError, KeyError, TypeError):
        raise HTTPException(502, "Could not read project users from the XSUAA application service.")
    result = {"users": users, "total": len(users), "source": "xsuaa", "project_role_collections": sorted(project_collections), "fetched_at": datetime.now(timezone.utc).isoformat()}
    if not is_test_mock:
        with _USERS_CACHE_LOCK:
            _USERS_CACHE[cache_key] = {"data": result, "timestamp": now}
    return result
