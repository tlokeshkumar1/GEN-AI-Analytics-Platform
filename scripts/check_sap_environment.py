"""Inspect real SAP bindings without printing credentials; optionally refresh local XSUAA.

Run with the backend Python environment. Cloud Foundry commands are read-only.
"""
import argparse
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

import jwt
import requests
from cryptography.hazmat.primitives import serialization
from dotenv import dotenv_values, set_key

ROOT = pathlib.Path(__file__).resolve().parents[1]


def valid_key(value):
    if not value:
        return False
    value = value.replace("\\n", "\n")
    if "-----BEGIN PUBLIC KEY-----" in value and "\n" not in value:
        value = value.replace("-----BEGIN PUBLIC KEY-----", "-----BEGIN PUBLIC KEY-----\n").replace("-----END PUBLIC KEY-----", "\n-----END PUBLIC KEY-----")
    try:
        serialization.load_pem_public_key(value.encode())
        return True
    except (ValueError, TypeError):
        return False


def cf_json(path):
    result = subprocess.run(["cf", "curl", path], capture_output=True, text=True, timeout=45)
    if result.returncode or "Error writing config" in result.stderr:
        raise RuntimeError("Cloud Foundry access failed. Check CLI login, network access and config permissions.")
    if not result.stdout.strip():
        raise RuntimeError("Cloud Foundry returned no API response. Run cf login and retry.")
    try:
        payload = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError("Cloud Foundry did not return JSON. Run cf login and retry.") from None
    if payload.get("errors"):
        raise RuntimeError("Cloud Foundry rejected the request. Check CLI login and application access.")
    return payload


def app_environment(name):
    apps = cf_json("/v3/apps?names=" + name).get("resources", [])
    if len(apps) != 1:
        raise RuntimeError(f"Expected one accessible application named {name}; found {len(apps)}.")
    return cf_json("/v3/apps/" + apps[0]["guid"] + "/env")


def refresh_signing_key(data, service, path):
    """Get the active key from the configured issuer, verified with a real service token."""
    credentials = service["credentials"]
    url = credentials["url"].rstrip("/")
    if not url.startswith("https://"):
        raise RuntimeError("XSUAA issuer must use HTTPS.")
    try:
        response = requests.post(url + "/oauth/token", auth=(credentials["clientid"], credentials["clientsecret"]),
                                 data={"grant_type": "client_credentials"}, timeout=20)
        if response.status_code != 200:
            raise RuntimeError(f"XSUAA service authentication returned HTTP {response.status_code}. Refresh the service binding.")
        token = response.json()["access_token"]
        header = jwt.get_unverified_header(token)
        keys = requests.get(url + "/token_keys", timeout=20)
        keys.raise_for_status()
        key = next((item.get("value") for item in keys.json().get("keys", []) if item.get("kid") == header.get("kid")), None)
        if not valid_key(key):
            raise RuntimeError("The issuer did not return a valid PEM for the active signing key.")
        date = response.headers.get("Date")
        if date:
            from email.utils import parsedate_to_datetime
            delta = (datetime.now(timezone.utc) - parsedate_to_datetime(date)).total_seconds()
            print("Backend UTC minus SAP server UTC (seconds):", round(delta, 1))
        # Verify signature and binding identity; clock validation remains enabled.
        claims = jwt.decode(token, key, algorithms=["RS256"], options={"verify_aud": False})
        if claims.get("cid") != credentials["clientid"] or claims.get("zid") != credentials.get("identityzoneid"):
            raise RuntimeError("The issuer token does not match the configured application/tenant.")
    except requests.RequestException:
        raise RuntimeError("XSUAA network request failed. Check network access and retry.") from None
    except jwt.PyJWTError:
        raise RuntimeError("The issuer token could not be verified. Check the backend UTC clock and binding.") from None
    credentials["verificationkey"] = key
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    set_key(str(ROOT / ".env"), "XSUAA_VERIFICATION_KEY", key)
    print("Signing key refreshed from the real XSUAA issuer and signature verified. Restart the local backend/router.")


