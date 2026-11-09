"""Connection administration and encrypted server-side credential references."""
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from urllib.parse import parse_qsl, urlsplit

from fastapi import HTTPException
from cryptography.fernet import Fernet, InvalidToken

from api.models.execution_context import current_identity, require_admin
from api.platform.connectors import ConnectionSpec, REGISTRY, AUTH_TYPES, open_connector
from api.platform.semantic import now
from api.platform.store import metadata_store


def _resolve_credential_key():
    key = os.getenv("PLATFORM_CREDENTIAL_KEY")
    if key:
        return key
    from pathlib import Path
    base_dir = Path(__file__).resolve().parent.parent.parent.parent
    env_file = base_dir / ".env"
    if env_file.exists():
        try:
            from dotenv import dotenv_values
            vals = dotenv_values(env_file)
            if vals.get("PLATFORM_CREDENTIAL_KEY"):
                os.environ["PLATFORM_CREDENTIAL_KEY"] = vals["PLATFORM_CREDENTIAL_KEY"]
                return vals["PLATFORM_CREDENTIAL_KEY"]
        except Exception:
            pass
    key_file = base_dir / "data" / "storage" / ".credential_key"
    if key_file.exists():
        try:
            key = key_file.read_text(encoding="utf-8").strip()
            if key:
                os.environ["PLATFORM_CREDENTIAL_KEY"] = key
                return key
        except Exception:
            pass
    key = Fernet.generate_key().decode()
    try:
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.write_text(key, encoding="utf-8")
        os.environ["PLATFORM_CREDENTIAL_KEY"] = key
    except Exception:
        pass
    return key


class CredentialStore:
    def __init__(self, store=None, key=None):
        self.store = store or metadata_store()
        self.key = key or _resolve_credential_key()

    def cipher(self):
        if not self.key:
            self.key = _resolve_credential_key()
        if not self.key:
            raise HTTPException(503, "Configure PLATFORM_CREDENTIAL_KEY in server-side secret storage before saving credentials.")
        try:
            return Fernet(self.key.encode() if isinstance(self.key, str) else self.key)
        except (ValueError, TypeError):
            raise HTTPException(503, "The server credential encryption key is invalid.") from None

    def put(self, workspace, reference, credentials):
        encrypted = self.cipher().encrypt(json.dumps(credentials).encode()).decode()
        namespace = workspace + ":credentials"
        previous = self.store.get(namespace, reference)
        self.store.put(namespace, reference, {"encrypted": encrypted}, previous["revision"] if previous else 0)

    def get(self, workspace, reference):
        if not reference:
            return {}
        row = self.store.get(workspace + ":credentials", reference)
        if row is None:
            raise HTTPException(503, "Connection credentials are unavailable.")
        try:
            return json.loads(self.cipher().decrypt(row["value"]["encrypted"].encode()))
        except InvalidToken:
            raise HTTPException(503, "Credentials cannot be decrypted with the configured key.") from None


