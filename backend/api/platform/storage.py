"""Content-addressed durable objects and transactional dataset catalog manifests."""
import copy
import hashlib
import json
import os
import tempfile
import threading
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from api.platform.store import metadata_store


class ArtifactStore:
    def __init__(self, backend=None, root=None):
        self.backend = backend or os.getenv("PLATFORM_OBJECT_BACKEND", "local")
        self.root = Path(root or os.getenv("PLATFORM_OBJECT_ROOT", str(Path(tempfile.gettempdir()) / "platform_runtime" / ".objects")))
        self.bucket = os.getenv("PLATFORM_OBJECT_BUCKET", "")
        if os.getenv("VCAP_APPLICATION") and self.backend == "local":
            raise RuntimeError("Configure durable object storage before starting production ingestion")

    def _client(self):
        if self.backend == "s3":
            import boto3
            return boto3.client("s3")
        if self.backend == "gcs":
            from google.cloud import storage
            return storage.Client()
        if self.backend == "azure_blob":
            from azure.storage.blob import BlobServiceClient
            from azure.identity import DefaultAzureCredential
            return BlobServiceClient(account_url=os.environ["PLATFORM_AZURE_ACCOUNT_URL"], credential=DefaultAzureCredential())
        raise ValueError("Unsupported object storage backend")

    def put(self, content):
        key = "objects/" + hashlib.sha256(content).hexdigest()
        if self.backend == "local":
            destination = self.root / key
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                # Concurrent identical writes are safe; all keys are content hashes.
                temporary = destination.with_name(destination.name + f".{uuid.uuid4().hex}.tmp")
                temporary.write_bytes(content)
                os.replace(temporary, destination)
            return key
        client = self._client()
        try:
            if self.backend == "s3":
                client.put_object(Bucket=self.bucket, Key=key, Body=content)
            elif self.backend == "gcs":
                client.bucket(self.bucket).blob(key).upload_from_string(content)
            else:
                client.get_blob_client(self.bucket, key).upload_blob(content, overwrite=True)
        finally:
            if hasattr(client, "close"):
                client.close()
        return key

    def get(self, key):
        if not key.startswith("objects/") or len(key) != 72 or any(c not in "0123456789abcdef" for c in key[8:]):
            raise ValueError("Invalid artifact reference")
        if self.backend == "local":
            content = (self.root / key).read_bytes()
        else:
            client = self._client()
            try:
                if self.backend == "s3":
                    response = client.get_object(Bucket=self.bucket, Key=key)
                    content = response["Body"].read()
                    response["Body"].close()
                elif self.backend == "gcs":
                    content = client.bucket(self.bucket).blob(key).download_as_bytes()
                else:
                    content = client.get_blob_client(self.bucket, key).download_blob().readall()
            finally:
                if hasattr(client, "close"):
                    client.close()
        if hashlib.sha256(content).hexdigest() != key[8:]:
            raise ValueError("Stored artifact checksum does not match its manifest")
        return content


class DatasetRepository:
    def __init__(self, store=None, objects=None, workspace=None):
        self.store = store or metadata_store()
        self.objects = objects or ArtifactStore()
        self.namespace = (workspace or os.getenv("PLATFORM_WORKSPACE_ID", "default")) + ":datasets"
        self.cursor = ContextVar("dataset_catalog_transaction", default=None)
        self._snapshot_cache: OrderedDict[str, dict] = OrderedDict()
        self._snapshot_cache_lock = threading.Lock()
        self._snapshot_cache_max = 32

    @contextmanager
    def writer(self):
        with self.store.transaction() as cursor:
            suffix = " FOR UPDATE" if self.store.backend == "hana" else ""
            cursor.execute("SELECT REVISION FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'" + suffix, (self.namespace,))
            cursor.fetchone()
            token = self.cursor.set(cursor)
            try:
                yield
            finally:
                self.cursor.reset(token)

    def catalog(self):
        cursor = self.cursor.get()
        if cursor is not None:
            cursor.execute("SELECT REVISION, PAYLOAD FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'", (self.namespace,))
            record = self.store._decode(cursor.fetchone())
        else:
            record = self.store.get(self.namespace, "catalog")
        return record["value"] if record else {"datasets": {}, "activeDatasetId": None, "importedFiles": []}

    def publish(self, catalog):
        cursor = self.cursor.get()
        if cursor is None:
            raise RuntimeError("Publishing requires a catalog transaction")
        cursor.execute("SELECT REVISION FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'", (self.namespace,))
        row = cursor.fetchone()
        payload = json.dumps(catalog, ensure_ascii=False, allow_nan=False)
        if row:
            cursor.execute("UPDATE PLATFORM_DOCUMENTS SET PAYLOAD=?, REVISION=? WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'", (payload, row[0] + 1, self.namespace))
        else:
            cursor.execute("INSERT INTO PLATFORM_DOCUMENTS (NAMESPACE, DOCUMENT_ID, REVISION, PAYLOAD) VALUES (?, 'catalog', 1, ?)", (self.namespace, payload))

    def put_json(self, value):
        return self.objects.put(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))

    def snapshot(self, reference):
        with self._snapshot_cache_lock:
            cached = self._snapshot_cache.get(reference)
            if cached is not None:
                self._snapshot_cache.move_to_end(reference)
                return cached
        manifest = json.loads(self.objects.get(reference))
        loaded = {**json.loads(self.objects.get(manifest["data"])), **json.loads(self.objects.get(manifest["index"]))}
        with self._snapshot_cache_lock:
            self._snapshot_cache[reference] = loaded
            self._snapshot_cache.move_to_end(reference)
            while len(self._snapshot_cache) > self._snapshot_cache_max:
                self._snapshot_cache.popitem(last=False)
        return loaded

    def save_snapshot(self, snapshot):
        index_fields = {"embeddings", "embeddingCount", "embeddingStatus", "hanaSyncStatus", "embeddingConfiguration"}
        data = {k: v for k, v in snapshot.items() if k not in index_fields}
        index = {k: v for k, v in snapshot.items() if k in index_fields}
        return self.put_json({"data": self.put_json(data), "index": self.put_json(index)})
