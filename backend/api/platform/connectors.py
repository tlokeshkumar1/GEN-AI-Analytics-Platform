"""Real source adapters behind one extraction contract. Optional SDKs load on use."""
import json
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import requests
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr


class ConnectionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    provider: str
    service: str
    protocol: str
    auth_type: str = "none"
    config: dict = Field(default_factory=dict)
    credentials: dict[str, SecretStr] = Field(default_factory=dict, exclude=True)


@dataclass
class Batch:
    records: list[dict] = field(default_factory=list)
    checkpoint: dict = field(default_factory=dict)
    content: bytes | None = None
    filename: str | None = None


def path_value(value, path):
    for key in path.split(".") if path else []:
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def map_records(records, mapping):
    if not mapping:
        return records
    if not isinstance(mapping, dict) or any(not isinstance(path, str) for path in mapping.values()):
        raise ValueError("Response mapping must map source field names to record paths")
    return [{field: path_value(row, path) for field, path in mapping.items()} for row in records]


def endpoint(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Use an HTTP endpoint without embedded credentials")
    if parsed.scheme != "https" and os.getenv("CONNECTOR_ALLOW_HTTP") != "true":
        raise ValueError("HTTPS is required unless HTTP is explicitly enabled for development")
    allowed = [host.strip() for host in os.getenv("CONNECTOR_ALLOWED_HOSTS", "").split(",") if host.strip()]
    if os.getenv("VCAP_APPLICATION") and not allowed:
        raise ValueError("Configure CONNECTOR_ALLOWED_HOSTS before using external endpoints")
    if allowed and parsed.hostname not in allowed:
        raise ValueError("Endpoint host is not in the configured connector allowlist")
    return url


class Adapter:
    def __init__(self, config, credentials=None, auth_type="none", cancelled=None):
        self.config, self.credentials, self.auth_type = config, credentials or {}, auth_type
        self.cancelled: Callable = cancelled or (lambda: False)

    def check_cancelled(self):
        if self.cancelled():
            raise HTTPException(409, "Source extraction was cancelled.")

    def test(self):
        self.discover()
        return {"status": "connected"}

    def preview(self, source, limit=20):
        output = []
        for batch in self.extract(source):
            if batch.content is not None:
                from api.platform.ingestion import ingestion_service
                from api.services.dataset_service import DatasetService
                frame, profile = ingestion_service.prepare(batch.content, batch.filename)
                return {"records": DatasetService._rows(frame.head(limit)), "profile": profile.model_dump(mode="json")}
            output.extend(batch.records[:limit - len(output)])
            if len(output) >= limit:
                break
        return {"records": output}

    def close(self):
        pass


class HTTPAdapter(Adapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.base = endpoint(self.config["base_url"].rstrip("/") + "/")
        self.session = requests.Session()
        request = self.session.request
        def scoped_request(method, url, **options):
            endpoint(url)
            if (urlsplit(url).scheme, urlsplit(url).netloc) != (urlsplit(self.base).scheme, urlsplit(self.base).netloc):
                raise ValueError("Service and WSDL requests must remain on the configured origin")
            options["allow_redirects"] = False
            return request(method, url, **options)
        self.session.request = scoped_request
        if self.auth_type == "basic":
            self.session.auth = (self.credentials["username"], self.credentials["password"])
        elif self.auth_type == "bearer":
            self.session.headers["Authorization"] = "Bearer " + self.credentials["token"]
        elif self.auth_type == "api_key":
            key_val = self.credentials["api_key"]
            header = self.config.get("api_key_header")
            if not header:
                if any(x in self.base.lower() for x in ("sandbox.api.sap.com", "api.sap.com", "s4hana", "sap")):
                    header = "apikey"
                else:
                    header = "X-API-Key"
            self.session.headers[header] = key_val
            if header.lower() == "apikey":
                self.session.headers["apikey"] = key_val
                self.session.headers["X-API-Key"] = key_val
        elif self.auth_type == "oauth2_client_credentials":
            response = requests.post(endpoint(self.config["token_url"]),
                                     auth=(self.credentials["client_id"], self.credentials["client_secret"]),
                                     data={"grant_type": "client_credentials", "scope": self.config.get("scope", "")}, timeout=30, allow_redirects=False)
            if 300 <= response.status_code < 400:
                raise ValueError("Configure the final OAuth token endpoint; redirects are not followed")
            response.raise_for_status()
            self.session.headers["Authorization"] = "Bearer " + response.json()["access_token"]
        elif self.auth_type != "none":
            raise ValueError("Unsupported HTTP authentication type")

    def get(self, target, params=None, raw=False, headers=None):
        self.check_cancelled()
        url = endpoint(urljoin(self.base, target))
        if (urlsplit(url).scheme, urlsplit(url).netloc) != (urlsplit(self.base).scheme, urlsplit(self.base).netloc):
            raise ValueError("Cross-origin extraction links are not permitted")
        req_headers = dict(headers or {})
        if not raw and "Accept" not in req_headers:
            req_headers["Accept"] = "application/json"
        response = self.session.get(url, params=params, headers=req_headers if req_headers else None, timeout=30, allow_redirects=False)
        if (response.status_code in (401, 404)) and ("sandbox.api.sap.com" in self.base) and ("/s4hanacloud/" not in url):
            sandbox_url = url.replace("sandbox.api.sap.com/", "sandbox.api.sap.com/s4hanacloud/")
            alt_resp = self.session.get(sandbox_url, params=params, headers=req_headers if req_headers else None, timeout=30, allow_redirects=False)
            if alt_resp.status_code < 400:
                response = alt_resp
        if 300 <= response.status_code < 400:
            raise ValueError("Configure the final source endpoint; redirects are not followed")
        response.raise_for_status()
        return response.content if raw else response.json(parse_float=Decimal)

    def discover(self):
        value = self.get(self.config.get("discovery_path", ""))
        return {"document": value, "service": "rest"}

    def extract(self, source, checkpoint=None):
        mode = self.config.get("pagination", "none")
        if mode not in ("none", "next_link", "page", "offset"):
            raise ValueError("Unsupported REST pagination mode")
        target = source
        size = int(self.config.get("page_size", 500))
        page = 1
        seen = set()
        for _ in range(int(self.config.get("max_pages", 1000))):
            params = {}
            if mode == "page":
                params = {self.config.get("page_parameter", "page"): page, self.config.get("size_parameter", "pageSize"): size}
            elif mode == "offset":
                params = {self.config.get("offset_parameter", "offset"): (page - 1) * size, self.config.get("size_parameter", "limit"): size}
            value = self.get(target, params)
            rows = path_value(value, self.config.get("records_path", ""))
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError("Configure records_path to select an array of records")
            if mode in ("page", "offset"):
                signature = json.dumps(rows, sort_keys=True, default=str)
                if rows and signature in seen:
                    raise ValueError("The provider repeated a page; check pagination settings")
                seen.add(signature)
            yield Batch(records=map_records(rows, self.config.get("response_mapping")))
            if mode == "none" or not rows:
                return
            if mode == "next_link":
                try:
                    next_link = path_value(value, self.config.get("next_link_path", "next"))
                except KeyError:
                    next_link = None
                if not next_link:
                    return
                if next_link in seen:
                    raise ValueError("Provider pagination contains a cycle")
                seen.add(next_link)
                target = urljoin(urljoin(self.base, target), next_link)
            elif len(rows) < size:
                return
            page += 1
        raise ValueError("Provider exceeded the configured page limit; extraction was not committed")

    def close(self):
        self.session.close()


class ODataAdapter(HTTPAdapter):
    def discover(self):
        document = self.get("$metadata", raw=True)
        if b"<!DOCTYPE" in document.upper() or b"<!ENTITY" in document.upper():
            raise ValueError("External entities are not supported in service metadata")
        root = ElementTree.fromstring(document)
        return {"entities": [{"name": item.attrib["Name"], "type": item.attrib.get("EntityType")} for item in root.iter() if item.tag.endswith("}EntitySet")],
                "service": "odata"}

    def extract(self, source, checkpoint=None):
        target = (checkpoint or {}).get("delta_link", source) if self.config.get("incremental") else source
        seen = set()
        for _ in range(int(self.config.get("max_pages", 1000))):
            self.check_cancelled()
            if target in seen:
                raise ValueError("OData next-link cycle detected")
            seen.add(target)
            value = self.get(target)
            rows = value.get("value", value.get("d", {}).get("results"))
            if not isinstance(rows, list):
                raise ValueError("The service did not return an OData entity collection")
            delta = value.get("@odata.deltaLink")
            mapped = []
            for row in rows:
                if "@removed" in row or "@odata.removed" in row:
                    deletion_field, deletion_mapping = self.config.get("deletion_field"), self.config.get("deletion_mapping")
                    if not deletion_field or not deletion_mapping:
                        raise ValueError("Map OData deletion event keys and select a deletion_field before applying a delta")
                    event = map_records([row], deletion_mapping)[0]
                    mapped.append({**event, deletion_field: True})
                else:
                    clean = {key: item for key, item in row.items() if key not in ("__metadata", "@odata.etag", "@odata.context")}
                    mapped.extend(map_records([clean], self.config.get("response_mapping")))
            yield Batch(records=mapped, checkpoint={"delta_link": delta} if delta else {})
            link = value.get("@odata.nextLink") or value.get("d", {}).get("__next")
            if not link:
                return
            target = urljoin(urljoin(self.base, target), link)
        raise ValueError("OData extraction exceeded the page limit")


class S4HANAAdapter(ODataAdapter):
    def __init__(self, config, *args, **kwargs):
        service = config.get("api_service")
        if not service or any(part in service for part in ("..", "?", "#")):
            raise ValueError("Select the published S/4HANA OData API service path")
        base = config["base_url"].rstrip("/") + "/" + service.strip("/")
        cfg = dict(config)
        cfg["base_url"] = base
        if any(x in base.lower() for x in ("sandbox.api.sap.com", "api.sap.com", "sap")):
            cfg.setdefault("api_key_header", "apikey")
        super().__init__(cfg, *args, **kwargs)


class SAPICSMAdapter(ODataAdapter):
    """SAP Intelligent Clinical Supply Management (ICSM) OData & OpenAPI Adapter.
    Integrates clinical trial-specific Purchase Orders, medication numbering (MedNo),
    outer/inner label barcodes (CFG, ITIP), subcontracting components, and clinical supply logistics.
    """
    def __init__(self, config, *args, **kwargs):
        from api.config import settings
        service = config.get("api_service", settings.ICSM_DEFAULT_SERVICE)
        base = config.get("base_url", settings.ICSM_DEFAULT_BASE_URL).rstrip("/")
        if service and not base.endswith(service.strip("/")):
            if "sandbox.api.sap.com" in base and "/s4hanacloud" not in base and not service.startswith("s4hanacloud"):
                base = f"{base}/s4hanacloud/{service.strip('/')}"
            else:
                base = f"{base}/{service.strip('/')}"
        cfg = dict(config)
        cfg["base_url"] = base
        if any(x in base.lower() for x in ("sandbox.api.sap.com", "api.sap.com", "sap")):
            cfg.setdefault("api_key_header", "apikey")
        super().__init__(cfg, *args, **kwargs)

    def discover(self):
        spec = self.config.get("spec_json")
        spec_path = self.config.get("spec_path")
        from pathlib import Path
        candidates = [
            spec_path,
            str(Path(__file__).resolve().parent.parent / "data" / "specifications" / "SAP_ICSM_PurchaseOrderExt.json"),
        ]
        if not spec:
            for c in candidates:
                if c and os.path.exists(c):
                    try:
                        with open(c, "r", encoding="utf-8") as f:
                            spec = json.load(f)
                            break
                    except Exception:
                        pass

        if spec and isinstance(spec, dict) and "paths" in spec:
            entities = []
            for path, path_item in spec.get("paths", {}).items():
                clean_path = path.strip("/")
                if "(" in clean_path or "/to_" in clean_path or clean_path.startswith("$"):
                    continue
                name = clean_path.split("/")[-1]
                entities.append({
                    "name": name,
                    "type": f"{name}Type",
                    "path": clean_path,
                    "description": (path_item.get("get", {}).get("summary") or name)
                })
            return {
                "title": spec.get("info", {}).get("title", "SAP ICSM OData Service"),
                "version": spec.get("info", {}).get("version", "1.0.0"),
                "entities": entities,
                "service": "sap_icsm"
            }

        return super().discover()


class SACAdapter(ODataAdapter):
    def __init__(self, config, *args, **kwargs):
        super().__init__({**config, "base_url": config["base_url"].rstrip("/") + "/api/v1/dataexport/"}, *args, **kwargs)

    def discover(self):
        return {"providers": self.get("providers"), "service": "sac_data_export"}

    def extract(self, source, checkpoint=None):
        namespace = self.config.get("namespace", "sac")
        provider = self.config.get("provider_id")
        if not provider or source not in ("FactData", "MasterData", "AccountMaster"):
            raise ValueError("Choose a SAC export provider and supported entity set")
        yield from super().extract(f"providers/{namespace}/{provider}/{source}", checkpoint)


class SOAPAdapter(HTTPAdapter):
    def _client(self):
        from zeep import Client, Settings
        from zeep.transports import Transport
        # WSDL network locations must be explicitly configured; credentials are scoped to this source.
        wsdl = endpoint(self.config["wsdl_url"])
        if urlsplit(wsdl).netloc != urlsplit(self.base).netloc:
            raise ValueError("WSDL must use the configured service origin")
        return Client(wsdl, transport=Transport(session=self.session, timeout=30, operation_timeout=60),
                      settings=Settings(strict=True, forbid_dtd=True, forbid_entities=True, forbid_external=True))

    def discover(self):
        client = self._client()
        return {"services": {name: {port_name: list(port.binding._operations) for port_name, port in service.ports.items()}
                             for name, service in client.wsdl.services.items()}, "service": "soap"}

    def extract(self, source, checkpoint=None):
        from zeep.helpers import serialize_object
        client = self._client()
        service = client.bind(self.config["service_name"], self.config["port_name"])
        self.check_cancelled()
        value = serialize_object(service[source](**self.config.get("operation_parameters", {})))
        rows = path_value(value, self.config.get("records_path", ""))
        mapping = self.config.get("response_mapping")
        if not isinstance(rows, list) or not mapping:
            raise ValueError("SOAP extraction requires an explicit record path and field mapping")
        yield Batch(records=[{field: path_value(row, path) for field, path in mapping.items()} for row in rows])


def identifier(value):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("A database object identifier is required")
    return '"' + value.replace('"', '""') + '"'


class HANAAdapter(Adapter):
    def _connect(self):
        from hdbcli import dbapi
        return dbapi.connect(address=self.config["host"], port=int(self.config.get("port", 443)),
                             user=self.credentials["username"], password=self.credentials["password"], encrypt=True, sslValidateCertificate=True)

    def discover(self):
        conn = self._connect()
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME=? ORDER BY TABLE_NAME, POSITION", (self.config["schema"],))
            return {"columns": [dict(zip(("table", "column", "type"), row)) for row in cursor.fetchall()]}
        finally:
            conn.close()

    def extract(self, source, checkpoint=None):
        conn = self._connect()
        try:
            cursor = conn.cursor()
            query = f"SELECT * FROM {identifier(self.config['schema'])}.{identifier(source)}"
            # Full snapshots are supported. A content hash is deliberately not used as an update key.
            cursor.execute(query)
            names = [column[0] for column in cursor.description]
            while True:
                self.check_cancelled()
                rows = cursor.fetchmany(int(self.config.get("page_size", 1000)))
                if not rows:
                    break
                yield Batch(records=[dict(zip(names, row)) for row in rows])
        finally:
            conn.close()


class ObjectAdapter(Adapter):
    def _client(self):
        service = self.config["object_service"]
        if service == "s3":
            import boto3
            return boto3.client("s3", region_name=self.config.get("region"),
                                aws_access_key_id=self.credentials.get("access_key_id"), aws_secret_access_key=self.credentials.get("secret_access_key"),
                                aws_session_token=self.credentials.get("session_token"))
        if service == "gcs":
            from google.cloud import storage
            from google.oauth2 import service_account
            credentials = service_account.Credentials.from_service_account_info(json.loads(self.credentials["service_account_json"])) if self.credentials.get("service_account_json") else None
            return storage.Client(project=self.config.get("project"), credentials=credentials)
        from azure.storage.blob import BlobServiceClient
        credential = self.credentials.get("account_key") or self.credentials.get("sas_token")
        if credential is None:
            from azure.identity import DefaultAzureCredential
            credential = DefaultAzureCredential()
        return BlobServiceClient(account_url=endpoint(self.config["account_url"]), credential=credential)

    def discover(self):
        client = self._client()
        try:
            service, bucket = self.config["object_service"], self.config["bucket"]
            prefix = self.config.get("prefix", "")
            if service == "s3":
                objects = []
                for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
                    objects.extend({"name": obj["Key"], "size": obj["Size"], "etag": obj["ETag"]} for obj in page.get("Contents", []))
                return {"objects": objects}
            if service == "gcs":
                return {"objects": [{"name": obj.name, "size": obj.size, "etag": obj.etag} for obj in client.list_blobs(bucket, prefix=prefix)]}
            return {"objects": [{"name": obj.name, "size": obj.size, "etag": obj.etag} for obj in client.get_container_client(bucket).list_blobs(name_starts_with=prefix)]}
        finally:
            if hasattr(client, "close"):
                client.close()

    def extract(self, source, checkpoint=None):
        self.check_cancelled()
        client = self._client()
        try:
            service, bucket = self.config["object_service"], self.config["bucket"]
            if service == "s3":
                response = client.get_object(Bucket=bucket, Key=source)
                etag, content = response["ETag"], response["Body"].read()
                response["Body"].close()
            elif service == "gcs":
                blob = client.bucket(bucket).get_blob(source)
                if blob is None:
                    raise ValueError("Source object not found")
                etag, content = blob.etag, blob.download_as_bytes(if_generation_match=blob.generation)
            else:
                blob = client.get_blob_client(bucket, source)
                etag = blob.get_blob_properties().etag
                content = blob.download_blob(etag=etag, match_condition=__import__('azure.core', fromlist=['MatchConditions']).MatchConditions.IfNotModified).readall()
            if checkpoint and checkpoint.get("etag") == etag:
                return
            yield Batch(content=content, filename=source.rsplit("/", 1)[-1], checkpoint={"etag": str(etag)})
        finally:
            if hasattr(client, "close"):
                client.close()


REGISTRY = {
    "rest": ("generic", "https", HTTPAdapter), "odata": ("generic", "odata", ODataAdapter),
    "soap": ("generic", "soap", SOAPAdapter), "hana": ("sap", "sql", HANAAdapter),
    "s4hana": ("sap", "odata", S4HANAAdapter), "sac": ("sap", "odata", SACAdapter),
    "sap_icsm": ("sap", "odata", SAPICSMAdapter),
    "s3": ("aws", "object", ObjectAdapter), "gcs": ("gcp", "object", ObjectAdapter),
    "azure_blob": ("azure", "object", ObjectAdapter),
}

AUTH_TYPES = {
    **{service: ["none", "basic", "bearer", "api_key", "oauth2_client_credentials"] for service in ("rest", "odata", "soap", "s4hana", "sac", "sap_icsm")},
    "hana": ["basic"], "s3": ["managed", "aws_keys"], "gcs": ["managed", "service_account"],
    "azure_blob": ["managed", "azure_key", "azure_sas"],
}


def open_connector(spec, credentials, cancelled=None):
    if spec.service not in REGISTRY:
        raise ValueError("Unsupported connector service")
    provider, protocol, adapter = REGISTRY[spec.service]
    if (spec.provider, spec.protocol) != (provider, protocol):
        raise ValueError("Provider, service and protocol do not match the connector registry")
    config = {**spec.config}
    if spec.service in ("s3", "gcs", "azure_blob"):
        config["object_service"] = spec.service
    return adapter(config, credentials, spec.auth_type, cancelled)