def inspect_hana(catalog=False):
    """Read connection/schema metadata only; do not initialize or modify tables."""
    sys.path.insert(0, str(ROOT / "backend"))
    from api.config import settings
    from hdbcli import dbapi
    connection = None
    try:
        connection = dbapi.connect(address=settings.HANA_ADDRESS, port=settings.HANA_PORT,
                                   user=settings.HANA_USER, password=settings.HANA_PASSWORD,
                                   encrypt=True, sslValidateCertificate=False)
        cursor = connection.cursor()
        if settings.HANA_SCHEMA:
            identifier = settings.HANA_SCHEMA.replace('"', '""')
            cursor.execute(f'SET SCHEMA "{identifier}"')
        cursor.execute("SELECT CURRENT_SCHEMA FROM DUMMY")
        current_schema = cursor.fetchone()[0]
        print("HANA connected; current schema matches configuration:", current_schema == settings.HANA_SCHEMA)
        if catalog:
            print("Configured HANA schema:", current_schema)
            cursor.execute("SELECT SCHEMA_NAME, TABLE_NAME FROM SYS.TABLES WHERE UPPER(TABLE_NAME) LIKE '%CHAT%' OR UPPER(TABLE_NAME) LIKE '%SESSION%' OR UPPER(TABLE_NAME) LIKE '%MESSAGE%' ORDER BY SCHEMA_NAME, TABLE_NAME")
            tables = cursor.fetchall()
            print("Accessible tables with chat/session/message names:", len(tables))
            for schema, name in tables:
                print(" table:", schema + "." + name)
                if name in ("CHAT_SESSIONS", "CHAT_MESSAGES"):
                    cursor.execute("SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?", (schema, name))
                    columns = {row[0] for row in cursor.fetchall()}
                    print("  columns:", ", ".join(sorted(columns)))
                    qualified = '"' + schema.replace('"', '""') + '"."' + name.replace('"', '""') + '"'
                    cursor.execute("SELECT COUNT(*) FROM " + qualified)
                    print("  existing records:", cursor.fetchone()[0])
                    if name == "CHAT_SESSIONS" and "USER_ID" in columns:
                        cursor.execute("SELECT COUNT(*) FROM " + qualified + " WHERE USER_ID IS NULL OR USER_ID = 'default_user'")
                        print("  records requiring confirmed legacy ownership:", cursor.fetchone()[0])
            cursor.execute("SELECT SCHEMA_NAME, VIEW_NAME FROM SYS.VIEWS WHERE UPPER(VIEW_NAME) LIKE '%CHAT%' OR UPPER(VIEW_NAME) LIKE '%SESSION%' OR UPPER(VIEW_NAME) LIKE '%MESSAGE%' ORDER BY SCHEMA_NAME, VIEW_NAME")
            views = cursor.fetchall()
            print("Accessible views with chat/session/message names:", len(views))
            for schema, name in views:
                print(" view:", schema + "." + name)
        for table, required in {
            "CHAT_SESSIONS": {"SESSION_ID", "USER_ID", "SUBJECT", "CREATED_AT", "UPDATED_AT"},
            "CHAT_MESSAGES": {"MESSAGE_ID", "SESSION_ID", "ROLE", "CONTENT", "SOURCES", "INTENT", "METADATA", "TIMESTAMP"},
        }.items():
            cursor.execute("SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?", (table,))
            columns = {row[0] for row in cursor.fetchall()}
            print(table + " exists:", bool(columns), "required columns present:", required.issubset(columns))
        cursor.close()
    except Exception as exc:
        raise RuntimeError("HANA read-only diagnostic failed (" + type(exc).__name__ + "). Check network access and HANA credentials/schema.") from None
    finally:
        if connection is not None:
            connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cf", action="store_true", help="Inspect deployed API/router bindings")
    parser.add_argument("--refresh-bindings", action="store_true", help="Refresh local XSUAA from the deployed API binding")
    parser.add_argument("--refresh-signing-key", action="store_true", help="Verify and refresh the active key from the existing XSUAA issuer")
    parser.add_argument("--hana", action="store_true", help="Read HANA schema/table metadata without changing data")
    parser.add_argument("--catalog", action="store_true", help="Find accessible chat/history tables across all schemas; read metadata only")
    parser.add_argument("--initialize-chat-tables", action="store_true", help="Create missing chat tables/ownership column; preserve existing data")
    parser.add_argument("--verify-chat-history", action="store_true", help="Verify the API can use existing chat tables; no schema changes")
    parser.add_argument("--space", default="dev")
    args = parser.parse_args()
    print("Backend host UTC:", datetime.now(timezone.utc).isoformat())
    env = dotenv_values(ROOT / ".env")
    path = ROOT / "default-env.json"
    data = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    expected = env.get("XSUAA_SERVICE_NAME") or args.space + "-gen-ai-analytics-platform-xsuaa"
    local = [s for s in data.get("VCAP_SERVICES", {}).get("xsuaa", []) if s.get("name") == expected]
    print("Local XSUAA binding:", expected, "found:", len(local))
    if local:
        print("Local signing key parses:", valid_key(local[0].get("credentials", {}).get("verificationkey")))
    if args.refresh_signing_key:
        if len(local) != 1:
            raise RuntimeError("Exactly one matching local application binding is required.")
        refresh_signing_key(data, local[0], path)
    if args.initialize_chat_tables or args.verify_chat_history:
        sys.path.insert(0, str(ROOT / "backend"))
        from api.config import settings
        from api.services.history_service import history_service
        from fastapi import HTTPException
        try:
            history_service.init_tables(allow_schema_changes=args.initialize_chat_tables)
        except HTTPException as exc:
            raise RuntimeError(exc.detail) from None
        print("Chat history tables verified by the API; no chat records were added.")
    if args.hana or args.catalog or args.initialize_chat_tables:
        inspect_hana(catalog=args.catalog)
    if not args.cf and not args.refresh_bindings:
        return
    api = app_environment("gen-ai-analytics-platform-api-" + args.space)
    router = app_environment("gen-ai-analytics-platform-router-" + args.space)
    api_vars = api.get("environment_variables", {})
    api_services = api.get("system_env_json", {}).get("VCAP_SERVICES", {})
    router_services = router.get("system_env_json", {}).get("VCAP_SERVICES", {})
    expected = api_vars.get("XSUAA_SERVICE_NAME") or expected
    selected = [s for s in api_services.get("xsuaa", []) if s.get("name") == expected and s.get("plan") == "application"]
    if len(selected) != 1:
        raise RuntimeError("The deployed API does not have exactly one matching application XSUAA binding.")
    service = selected[0]
    credentials = service.get("credentials", {})
    matching_router = any(s.get("credentials", {}).get("xsappname") == credentials.get("xsappname") for s in router_services.get("xsuaa", []))
    print("API and router share XSUAA application:", matching_router)
    print("Deployed signing key parses:", valid_key(credentials.get("verificationkey")))
    print("Directory API configured:", bool(credentials.get("apiurl")))
    for key in ("APP_ENV", "XSUAA_SERVICE_NAME", "XSUAA_ADMIN_ROLE_COLLECTION", "XSUAA_MEMBER_ROLE_COLLECTION"):
        print(key + ":", api_vars.get(key, "not explicitly configured"))
    if args.refresh_bindings:
        if not matching_router or not valid_key(credentials.get("verificationkey")):
            raise RuntimeError("Binding verification failed; local credentials were not changed.")
        current = data.setdefault("VCAP_SERVICES", {}).get("xsuaa", [])
        data["VCAP_SERVICES"]["xsuaa"] = [s for s in current if s.get("name") != service["name"]] + [service]
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        updates = {
            "XSUAA_SERVICE_NAME": service["name"], "XSUAA_URL": credentials["url"],
            "XSUAA_AUTH_URL": credentials["url"].rstrip("/") + "/oauth/token",
            "XSUAA_CLIENT_ID": credentials["clientid"], "XSUAA_CLIENT_SECRET": credentials["clientsecret"],
            "XSUAA_XSAPPNAME": credentials["xsappname"], "XSUAA_VERIFICATION_KEY": credentials["verificationkey"],
        }
        for key in ("XSUAA_ADMIN_ROLE_COLLECTION", "XSUAA_MEMBER_ROLE_COLLECTION"):
            if api_vars.get(key):
                updates[key] = api_vars[key]
        for key, value in updates.items():
            set_key(str(ROOT / ".env"), key, value)
        print("Local XSUAA binding and root .env refreshed from the real deployed service. Restart local processes.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        # Keep raw service responses and credential-bearing exceptions out of output.
        print("Check failed:", str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__)
        raise SystemExit(1)
