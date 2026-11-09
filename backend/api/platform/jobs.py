"""Persisted, leased jobs with idempotent commits and cooperative cancellation."""
import csv
import hashlib
import io
import json
import os
import time
import threading
import uuid

from fastapi import HTTPException
from api.models.execution_context import current_identity, current_selection, require_admin
from api.platform.semantic import now
from api.platform.store import metadata_store


class JobService:
    def __init__(self, store=None, datasets=None, connections=None):
        self._store, self._datasets, self._connections = store, datasets, connections
        self._update_lock = threading.RLock()

    @property
    def store(self):
        return self._store or metadata_store()

    @property
    def datasets(self):
        if self._datasets is not None:
            return self._datasets
        from api.services.dataset_service import dataset_service
        return dataset_service

    @property
    def connections(self):
        if self._connections is not None:
            return self._connections
        from api.platform.connections import connection_service
        return connection_service

    def namespace(self, workspace=None):
        workspace = workspace or current_identity.get()["workspace_id"]
        return workspace + ":jobs"

    def enqueue(self, kind, payload, idempotency_key):
        identity = current_identity.get()
        if identity is None:
            raise HTTPException(401, "A verified account is required to schedule a job.")
        namespace = self.namespace()
        key = hashlib.sha256((identity["user_id"] + ":" + kind + ":" + idempotency_key).encode()).hexdigest()
        existing = self.store.get(namespace, key)
        if existing:
            if existing["value"]["payload"] != payload:
                raise HTTPException(409, "This idempotency key belongs to a different operation.")
            return {"id": key, **existing["value"]}
        from api.platform.ai_settings import ai_settings
        value = dict(kind=kind, payload=payload, identity=identity, ai_settings=ai_settings(), state="queued", stage="queued", attempts=0,
                     created_at=now(), updated_at=now(), lease_until=0, retry_at=0, error=None)
        self.store.put(namespace, key, value)
        return {"id": key, **value}

    def list(self):
        identity = current_identity.get()
        from api.models.execution_context import is_admin
        return [{"id": row["id"], **{k: v for k, v in row["value"].items() if k != "identity"}}
                for row in self.store.list(self.namespace())
                if row["value"]["identity"]["user_id"] == identity["user_id"] or is_admin(identity)]

    def get(self, key):
        identity = current_identity.get()
        from api.models.execution_context import is_admin
        row = self.store.get(self.namespace(), key)
        if row is None:
            raise HTTPException(404, "Job not found.")
        if row["value"]["identity"]["user_id"] != identity["user_id"] and not is_admin(identity):
            raise HTTPException(403, "This job belongs to another account.")
        return row

    def cancel(self, key):
        row = self.get(key)
        if row["value"]["state"] in ("succeeded", "cancelled", "failed"):
            raise HTTPException(409, "This job has already finished.")
        state = "cancelled" if row["value"]["state"] == "queued" else "cancel_requested"
        self.store.put(self.namespace(), key, {**row["value"], "state": state, "updated_at": now()}, row["revision"])
        return {"state": state}

    def retry(self, key):
        row = self.get(key)
        if row["value"]["state"] not in ("failed", "cancelled"):
            raise HTTPException(409, "Only failed or cancelled jobs can be retried.")
        self.store.put(self.namespace(), key, {**row["value"], "state": "queued", "lease_until": 0, "retry_at": 0, "error": None}, row["revision"])
        return {"state": "queued"}

    def _update(self, namespace, key, worker, **changes):
        with self._update_lock:
            return self._update_locked(namespace, key, worker, **changes)

    def _update_locked(self, namespace, key, worker, **changes):
        row = self.store.get(namespace, key)
        if row is None or row["value"].get("worker") != worker:
            raise HTTPException(409, "Job lease was lost.")
        if row["value"]["state"] == "cancel_requested" and changes.get("state") not in ("cancelled", "succeeded"):
            raise HTTPException(409, "Job cancellation requested.")
        self.store.put(namespace, key, {**row["value"], **changes, "updated_at": now(), "lease_until": time.time() + 180}, row["revision"])

    def run_next(self, workspace=None):
        workspace = workspace or os.getenv("PLATFORM_WORKSPACE_ID", "default")
        namespace = self.namespace(workspace)
        for candidate in self.store.list(namespace):
            job = candidate["value"]
            if not ((job["state"] == "queued" and job.get("retry_at", 0) <= time.time()) or
                    (job["state"] in ("running", "cancel_requested") and job.get("lease_until", 0) < time.time())):
                continue
            key, worker = candidate["id"], uuid.uuid4().hex
            resource = job["payload"].get("dataset_id") or job["payload"].get("binding_id") or key
            lock_namespace = workspace + ":job_locks"
            lock = self.store.get(lock_namespace, resource)
            if lock and lock["value"]["until"] > time.time():
                continue
            try:
                self.store.put(lock_namespace, resource, {"worker": worker, "until": time.time() + 180}, lock["revision"] if lock else 0)
                state = "cancelled" if job["state"] == "cancel_requested" else "running"
                self.store.put(namespace, key, {**job, "state": state, "worker": worker, "attempts": job["attempts"] + 1, "lease_until": time.time() + 180}, candidate["revision"])
            except HTTPException as exc:
                acquired = self.store.get(lock_namespace, resource)
                if acquired and acquired["value"].get("worker") == worker:
                    self.store.put(lock_namespace, resource, {"worker": worker, "until": 0}, acquired["revision"])
                if exc.status_code == 409:
                    continue
                raise
            identity_token = current_identity.set(job["identity"])
            selection_token = current_selection.set(None)
            from api.platform.ai_settings import current_ai_settings, ai_settings
            ai_token = current_ai_settings.set(job.get("ai_settings") or ai_settings())
            stopped = threading.Event()
            heartbeat = None
            try:
                if state == "cancelled":
                    return key
                def progress(stage, **values):
                    with self._update_lock:
                        self._update(namespace, key, worker, stage=stage, **values)
                        latest = self.store.get(lock_namespace, resource)
                        if latest["value"]["worker"] != worker:
                            raise HTTPException(409, "Dataset lease was lost.")
                        self.store.put(lock_namespace, resource, {"worker": worker, "until": time.time() + 180}, latest["revision"])
                def renew_lease():
                    while not stopped.wait(30):
                        try:
                            with self._update_lock:
                                self._update(namespace, key, worker)
                                latest = self.store.get(lock_namespace, resource)
                                if latest["value"]["worker"] != worker:
                                    return
                                self.store.put(lock_namespace, resource, {"worker": worker, "until": time.time() + 180}, latest["revision"])
                        except HTTPException:
                            return
                heartbeat = threading.Thread(target=renew_lease, daemon=True)
                heartbeat.start()
                progress("starting")
                if job["kind"] == "index":
                    payload = job["payload"]
                    entry = self.datasets._entry(self.datasets._catalog(), payload["dataset_id"])
                    self.datasets._async_index_version(entry["id"], payload["version"])
                    snapshot = self.datasets._snapshot(self.datasets._entry(self.datasets._catalog(), entry["id"]), payload["version"])
                    if snapshot["embeddingStatus"] != "Ready":
                        raise HTTPException(503, "Embedding generation did not complete. Retry when the provider is available.")
                    output = {"dataset_id": entry["id"], "version": payload["version"], "embedding_status": "Ready"}
                elif job["kind"] == "sync":
                    output = self._sync(job, key, progress)
                elif job["kind"] == "custom_chart":
                    from api.platform.custom_charts import generate_custom_chart
                    output = generate_custom_chart(job["payload"], self.datasets, progress)
                else:
                    raise ValueError("Unsupported job kind")
                self._update(namespace, key, worker, state="succeeded", stage="completed", result=output, error=None)
            except Exception as exc:
                row = self.store.get(namespace, key)
                cancelled = row["value"]["state"] == "cancel_requested"
                safe_error = exc.detail if isinstance(exc, HTTPException) and isinstance(exc.detail, str) else f"Job failed ({type(exc).__name__}). Check source configuration and retry."
                self._update(namespace, key, worker, state="cancelled" if cancelled else "failed", error=safe_error, stage="cancelled" if cancelled else "failed")
            finally:
                stopped.set()
                if heartbeat:
                    heartbeat.join(timeout=2)
                current_ai_settings.reset(ai_token)
                current_selection.reset(selection_token)
                current_identity.reset(identity_token)
                latest = self.store.get(lock_namespace, resource)
                if latest and latest["value"].get("worker") == worker:
                    self.store.put(lock_namespace, resource, {"worker": worker, "until": 0}, latest["revision"])
            return key
        return None

    def _sync(self, job, key, progress):
        payload = job["payload"]
        identity = current_identity.get()
        namespace = identity["workspace_id"] + ":bindings"
        row = self.store.get(namespace, payload["binding_id"])
        if row is None:
            raise HTTPException(404, "Source binding not found.")
        binding = row["value"]
        receipt = self.datasets._ingestion_receipt(self.datasets._catalog(), key)
        checkpoint = job.get("prepared_checkpoint", binding.get("checkpoint", {}))
        if receipt is None:
            progress("extracting")
            batches, checkpoint = [], binding.get("checkpoint", {})
            def cancelled():
                progress("extracting")
                return False
            with self.connections.open(binding["connection_id"], cancelled) as connector:
                if connector.config.get("incremental") is True and binding.get("mode", "replace") != "upsert":
                    raise HTTPException(422, "Incremental extraction requires upsert. A delta cannot replace the complete dataset.")
                for batch in connector.extract(binding["source"], checkpoint):
                    batches.append(batch)
                    if batch.checkpoint:
                        checkpoint = batch.checkpoint
                    progress("extracting", batches_read=len(batches))
            progress("validating", prepared_checkpoint=checkpoint)
            if not batches:
                return {"status": "unchanged", "dataset_id": binding.get("dataset_id")}
            file_batches = [batch for batch in batches if batch.content is not None]
            if file_batches:
                if len(batches) != 1:
                    raise HTTPException(422, "Bind one source file per dataset import.")
                content, filename = file_batches[0].content, file_batches[0].filename
                from api.platform.contracts import TransformationPlan
                plan = TransformationPlan.model_validate(binding.get("transformation_plan", {}))
                if binding.get("mode", "replace") != "replace":
                    from api.platform.ingestion import ingestion_service
                    frame, _ = ingestion_service.prepare(content, filename, plan)
                    records = [{k: v for k, v in row.items() if k != "__rowId"} for row in self.datasets._rows(frame)]
                else:
                    records = None
            else:
                records = [record for batch in batches for record in batch.records]
                if not records:
                    raise HTTPException(422, "The source returned no schema or records. Review an empty snapshot explicitly before replacement.")
                fields = list(records[0])
                mode = binding.get("mode", "replace")
                if any((mode == "replace" and set(record) != set(fields)) or any(isinstance(value, (dict, list)) for value in record.values()) for record in records):
                    raise HTTPException(422, "Map nested or inconsistent source fields into a flat table before ingestion.")
                from api.platform.contracts import TransformationPlan
                plan = TransformationPlan.model_validate(binding.get("transformation_plan", {}))
                filename = binding["name"] + ".csv"
                deletion_field = binding.get("deletion_field") if mode == "upsert" else None
                if deletion_field and any(deletion_field in record and not isinstance(record[deletion_field], bool) for record in records):
                    raise HTTPException(422, "Source deletion indicators must be boolean values.")
                deleted = [record for record in records if deletion_field and record.get(deletion_field) is True]
                regular = [{key: value for key, value in record.items() if key != deletion_field} for record in records if not deletion_field or record.get(deletion_field) is not True]
                if regular:
                    fields = list(regular[0])
                    if any(set(record) != set(fields) for record in regular):
                        raise HTTPException(422, "Source fields are inconsistent. Review field mapping before syncing.")
                    buffer = io.StringIO(); writer = csv.DictWriter(buffer, fields); writer.writeheader(); writer.writerows(regular)
                    content = buffer.getvalue().encode("utf-8")
                    if mode != "replace":
                        from api.platform.ingestion import ingestion_service
                        frame, _ = ingestion_service.prepare(content, filename, plan)
                        records = [{key: value for key, value in record.items() if key != "__rowId"} for record in self.datasets._rows(frame)] + deleted
                elif mode != "replace":
                    records = deleted
            progress("committing", prepared_checkpoint=checkpoint)
            if binding.get("mode", "replace") == "replace":
                receipt = self.datasets.upload(content, filename, async_index=True, transformation_plan=plan,
                                               ingestion_id=key, target_dataset_id=binding.get("dataset_id"), source_id=payload["binding_id"])
            else:
                if not binding.get("dataset_id"):
                    raise HTTPException(422, "Append and upsert require an existing target dataset.")
                receipt = self.datasets.ingest_rows(binding["dataset_id"], records, binding["mode"], key, payload["binding_id"],
                                                    binding.get("keys"), binding.get("duplicate_policy", "keep"), binding.get("deletion_field"))
        # Checkpoints move only after the dataset receipt was committed. Retrying reuses that receipt.
        latest = self.store.get(namespace, payload["binding_id"])
        self.store.put(namespace, payload["binding_id"], {**latest["value"], "dataset_id": receipt["dataset"]["id"],
                       "checkpoint": checkpoint, "last_ingestion_id": key, "last_synced_at": now()}, latest["revision"])
        return {"dataset_id": receipt["dataset"]["id"], "version": receipt["version"]}


job_service = JobService()
