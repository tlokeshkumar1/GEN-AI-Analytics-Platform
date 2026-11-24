"""Read live BTP users through XSUAA SCIM, including local service bindings."""

import copy
import logging
import os
import threading
import time
import math
from datetime import datetime, timezone

import requests
from fastapi import HTTPException
from api.xsuaa import xsuaa_credentials, validate_token, bearer_token
from api.services.project_login_service import (
    record_project_login,
    get_all_project_logins,
    get_project_last_login,
    get_all_active_sessions,
)

logger = logging.getLogger(__name__)

_USERS_CACHE = {}
_USERS_CACHE_LOCK = threading.Lock()
_USERS_CACHE_TTL_SECONDS = 300.0

PRIMARY_ADMIN_ROLE = "GEN-AI Analytics Platform Administrator (dev)"
PRIMARY_MEMBER_ROLE = "GEN-AI Analytics Platform Member (dev)"


def clear_users_cache():
    """Clear in-memory SCIM user cache."""
    with _USERS_CACHE_LOCK:
        _USERS_CACHE.clear()


def get_project_role_collections() -> tuple[set[str], set[str], set[str]]:
    """Return recognized role collection names for Administrator, Member, and all project roles."""
    admin_env = os.getenv("XSUAA_ADMIN_ROLE_COLLECTION", "").strip()
    member_env = os.getenv("XSUAA_MEMBER_ROLE_COLLECTION", "").strip()

    admin_collections = {
        PRIMARY_ADMIN_ROLE,
        "GEN-AI Analytics Platform Administrator",
        admin_env,
    } - {""}

    member_collections = {
        PRIMARY_MEMBER_ROLE,
        "GEN-AI Analytics Platform Member",
        member_env,
    } - {""}

    all_project = admin_collections | member_collections
    return admin_collections, member_collections, all_project


def require_user_admin(authorization: str | None) -> None:
    context, claims = validate_token(bearer_token(authorization), xsuaa_credentials())
    if not context.check_local_scope("Admin"):
        raise HTTPException(
            403, "The project Administrator role collection is required to view users."
        )
    if not context.check_scope("xs_user.read") or not context.check_scope(
        "xs_authorization.read"
    ):
        raise HTTPException(
            403,
            "Assign the 'GEN-AI Analytics Platform User Management (dev)' role collection in addition to Administrator in SAP BTP Cockpit, then sign out and sign in again.",
        )
    # Track the active administrator's project session
    caller_id = claims.get("user_id") or claims.get("user_name") or claims.get("sub")
    caller_email = claims.get("email")
    if caller_id or caller_email:
        record_project_login(user_id=caller_id, email=caller_email)


def normalize_user(
    user: dict,
    groups: dict,
    project_logins: dict | None = None,
    active_sessions: set[str] | None = None,
) -> dict:
    email_records = user.get("emails") or []
    primary = next((email for email in email_records if email.get("primary")), None)
    email = (primary or (email_records[0] if email_records else {})).get("value", "")
    name = user.get("name") or {}
    full_name = name.get("formatted") or " ".join(
        filter(None, [name.get("givenName"), name.get("familyName")])
    )

    admin_collections, member_collections, project_collections = (
        get_project_role_collections()
    )

    # STRICT: Only include role collections that belong to the project roles
    assigned_groups = set()
    for group in user.get("groups", []):
        display = group.get("display")
        val = group.get("value")
        resolved = display if display in project_collections else groups.get(val)
        if resolved and resolved in project_collections:
            assigned_groups.add(resolved)

    collections = sorted(assigned_groups)
    is_admin = bool(set(collections).intersection(admin_collections))
    is_member = bool(set(collections).intersection(member_collections))
    tier = (
        "Administrator"
        if is_admin
        else ("Member" if is_member else "No direct platform role")
    )
    active = user.get("active")

    user_id = str(user.get("id", "")).strip()
    clean_email = str(email).strip().lower()

    # API callers supply project session maps explicitly. Standalone SCIM
    # normalization must be pure and must not read unrelated process caches.
    project_last_login = None
    if project_logins is not None:
        project_last_login = project_logins.get(user_id) or project_logins.get(
            clean_email
        )
    else:
        project_last_login = login_timestamp(user.get("lastLogonTime"))

    # Active session check: User is Active in this project ONLY if enabled in BTP AND currently in an active session (not logged out)
    is_currently_active = False
    if active is not False:
        if active_sessions is not None:
            is_currently_active = bool(
                user_id in active_sessions or clean_email in active_sessions
            )
        else:
            is_currently_active = active is True

    project_status = "Active" if is_currently_active else "Inactive"
    if active_sessions is None and active is None:
        project_status = "Unknown"

    return {
        "id": user_id,
        "name": full_name
        or user.get("displayName")
        or user.get("userName")
        or email
        or user_id,
        "email": email,
        "role": ", ".join(collections) or "No directly assigned role collections",
        "tier": tier,
        "status": project_status,
        "last_login": project_last_login,
        "origin": user.get("origin", ""),
        "role_collections": collections,
    }


