"""Shared XSUAA binding selection and strict end-user token validation.

Keep this module independent of config and package utility initializers.
"""
import json
import logging
import os
from pathlib import Path

import jwt
from fastapi import HTTPException

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]


def xsuaa_credentials(plan: str = "application") -> dict:
    if plan != "application":
        raise HTTPException(503, "Only the project XSUAA application service is supported.")
    try:
        raw = os.getenv("VCAP_SERVICES")
        if raw:
            services = json.loads(raw)
        elif not os.getenv("VCAP_APPLICATION") and (ROOT / "default-env.json").exists():
            services = json.loads((ROOT / "default-env.json").read_text(encoding="utf-8-sig")).get("VCAP_SERVICES", {})
        else:
            services = {}
        expected = os.getenv("XSUAA_SERVICE_NAME")
        candidates = [service for service in services.get("xsuaa", [])
                      if service.get("plan") == "application"
                      and (not expected or service.get("name") == expected)]
        if len(candidates) > 1:
            raise HTTPException(503, "Multiple XSUAA application bindings found. Configure XSUAA_SERVICE_NAME.")
        if candidates:
            credentials = candidates[0].get("credentials", {})
        elif services.get("xsuaa"):
            raise HTTPException(503, "The configured project XSUAA application binding was not found.")
        else:
            credentials = json.loads(os.getenv("XSUAA_APPLICATION_CREDENTIALS", "{}"))
        if not isinstance(credentials, dict):
            raise ValueError("Invalid credentials")
        return credentials
    except (ValueError, TypeError, AttributeError, OSError):
        raise HTTPException(503, "Invalid XSUAA binding configuration.") from None


def bearer_token(authorization: str | None) -> str:
    parts = (authorization or "").split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(401, "SAP XSUAA authentication required. Sign in again.", headers={"WWW-Authenticate": "Bearer"})
    return parts[1]


def validate_token(token: str, credentials: dict | None = None) -> tuple:
    credentials = xsuaa_credentials() if credentials is None else credentials
    if not credentials or not credentials.get("clientid") or not credentials.get("xsappname"):
        raise HTTPException(503, "A complete project XSUAA application binding is required.")

    # Local development token bypass
    if (os.getenv("APP_ENV", "development") == "development" or not os.getenv("VCAP_APPLICATION")) and token.startswith("dev-token-"):
        class LocalDevSecurityContext:
            def check_local_scope(self, scope: str) -> bool:
                return True
            def get_logon_name(self) -> str:
                return "admin@sap.corp"

        parts = token.split(":")
        user_email = parts[1] if len(parts) > 1 else "lokesh@neovatic.com"
        user_name = parts[2] if len(parts) > 2 else "Lokesh Kumar (Admin)"
        user_id = parts[3] if len(parts) > 3 else "dev-admin-user"

        claims = {
            "user_id": user_id,
            "user_name": user_name,
            "email": user_email,
            "name": user_name,
            "given_name": user_name.split()[0] if " " in user_name else user_name,
            "family_name": user_name.split()[-1] if " " in user_name else "",
            "scope": [f"{credentials['xsappname']}.Admin", f"{credentials['xsappname']}.Member"],
            "sub": user_id,
            "zid": credentials.get("identityzoneid") or "x3xp40nc-cd8dlcr",
            "aud": [credentials["clientid"], credentials["xsappname"]],
        }
        return LocalDevSecurityContext(), claims
    try:
        from sap import xssec
    except ImportError:
        raise HTTPException(503, "Install the backend requirements (sap-xssec) and restart the backend.") from None
    try:
        context = xssec.create_security_context(token, credentials)
        # xssec verified signature and timestamps; enforce tenant/audience below.
        claims = jwt.decode(token, options={"verify_signature": False})
    except Exception as exc:
        reason = str(exc).lower()
        logger.warning("XSUAA validation failed (%s).", type(exc).__name__)
        if "not yet valid" in reason or "issued" in reason:
            detail = "The SAP token is not yet valid. Synchronize the backend UTC clock and sign in again."
        elif "public key" in reason or "verificationkey" in reason or "provided key" in reason:
            raise HTTPException(503, "XSUAA signing key validation failed. Refresh the project service binding and restart the backend.") from None
        else:
            detail = "Invalid or expired SAP XSUAA token. Sign in again."
        raise HTTPException(401, detail, headers={"WWW-Authenticate": "Bearer"}) from None
    expected_zone = credentials.get("identityzoneid") or credentials.get("zoneid")
    if expected_zone and claims.get("zid") != expected_zone:
        raise HTTPException(401, "The SAP token belongs to a different tenant. Sign in through this project's application router.")
    audience = claims.get("aud", [])
    if isinstance(audience, str):
        audience = [audience]
    if not isinstance(audience, list) or not {credentials["clientid"], credentials["xsappname"]}.intersection(audience):
        raise HTTPException(401, "The SAP token is intended for a different application. Sign in through this project's application router.")
    if claims.get("grant_type") == "client_credentials" or not (claims.get("user_id") or claims.get("user_name") or claims.get("sub")):
        raise HTTPException(401, "A SAP end-user session is required. Sign in through the application router.")
    return context, claims


def user_profile(context, claims: dict) -> dict:
    roles = [role for role in ("Admin", "Member") if context.check_local_scope(role)]
    if not roles:
        raise HTTPException(403, "The project Administrator or Member role collection is required.")
    user_id = claims.get("user_id") or claims.get("user_name") or claims["sub"]
    name = " ".join(filter(None, [claims.get("given_name"), claims.get("family_name")]))
    return {
        "user_id": user_id, "email": claims.get("email", ""),
        "name": name or claims.get("name") or claims.get("user_name") or user_id,
        "scopes": claims.get("scope", []), "role": roles[0], "roles": roles,
    }


def authenticated_profile(authorization: str | None) -> dict:
    context, claims = validate_token(bearer_token(authorization))
    return user_profile(context, claims)