def validate_public_config(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if re.search(r"password|secret|token|credential|authorization|api.?key$|access.?key", key, re.I) and key not in ("token_url", "api_key_header"):
                raise HTTPException(422, "Place credentials in the separate credentials field.")
            validate_public_config(item)
    elif isinstance(value, list):
        for item in value:
            validate_public_config(item)
    elif isinstance(value, str) and value.startswith(("https://", "http://")):
        parsed = urlsplit(value)
        if parsed.username or parsed.password or any(re.search(r"token|secret|password|key|sig", key, re.I) for key, _ in parse_qsl(parsed.query)):
            raise HTTPException(422, "Do not embed credentials in endpoint URLs.")


class ConnectionService:
    def __init__(self, store=None, credentials=None):
        self._store, self._credentials = store, credentials

    @property
    def store(self):
        return self._store or metadata_store()

    @property
    def credentials(self):
        return self._credentials or CredentialStore(self.store)

    def namespace(self):
        identity = current_identity.get()
        if identity is None:
            raise HTTPException(401, "A verified account is required.")
        return identity["workspace_id"] + ":connections"

    def list(self):
        return [{"id": row["id"], "revision": row["revision"], **{key: value for key, value in row["value"].items() if key != "credential_ref"},
                 "credentials_configured": bool(row["value"].get("credential_ref"))} for row in self.store.list(self.namespace())]

    def save(self, spec, connection_id=None, expected_revision=0):
        identity = require_admin()
        if spec.service not in REGISTRY or (spec.provider, spec.protocol) != REGISTRY[spec.service][:2]:
            raise HTTPException(422, "Choose a valid provider, service and protocol from the connector registry.")
        validate_public_config(spec.config)
        if spec.auth_type not in AUTH_TYPES[spec.service]:
            raise HTTPException(422, "The chosen authentication type is not supported by this service.")
        connection_id = connection_id or uuid.uuid4().hex
        previous = self.store.get(self.namespace(), connection_id)
        if previous and expected_revision != previous["revision"]:
            raise HTTPException(409, "Connection changed. Refresh before editing it.")
        reference = previous["value"].get("credential_ref") if previous else None
        if spec.credentials:
            # Each credential revision is immutable; concurrent config edits cannot replace its secret.
            reference = uuid.uuid4().hex
            self.credentials.put(identity["workspace_id"], reference, {key: value.get_secret_value() for key, value in spec.credentials.items()})
        if spec.auth_type not in ("none", "managed") and not reference:
            raise HTTPException(422, "Supply credentials for the selected authentication type.")
        value = {**spec.model_dump(), "credential_ref": reference, "enabled": True,
                 "updated_at": now(), "updated_by": identity["user_id"], "verification": "not_tested"}
        saved = self.store.put(self.namespace(), connection_id, value, expected_revision)
        self.audit("connection_saved", connection_id)
        return {"id": connection_id, "revision": saved["revision"], **{key: value for key, value in value.items() if key != "credential_ref"}, "credentials_configured": bool(reference)}

    def get(self, connection_id):
        row = self.store.get(self.namespace(), connection_id)
        if row is None:
            raise HTTPException(404, "Connection not found.")
        return row

    def disable(self, connection_id):
        require_admin()
        row = self.get(connection_id)
        self.store.put(self.namespace(), connection_id, {**row["value"], "enabled": False}, row["revision"])
        self.audit("connection_disabled", connection_id)
        return {"status": "disabled"}

    @contextmanager
    def open(self, connection_id, cancelled=None):
        row = self.get(connection_id)
        config = row["value"]
        if not config["enabled"]:
            raise HTTPException(409, "This connection is disabled.")
        credentials = self.credentials.get(current_identity.get()["workspace_id"], config.get("credential_ref"))
        spec = ConnectionSpec.model_validate({key: config[key] for key in ("name", "provider", "service", "protocol", "auth_type", "config")})
        adapter = None
        try:
            adapter = open_connector(spec, credentials, cancelled)
            yield adapter
        except HTTPException:
            raise
        except ImportError:
            raise HTTPException(503, "Install the documented optional SDK for this connector on the backend.") from None
        except Exception as exc:
            err_msg = str(exc)
            import re
            err_sanitized = re.sub(r'[\?&]apikey=[^&\s]+', '', err_msg)
            raise HTTPException(502, f"Source operation failed ({type(exc).__name__}: {err_sanitized[:120]}). Check credentials, object selection, permissions and provider availability.") from None
        finally:
            if adapter is not None:
                adapter.close()

    def test(self, connection_id):
        require_admin()
        started = time.perf_counter()
        try:
            with self.open(connection_id) as adapter:
                adapter.test()
        except HTTPException:
            row = self.get(connection_id)
            self.store.put(self.namespace(), connection_id, {**row["value"], "verification": "failed", "last_tested_at": now()}, row["revision"])
            raise
        row = self.get(connection_id)
        value = {**row["value"], "verification": "verified", "verified_at": now()}
        self.store.put(self.namespace(), connection_id, value, row["revision"])
        self.audit("connection_tested", connection_id)
        return {"status": "connected", "elapsed_ms": (time.perf_counter() - started) * 1000}

    def audit(self, action, resource):
        identity = current_identity.get()
        self.store.put(identity["workspace_id"] + ":audit", uuid.uuid4().hex,
                       {"action": action, "resource": resource, "user_id": identity["user_id"], "timestamp": now()})


connection_service = ConnectionService()