def login_timestamp(value) -> str | None:
    """Normalize SCIM seconds/milliseconds without inventing unknown login times."""
    if value is None or isinstance(value, bool):
        return None
    try:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, str) and not value.replace(".", "", 1).isdigit():
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            timestamp = float(value)
            if not math.isfinite(timestamp) or timestamp <= 0:
                return None
            if timestamp >= 10**11:
                timestamp /= 1000
            parsed = datetime.fromtimestamp(timestamp, timezone.utc)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _resources(session: requests.Session, base_url: str, resource: str) -> list:
    records = []
    start = 1
    while True:
        response = session.get(
            f"{base_url}/{resource}",
            params={"startIndex": start, "count": 100},
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict) or not ({"resources", "Resources"} & data.keys()):
            raise ValueError("Directory response is missing its resources collection")
        page = data.get("resources", data.get("Resources"))
        if not isinstance(page, list) or any(
            not isinstance(record, dict) for record in page
        ):
            raise ValueError(
                "Directory response contains an invalid resources collection"
            )
        records.extend(page)
        total = int(data.get("totalResults", len(records)))
        if total < len(records):
            raise ValueError("Directory response contains an inconsistent totalResults")
        if len(records) >= total:
            return records
        if not page:
            raise ValueError(
                "Directory pagination ended before all records were returned"
            )
        start += len(page)


