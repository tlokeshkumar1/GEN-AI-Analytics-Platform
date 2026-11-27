"""Content-addressed durable objects and transactional dataset catalog manifests."""

import base64
import hashlib
import json
import os
import tempfile
import threading
import uuid
from copy import deepcopy
from concurrent.futures import Future, TimeoutError as FutureTimeout
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from fastapi import HTTPException

from api.platform.store import metadata_store


class ArtifactStore:
    OBJECT_NAMESPACE = "platform:objects"

    def __init__(self, backend=None, root=None):
        default_backend = (
            "hana"
            if os.getenv("PLATFORM_METADATA_BACKEND", "hana") == "hana"
            else "local"
        )
        self.backend = backend or os.getenv("PLATFORM_OBJECT_BACKEND", default_backend)
        self.root = Path(
            root
            or os.getenv(
                "PLATFORM_OBJECT_ROOT",
                str(Path(tempfile.gettempdir()) / "platform_runtime" / ".objects"),
            )
        )
        self.bucket = os.getenv("PLATFORM_OBJECT_BUCKET", "")
        if os.getenv("VCAP_APPLICATION") and self.backend == "local":
            raise RuntimeError(
                "Configure durable object storage before starting production ingestion"
            )

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

            return BlobServiceClient(
                account_url=os.environ["PLATFORM_AZURE_ACCOUNT_URL"],
                credential=DefaultAzureCredential(),
            )
        raise ValueError("Unsupported object storage backend")

    def put(self, content):
        key = "objects/" + hashlib.sha256(content).hexdigest()
        if self.backend == "local":
            destination = self.root / key
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                # Concurrent identical writes are safe; all keys are content hashes.
                temporary = destination.with_name(
                    destination.name + f".{uuid.uuid4().hex}.tmp"
                )
                temporary.write_bytes(content)
                os.replace(temporary, destination)
            return key
        if self.backend == "hana":
            store = metadata_store()
            if store.get(self.OBJECT_NAMESPACE, key) is None:
                payload = {
                    "encoding": "base64",
                    "data": base64.b64encode(content).decode("ascii"),
                }
                try:
                    store.put(self.OBJECT_NAMESPACE, key, payload, expected_revision=0)
                except HTTPException as exc:
                    # Content-addressed keys are immutable; a 409 means another writer stored the identical hash.
                    if exc.status_code != 409:
                        raise
            return key
        client = self._client()
        try:
            if self.backend == "s3":
                client.put_object(Bucket=self.bucket, Key=key, Body=content)
            elif self.backend == "gcs":
                client.bucket(self.bucket).blob(key).upload_from_string(content)
            else:
                client.get_blob_client(self.bucket, key).upload_blob(
                    content, overwrite=True
                )
        finally:
            if hasattr(client, "close"):
                client.close()
        return key

    def keys(self):
        if self.backend != "hana":
            raise ValueError("Artifact identifier lookup requires HANA storage")
        return metadata_store().keys(self.OBJECT_NAMESPACE)

    def get(self, key):
        if (
            not key.startswith("objects/")
            or len(key) != 72
            or any(c not in "0123456789abcdef" for c in key[8:])
        ):
            raise ValueError("Invalid artifact reference")
        if self.backend == "local":
            content = (self.root / key).read_bytes()
        elif self.backend == "hana":
            record = metadata_store().get(self.OBJECT_NAMESPACE, key)
            if record is None:
                raise FileNotFoundError(key)
            value = record["value"]
            content = (
                base64.b64decode(value["data"])
                if isinstance(value, dict)
                else value.encode("utf-8")
            )
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
                    content = (
                        client.get_blob_client(self.bucket, key)
                        .download_blob()
                        .readall()
                    )
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
        self.namespace = (
            workspace or os.getenv("PLATFORM_WORKSPACE_ID", "default")
        ) + ":datasets"
        self.cursor = ContextVar("dataset_catalog_transaction", default=None)
        self._snapshot_cache: OrderedDict[str, dict] = OrderedDict()
        self._snapshot_cache_lock = threading.Lock()
        self._snapshot_cache_max = 32
        self._snapshot_cache_bytes = 0
        self._snapshot_cache_max_bytes = 64 * 1024 * 1024
        self._snapshot_sizes = {}
        self._snapshot_loads = {}

    @contextmanager
    def writer(self):
        with self.store.transaction() as cursor:
            suffix = " FOR UPDATE" if self.store.backend == "hana" else ""
            cursor.execute(
                "SELECT REVISION FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'"
                + suffix,
                (self.namespace,),
            )
            cursor.fetchone()
            token = self.cursor.set(cursor)
            try:
                yield
            finally:
                self.cursor.reset(token)

    def catalog(self):
        cursor = self.cursor.get()
        if cursor is not None:
            cursor.execute(
                "SELECT REVISION, PAYLOAD FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'",
                (self.namespace,),
            )
            record = self.store._decode(cursor.fetchone())
        else:
            record = self.store.get(self.namespace, "catalog")
        return (
            record["value"]
            if record
            else {"datasets": {}, "activeDatasetId": None, "importedFiles": []}
        )

    def publish(self, catalog):
        cursor = self.cursor.get()
        if cursor is None:
            raise RuntimeError("Publishing requires a catalog transaction")
        cursor.execute(
            "SELECT REVISION FROM PLATFORM_DOCUMENTS WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'",
            (self.namespace,),
        )
        row = cursor.fetchone()
        payload = json.dumps(catalog, ensure_ascii=False, allow_nan=False)
        if row:
            cursor.execute(
                "UPDATE PLATFORM_DOCUMENTS SET PAYLOAD=?, REVISION=? WHERE NAMESPACE=? AND DOCUMENT_ID='catalog'",
                (payload, row[0] + 1, self.namespace),
            )
        else:
            cursor.execute(
                "INSERT INTO PLATFORM_DOCUMENTS (NAMESPACE, DOCUMENT_ID, REVISION, PAYLOAD) VALUES (?, 'catalog', 1, ?)",
                (self.namespace, payload),
            )

    def put_json(self, value):
        return self.objects.put(
            json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        )

    def snapshot(self, reference, *, include_index=True):
        """Share immutable reads, not mutable results or a lock held during I/O."""
        key = (reference, include_index)
        with self._snapshot_cache_lock:
            cached = self._snapshot_cache.get(key)
            if cached is not None:
                self._snapshot_cache.move_to_end(key)
            pending = self._snapshot_loads.get(key)
            leader = cached is None and pending is None
            if leader:
                pending = Future()
                self._snapshot_loads[key] = pending
        if cached is not None:
            return deepcopy(cached)
        if not leader:
            try:
                return deepcopy(pending.result(timeout=90))
            except FutureTimeout:
                raise HTTPException(
                    503, "Dataset loading timed out. Please retry."
                ) from None
        try:
            manifest = json.loads(self.objects.get(reference))
            data = self.objects.get(manifest["data"])
            loaded = json.loads(data)
            size = len(data)
            if include_index:
                index = self.objects.get(manifest["index"])
                loaded.update(json.loads(index))
                size += len(index)
            with self._snapshot_cache_lock:
                if size <= self._snapshot_cache_max_bytes:
                    self._snapshot_cache[key] = loaded
                    self._snapshot_sizes[key] = size
                    self._snapshot_cache_bytes += size
                    while (
                        len(self._snapshot_cache) > self._snapshot_cache_max
                        or self._snapshot_cache_bytes > self._snapshot_cache_max_bytes
                    ):
                        evicted, _ = self._snapshot_cache.popitem(last=False)
                        self._snapshot_cache_bytes -= self._snapshot_sizes.pop(evicted)
            pending.set_result(loaded)
            return deepcopy(loaded)
        except BaseException as exc:
            pending.set_exception(exc)
            raise
        finally:
            with self._snapshot_cache_lock:
                self._snapshot_loads.pop(key, None)

    def save_snapshot(self, snapshot):
        index_fields = {
            "embeddings",
            "embeddingCount",
            "embeddingStatus",
            "hanaSyncStatus",
            "embeddingConfiguration",
            "embeddingError",
            "embeddingTotal",
            "embeddingCheckpoint",
        }
        data = {k: v for k, v in snapshot.items() if k not in index_fields}
        index = {k: v for k, v in snapshot.items() if k in index_fields}
        return self.put_json(
            {"data": self.put_json(data), "index": self.put_json(index)}
        )