def list_users(authorization: str, force_refresh: bool = False) -> dict:
    raw_auth = (
        bearer_token(authorization)
        if "bearer " in (authorization or "").lower()
        else (authorization or "")
    )
    admin_collections, member_collections, project_collections = (
        get_project_role_collections()
    )

    # Handle local development token bypass
    if raw_auth.startswith("dev-token-"):
        from urllib.parse import unquote

        parts = raw_auth.split(":")
        dev_email = (
            unquote(parts[1])
            if len(parts) > 1
            else os.getenv("DEV_AUTH_EMAIL", "dev-admin@localhost")
        )
        dev_name = (
            unquote(parts[2])
            if len(parts) > 2
            else os.getenv("DEV_AUTH_NAME", "Local Dev Admin")
        )
        dev_id = parts[3] if len(parts) > 3 else "dev-admin-user"
        dev_login_time = get_project_last_login(
            dev_id, dev_email
        ) or record_project_login(dev_id, dev_email)
        local_user = {
            "id": dev_id,
            "name": dev_name,
            "email": dev_email,
            "role": PRIMARY_ADMIN_ROLE,
            "tier": "Administrator",
            "status": "Active",
            "last_login": dev_login_time,
            "origin": "local-dev",
            "role_collections": [PRIMARY_ADMIN_ROLE],
        }
        return {
            "users": [local_user],
            "total": 1,
            "source": "xsuaa",
            "project_role_collections": [PRIMARY_ADMIN_ROLE, PRIMARY_MEMBER_ROLE],
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

    credentials = xsuaa_credentials()
    if not credentials.get("apiurl"):
        raise HTTPException(
            503, "The project XSUAA application binding must include apiurl."
        )

    cache_key = (
        credentials.get("identityzoneid")
        or credentials.get("url")
        or credentials.get("apiurl"),
        credentials.get("clientid"),
        tuple(sorted(project_collections)),
    )
    now = time.time()
    if not force_refresh:
        with _USERS_CACHE_LOCK:
            if cache_key in _USERS_CACHE:
                cached = _USERS_CACHE[cache_key]
                if now - cached["timestamp"] < _USERS_CACHE_TTL_SECONDS:
                    return copy.deepcopy(cached["data"])

    # Load recorded project logins and active sessions
    project_logins = get_all_project_logins()
    active_sessions = get_all_active_sessions()

    try:
        base_url = credentials["apiurl"].rstrip("/")
        auth_header = (
            authorization
            if (authorization or "").lower().startswith("bearer ")
            else f"Bearer {authorization}"
        )

        with requests.Session() as session:
            session.headers.update(
                {"Authorization": auth_header, "Accept": "application/json"}
            )
            raw_users = _resources(session, base_url, "Users")
            raw_groups = _resources(session, base_url, "Groups")

        # Map ONLY groups that correspond to the project role collections
        groups = {}
        for group in raw_groups:
            candidates = [
                group.get("displayName"),
                group.get(
                    "urn:sap:cloud:scim:schemas:extension:custom:2.0:Group", {}
                ).get("name"),
            ]
            name = next((n for n in candidates if n and n in project_collections), None)
            if name:
                groups[group["id"]] = name

        # Collect user assignments for project roles
        memberships = {}
        for group in raw_groups:
            grp_id = group.get("id")
            name = groups.get(grp_id)
            if name and name in project_collections:
                for member in group.get("members", []):
                    if (
                        member.get("value")
                        and str(member.get("type") or "USER").upper() == "USER"
                    ):
                        memberships.setdefault(member["value"], set()).add(name)

        deduped_users: dict[str, dict] = {}
        for raw_user in raw_users:
            raw_user = dict(raw_user)
            user_id = raw_user.get("id")
            extra_groups = [{"display": name} for name in memberships.get(user_id, [])]
            raw_user["groups"] = list(raw_user.get("groups") or []) + extra_groups
            user = normalize_user(
                raw_user,
                groups,
                project_logins=project_logins,
                active_sessions=active_sessions,
            )

            # STRICT: Show ONLY users who have GEN-AI Analytics Platform Administrator (dev) or GEN-AI Analytics Platform Member (dev)
            assigned = sorted(
                project_collections.intersection(user["role_collections"])
            )
            if not assigned:
                continue

            user["role_collections"] = assigned
            user["role"] = ", ".join(assigned)

            # Deduplicate users by primary email (or user ID)
            dedup_key = (user.get("email") or "").strip().lower() or user["id"]
            if dedup_key not in deduped_users:
                deduped_users[dedup_key] = user
            else:
                existing = deduped_users[dedup_key]
                merged_roles = sorted(
                    set(existing["role_collections"]) | set(user["role_collections"])
                )
                existing["role_collections"] = merged_roles
                existing["role"] = ", ".join(merged_roles)
                if user["status"] == "Active":
                    existing["status"] = "Active"
                if user.get("last_login") and (
                    not existing.get("last_login")
                    or user["last_login"] > existing["last_login"]
                ):
                    existing["last_login"] = user["last_login"]
                if user.get("tier") == "Administrator":
                    existing["tier"] = "Administrator"

        users = list(deduped_users.values())

    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 401:
            raise HTTPException(
                401,
                "SAP XSUAA directory session expired. Please sign out and sign in again.",
            ) from None
        if exc.response is not None and exc.response.status_code == 403:
            raise HTTPException(
                403,
                "Assign the 'GEN-AI Analytics Platform User Management (dev)' role collection to your user in SAP BTP Cockpit to enable directory reading, then sign out and sign in again.",
            ) from None
        raise HTTPException(
            502,
            f"Could not read project users from XSUAA (HTTP {exc.response.status_code if exc.response is not None else 'error'}).",
        )
    except (requests.RequestException, ValueError, KeyError, TypeError) as err:
        logger.error("Error reading XSUAA users (%s)", type(err).__name__)
        raise HTTPException(
            502, "Could not read project users from the XSUAA application service."
        )

    display_roles = [
        os.getenv("XSUAA_ADMIN_ROLE_COLLECTION") or PRIMARY_ADMIN_ROLE,
        os.getenv("XSUAA_MEMBER_ROLE_COLLECTION") or PRIMARY_MEMBER_ROLE,
    ]
    result = {
        "users": users,
        "total": len(users),
        "source": "xsuaa",
        "project_role_collections": display_roles,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    with _USERS_CACHE_LOCK:
        _USERS_CACHE[cache_key] = {"data": copy.deepcopy(result), "timestamp": now}
    return result
