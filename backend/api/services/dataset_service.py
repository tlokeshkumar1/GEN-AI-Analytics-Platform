"""Persistent, immutable dataset versions and their matching RAG indexes."""
import io
import copy
import hashlib
import json
import math
import os
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from fastapi import HTTPException
from api.models.execution_context import current_identity, current_selection, require_dataset_access, is_admin


import tempfile
from api.utils.logger import get_logger
logger = get_logger("datasets")
OUTPUT_DIR = Path(tempfile.gettempdir()) / "platform_runtime"


class DatasetService:
    def __init__(self, output_dir=OUTPUT_DIR, default_async_index=True, repository=None):
        self.output_dir = Path(output_dir)
        self.catalog_path = self.output_dir / "datasets.json"
        self.default_async_index = default_async_index
        self._lock = threading.RLock()
        self._snapshot_cache = {}
        self._cache_lock = threading.Lock()
        self._bg_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="dataset-indexer")
        self._active_futures = []
        self._futures_lock = threading.Lock()
        self.repository = None if repository is False else repository
        if repository is not False and self.repository is None and (os.getenv("PLATFORM_DATASET_BACKEND") == "durable" or os.getenv("VCAP_APPLICATION")):
            from api.platform.storage import DatasetRepository
            self.repository = DatasetRepository()

    @contextmanager
    def _writer(self):
        from api.platform.ai_settings import ai_settings, current_ai_settings
        token = current_ai_settings.set(ai_settings())
        try:
            with self._storage_writer():
                yield
        finally:
            current_ai_settings.reset(token)

    @contextmanager
    def _storage_writer(self):
        """Serialize writers across threads and API worker processes."""
        if self.repository is not None:
            with self.repository.writer():
                yield
            return
        self.output_dir.mkdir(parents=True, exist_ok=True)
        with self._lock, (self.output_dir / ".datasets.lock").open("a+b") as handle:
            handle.seek(0)
            if not handle.read(1):
                handle.write(b"0")
            handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                except OSError as exc:
                    raise HTTPException(503, "Another dataset update is still processing. Please retry shortly.") from exc
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _catalog(self):
        if self.repository is not None:
            return self.repository.catalog()
        try:
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            hana_cat = datasets_metadata_repo.get_catalog(seed_fallback_path=self.catalog_path)
            if hana_cat is not None:
                return hana_cat
        except Exception:
            pass
        if self.catalog_path.exists():
            return json.loads(self.catalog_path.read_text(encoding="utf-8"))
        return {"datasets": {}, "activeDatasetId": None, "importedFiles": []}

    def _write_json(self, path, value):
        if self.repository is not None and path == self.catalog_path:
            self.repository.publish(value)
            return
        if path == self.catalog_path:
            try:
                from api.platform.datasets_metadata_repository import datasets_metadata_repo
                datasets_metadata_repo.save_catalog(value)
            except Exception:
                pass
        import time
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            for attempt in range(5):
                try:
                    os.replace(temporary, path)
                    break
                except (PermissionError, OSError):
                    if attempt == 4:
                        raise
                    time.sleep(0.05)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def parse_file(content, filename):
        from api.utils.validation import validate_excel_file
        validate_excel_file(filename)
        if not content:
            raise HTTPException(400, "The uploaded file is empty.")
        from api.platform.ingestion import ingestion_service
        df, _ = ingestion_service.prepare(content, filename)
        df.columns = [str(c).strip() for c in df.columns]
        if not len(df.columns) or len(set(df.columns)) != len(df.columns):
            raise HTTPException(400, "Dataset must have unique, non-empty column names.")
        if any(not c or c == "__rowId" for c in df.columns):
            raise HTTPException(400, "Invalid or reserved column name: __rowId.")
        return df

    @staticmethod
    def _safe_name(filename):
        name = str(filename or "").replace("\\", "/").split("/")[-1]
        stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", Path(name).stem).strip(" .")
        # A frontend upload named Sales_V2 belongs to the Sales dataset.
        stem = re.sub(r"_V\d+$", "", stem, flags=re.IGNORECASE)
        if not stem or stem.upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}:
            raise HTTPException(400, "Please use a valid dataset filename.")
        return stem[:120], Path(name).suffix.lower()

    @staticmethod
    def _columns(df):
        if df.attrs.get("columns"):
            return copy.deepcopy(df.attrs["columns"])
        return [{"name": c, "type": "number" if pd.api.types.is_numeric_dtype(df[c]) else
                 "date" if pd.api.types.is_datetime64_any_dtype(df[c]) else "string",
                 "required": False} for c in df.columns]

    @staticmethod
    def _excel_export(df):
        """Excel binary numbers cannot preserve arbitrary Decimal/large integer precision."""
        from decimal import Decimal
        from numbers import Integral
        def value(cell):
            if isinstance(cell, Decimal) or isinstance(cell, Integral) and abs(cell) >= 10**15:
                return str(cell)
            if isinstance(cell, (datetime, pd.Timestamp)) and cell.tzinfo is not None:
                return cell.isoformat()
            return cell
        return df.map(value)

    def _snapshot(self, entry, version=None):
        number = entry["currentVersion"] if version is None else version
        if not any(v["version"] == number for v in entry["versions"]):
            raise HTTPException(404, "Dataset version not found.")
        if self.repository is not None:
            item = next(v for v in entry["versions"] if v["version"] == number)
            if not item.get("snapshotKey"):
                raise HTTPException(409, "Migrate this dataset version to durable storage before use.")
            return self.repository.snapshot(item["snapshotKey"])
        cache_key = (entry["id"], number)
        with self._cache_lock:
            if cache_key in self._snapshot_cache:
                return self._snapshot_cache[cache_key]

        path = self.output_dir / entry["folder"] / f".version_{number}.json"
        if not path.exists():
            cols = []
            try:
                from api.platform.datasets_metadata_repository import datasets_metadata_repo
                hint = entry.get("physical_table_name") or entry.get("name")
                cols = datasets_metadata_repo.load_schema_from_hana(hint)
            except Exception:
                pass
            if not cols:
                try:
                    from api.models.database_models import SalesRecord
                    cols = [{"name": col, "type": "number" if "USD" in col or "Percent" in col or "Quantity" in col else "string", "required": False} for col in SalesRecord.model_fields.keys()]
                except Exception:
                    cols = []
            if cols:
                snap = {
                    "rows": [],
                    "columns": cols,
                    "chunks": [],
                    "embeddings": [],
                    "embeddingCount": 0,
                    "embeddingStatus": "Ready",
                    "hanaSyncStatus": "Ready",
                    "embeddingConfiguration": self._embedding_configuration()
                }
                with self._cache_lock:
                    self._snapshot_cache[cache_key] = snap
                return snap
            raise HTTPException(404, "Dataset version snapshot not found.")

        mtime = path.stat().st_mtime
        cache_key = (entry["id"], number, mtime)

        with self._cache_lock:
            if cache_key in self._snapshot_cache:
                return self._snapshot_cache[cache_key]

        data = json.loads(path.read_text(encoding="utf-8"))
        with self._cache_lock:
            while len(self._snapshot_cache) >= 20:
                self._snapshot_cache.pop(next(iter(self._snapshot_cache)), None)
            self._snapshot_cache[cache_key] = data
        return data

    @staticmethod
    def _entry(catalog, dataset_id):
        entry = catalog["datasets"].get(dataset_id)
        if entry is None:
            raise HTTPException(404, "Dataset not found.")
        require_dataset_access(entry)
        return entry

    def _item(self, entry, active_id=None):
        snap = self._snapshot(entry)
        version = next(v for v in entry["versions"] if v["version"] == entry["currentVersion"])
        file_path = self.output_dir / entry["folder"] / version["filename"]
        size_bytes = version.get("sizeBytes", 0)
        if self.repository is None and file_path.exists():
            try:
                size_bytes = file_path.stat().st_size
            except Exception:
                pass
        return {"id": entry["id"], "name": entry["name"], "description": "Uploaded dataset",
                "rowCount": version.get("rowCount") or len(snap.get("rows", [])), "columnCount": len(snap["columns"]),
                "columns": snap["columns"], "lastUpdated": entry["updatedAt"],
                "format": Path(version["filename"]).suffix[1:], "source": "External connection" if version.get("sourceId") else "File upload",
                "sizeBytes": size_bytes,
                "status": "Ready", "currentVersion": entry["currentVersion"],
                "currentFilename": version["filename"], "versions": entry["versions"],
                "embeddingStatus": snap["embeddingStatus"], "embeddingCount": snap["embeddingCount"],
                "hanaSyncStatus": snap.get("hanaSyncStatus", "Pending"),
                "isActive": entry["id"] == active_id}

    @staticmethod
    def _format_row_chunk(row, columns, filename=None):
        parts = []
        for col in columns:
            val = row.get(col)
            if val is None or val == "" or str(val).strip().lower() in ("nan", "none", "null"):
                continue
            if isinstance(val, float) and val.is_integer():
                val = int(val)
            col_label = str(col).replace("_", " ").strip()
            parts.append(f"{col_label}: {val}")
        body = ". ".join(parts) + "." if parts else "Empty record."
        if filename:
            return f"Source: {filename}. {body}"
        return body

    def _chunks(self, df, filename, rows):
        """Format each individual row as an independent, high-precision semantic vector chunk."""
        columns = list(df.columns)
        return [self._format_row_chunk(row, columns, filename) for row in rows]

    def _index(self, chunks, previous=None):
        from api.services.embedding_service import embedding_service
        from api.utils.logger import get_logger
        try:
            reusable = dict(zip(previous["chunks"], previous["embeddings"])) if previous and previous["embeddingStatus"] == "Ready" and previous.get("embeddingConfiguration") == self._embedding_configuration() else {}
            missing = list(dict.fromkeys(chunk for chunk in chunks if chunk not in reusable))
            if missing:
                reusable.update(zip(missing, embedding_service.batch_embeddings(missing)))
            vectors = [reusable[chunk] for chunk in chunks]
            if len(vectors) != len(chunks) or any(not v or not all(math.isfinite(x) for x in v) for v in vectors):
                raise ValueError("Embedding provider returned invalid vectors")
            return vectors, "Ready"
        except Exception:
            get_logger("datasets").exception("Embedding generation failed; current source text remains available for retrieval")
            return [], "Error"

    @staticmethod
    def _sync_hana(entry, number, chunks, vectors, previous_version=None, previous_chunks=None):
        if not vectors:
            return "Pending"
        from api.utils.logger import get_logger
        try:
            from api.database.vector_client import vector_client
            vector_client.replace_dataset_version(
                DatasetService._vector_namespace(entry), number, chunks, vectors, entry["name"],
                previous_version=previous_version,
                previous_chunks=previous_chunks,
                metadata_extra={"workspace_id": entry.get("workspaceId"), "dataset_id": entry["id"], "embedding_configuration": DatasetService._embedding_configuration()}
            )
            return "Ready"
        except Exception:
            get_logger("datasets").exception("HANA sync failed; using the persistent version index for retrieval")
            return "Error"

    def _submit_indexing(self, dataset_id: str, version: int):
        """Submit background vector indexing task."""
        from contextvars import copy_context
        from api.platform.ai_settings import ai_settings, current_ai_settings
        context = copy_context()
        context.run(current_ai_settings.set, ai_settings())
        context.run(current_selection.set, None)
        if self.repository is not None:
            from api.platform.jobs import JobService
            return context.run(JobService(store=self.repository.store, datasets=self).enqueue,
                "index", {"dataset_id": dataset_id, "version": version},
                f"index:{dataset_id}:{version}:{json.dumps(self._embedding_configuration(), sort_keys=True)}")
        with self._futures_lock:
            self._active_futures = [f for f in self._active_futures if not f.done()]
            future = self._bg_executor.submit(context.run, self._async_index_version, dataset_id, version)
            self._active_futures.append(future)
            return future

    def wait_for_idle(self, timeout: float = 15.0):
        """Wait for all pending background indexing tasks to complete."""
        with self._futures_lock:
            pending = [f for f in self._active_futures if not f.done()]
        for f in pending:
            try:
                f.result(timeout=timeout)
            except Exception:
                pass

    def _async_index_version(self, dataset_id: str, version: int):
        """Background worker: generates embeddings and synchronizes with SAP HANA."""
        if self.repository is not None:
            return self._index_durable_version(dataset_id, version)
        catalog = self._catalog()
        entry = catalog["datasets"].get(dataset_id)
        if not entry:
            return

        folder = self.output_dir / entry["folder"]
        snap_path = folder / f".version_{version}.json"
        if not snap_path.exists():
            return

        from api.utils.logger import get_logger
        logger = get_logger("datasets")
        try:
            snap = json.loads(snap_path.read_text(encoding="utf-8"))
            snap["embeddingStatus"] = "Indexing"
            self._write_json(snap_path, snap)
            self._invalidate()

            # Find previous version snapshot for incremental embedding reuse and HANA delta sync
            previous = None
            prev_v = None
            prev_versions = [v["version"] for v in entry["versions"] if v["version"] < version]
            if prev_versions:
                prev_v = max(prev_versions)
                prev_snap_path = folder / f".version_{prev_v}.json"
                if prev_snap_path.exists():
                    try:
                        previous = json.loads(prev_snap_path.read_text(encoding="utf-8"))
                    except Exception:
                        previous = None

            vectors, embedding_status = self._index(snap["chunks"], previous)
            hana_status = self._sync_hana(
                entry, version, snap["chunks"], vectors,
                previous_version=prev_v if (previous and previous.get("embeddingStatus") == "Ready") else None,
                previous_chunks=previous.get("chunks") if previous else None
            )

            snap.update(
                embeddings=vectors,
                embeddingCount=len(vectors),
                embeddingStatus=embedding_status,
                hanaSyncStatus=hana_status,
                embeddingConfiguration=self._embedding_configuration()
            )
            self._write_json(snap_path, snap)
            self._invalidate()
            logger.info(f"[Indexer] Version {version} for dataset {dataset_id} indexed: {len(vectors)} embeddings, HANA: {hana_status}")
        except Exception as exc:
            logger.exception(f"[Indexer] Failed to index dataset {dataset_id} v{version}: {exc}")

    def _prune_old_versions(self, catalog, entry, max_versions=None):
        """Prune oldest non-active versions beyond max_versions to prevent disk bloat."""
        if max_versions is None:
            max_versions = int(os.getenv("MAX_VERSIONS_PER_DATASET", "0"))
            identity = current_identity.get()
            if identity is not None:
                from api.platform.store import metadata_store
                row = metadata_store().get(identity["workspace_id"] + ":settings", "retention")
                if row:
                    max_versions = row["value"]["max_versions"]
        if max_versions <= 0:
            return  # Preserve history unless an explicit retention policy is configured.
        versions = entry.get("versions", [])
        if len(versions) <= max_versions:
            return

        current_v = entry.get("currentVersion")
        folder = self.output_dir / entry["folder"]
        candidates = [v for v in versions if v["version"] != current_v]
        if current_identity.get() is not None:
            # Reviewed semantic revisions and their dependent dashboards remain historical evidence.
            from api.platform.semantic import semantic_registry
            candidates = [v for v in candidates if not semantic_registry.list(entry, v["version"])]
        to_prune_count = len(versions) - max_versions
        to_prune = candidates[:to_prune_count]

        pruned = set()
        for v in to_prune:
            v_num = v["version"]
            if self.repository is None:
                snap_path = folder / f".version_{v_num}.json"
                if snap_path.exists():
                    snap_path.unlink(missing_ok=True)
                raw_path = folder / v["filename"]
                if raw_path.exists():
                    raw_path.unlink(missing_ok=True)
            try:
                from api.database.vector_client import vector_client
                vector_client.delete_dataset_version(entry["id"], v_num)
            except Exception:
                pass
            pruned.add(v_num)

        if pruned:
            entry["versions"] = [v for v in versions if v["version"] not in pruned]
            catalog["datasets"][entry["id"]] = entry
            self._write_json(self.catalog_path, catalog)

    def _save_version(self, catalog, entry, df, rows, operation, original=None, index=True, extension=None, provenance=None):
        columns = self._columns(df)
        previous = self._snapshot(entry) if entry["versions"] else None
        before = {row["__rowId"]: row for row in previous["rows"]} if previous else {}
        after = {row["__rowId"]: row for row in rows}
        shared = before.keys() & after.keys()
        changed = sum(before[key] != after[key] for key in shared)
        provenance = {**(provenance or {}), "schemaRevision": hashlib.sha256(json.dumps(columns, sort_keys=True).encode()).hexdigest(),
                      "transformationRevision": hashlib.sha256(json.dumps(df.attrs.get("transformation_plan"), sort_keys=True).encode()).hexdigest(),
                      "semanticRevision": None, "createdBy": (current_identity.get() or {}).get("user_id"),
                      "ingestionId": (provenance or {}).get("ingestionId") or "ing-" + uuid.uuid4().hex,
                      "counts": (provenance or {}).get("counts") or {"inserted": len(after.keys() - before.keys()), "deleted": len(before.keys() - after.keys()), "updated": changed, "unchanged": len(shared) - changed}}
        if not df.attrs.get("data_profile"):
            from api.services.analytics_engine import json_value
            df.attrs["data_profile"] = {"row_count": len(df), "duplicate_count": int(df.duplicated().sum()), "warnings": [], "rejected_rows": [],
                                        "source_hash": hashlib.sha256(json.dumps(rows, default=str, sort_keys=True).encode()).hexdigest(),
                                        "fields": [{"name": column["name"], "type": column["type"],
                                                    "missing_count": int(df[column["name"]].isna().sum()),
                                                    "distinct_count": int(df[column["name"]].nunique()),
                                                    "samples": [json_value(value) for value in df[column["name"]].head(5)], "warnings": []} for column in columns]}
        if self.repository is not None:
            return self._save_durable_version(catalog, entry, df, rows, operation, original, index, extension, provenance)
        folder = self.output_dir / entry["folder"]
        folder.mkdir(parents=True, exist_ok=True)
        # Include orphaned staged files when allocating, so a failed write is never overwritten.
        number = max([v["version"] for v in entry["versions"]] +
                     [int(p.stem.split("_")[-1]) for p in folder.glob(".version_*.json")] + [0]) + 1
        suffix = extension or Path(entry["name"]).suffix.lower()
        # Write edited legacy XLS content as XLSX; openpyxl cannot write XLS.
        if suffix == ".xls" and original is None:
            suffix = ".xlsx"
        filename = f"{entry['folder']}{'' if number == 1 else f'_V{number}'}{suffix}"
        path = folder / filename
        if original is not None:
            path.write_bytes(original)
        elif suffix == ".csv":
            df.to_csv(path, index=False)
        else:
            with path.open("wb") as handle:
                self._excel_export(df).to_excel(handle, index=False, engine="openpyxl")
        chunks = self._chunks(df, entry["name"], rows)
        previous = self._snapshot(entry) if entry["versions"] else None
        vectors, embedding_status = self._index(chunks, previous) if index else ([], "Pending")
        hana_status = self._sync_hana(entry, number, chunks, vectors) if index else "Pending"
        snap = {"rows": rows, "columns": self._columns(df), "chunks": chunks,
                "embeddings": vectors, "embeddingCount": len(vectors), "embeddingStatus": embedding_status,
                "hanaSyncStatus": hana_status, "embeddingConfiguration": self._embedding_configuration(),
                "dataProfile": df.attrs.get("data_profile"), "transformationPlan": df.attrs.get("transformation_plan")}
        self._write_json(folder / f".version_{number}.json", snap)
        now = datetime.now(timezone.utc).isoformat()
        entry["versions"].append({"version": number, "filename": filename, "createdAt": now,
                                  "rowCount": len(rows), "operation": operation, **(provenance or {})})
        entry.update(currentVersion=number, updatedAt=now)
        catalog["datasets"][entry["id"]] = entry
        catalog["activeDatasetId"] = entry["id"]
        self._write_json(self.catalog_path, catalog)
        self._invalidate()
        item = self._item(entry, entry["id"])
        warning = ""
        if embedding_status == "Error":
            warning = " Embeddings could not be generated; chat uses current source text. Retry indexing when the embedding service is available."
        elif embedding_status == "Pending":
            warning = " Vector indexing running in background."
        if hana_status == "Error":
            warning += " HANA sync is unavailable; chat uses the saved version embeddings."
        return {"success": True, "message": f"Saved {filename} ({len(rows)} rows)." + warning,
                "dataset": item, "version": number, "embeddings_generated": len(vectors)}

    @staticmethod
    def _embedding_configuration():
        from api.platform.ai_settings import ai_settings
        return {"model": ai_settings()["embedding_model"], "dimensions": 1536,
                "projection": "first_1536_dimensions", "documentInputType": "passage", "queryInputType": "query", "textTemplateRevision": 2}

    @staticmethod
    def _vector_namespace(entry):
        if not entry.get("workspaceId"):
            return entry["id"]
        workspace = hashlib.sha256(entry["workspaceId"].encode()).hexdigest()[:12]
        configuration = hashlib.sha256(json.dumps(DatasetService._embedding_configuration(), sort_keys=True).encode()).hexdigest()[:12]
        return f"w{workspace}:{entry['id']}:i{configuration}"

    @staticmethod
    def _rows(df):
        from api.services.analytics_engine import json_value
        rows = [{c: json_value(value) for c, value in row.items()} for row in df.to_dict(orient="records")]
        for row in rows:
            row["__rowId"] = uuid.uuid4().hex
        return rows

    @staticmethod
    def _frame(rows, columns):
        from decimal import Decimal
        from api.services.analytics_engine import decimal
        frame = pd.DataFrame([{c["name"]: r.get(c["name"]) for c in columns} for r in rows], columns=[c["name"] for c in columns])
        for column in columns:
            if column["type"] == "decimal":
                frame[column["name"]] = frame[column["name"]].map(lambda v: None if pd.isna(v) or v == "" else decimal(v))
            elif column["type"] == "number":
                def number(value):
                    if pd.isna(value) or value == "":
                        return None
                    result = decimal(value)
                    return int(result) if result == result.to_integral_value() else result
                values = [number(value) for value in frame[column["name"]]]
                frame[column["name"]] = pd.Series(values, dtype=object)
                if all(value is None or isinstance(value, int) and -(2**63) <= value < 2**63 for value in values):
                    frame[column["name"]] = pd.Series(values, dtype="Int64")
            elif column["type"] == "boolean":
                def boolean(value):
                    if pd.isna(value) or value == "":
                        return None
                    if str(value).lower() not in ("true", "false"):
                        raise ValueError("Boolean values must be true or false")
                    return str(value).lower() == "true"
                frame[column["name"]] = frame[column["name"]].map(boolean)
            elif column["type"] == "date":
                frame[column["name"]] = pd.to_datetime(frame[column["name"]], errors="raise")
        frame.attrs["columns"] = copy.deepcopy(columns)
        return frame

    @staticmethod
    def _invalidate():
        # Disk is authoritative, including after restart or a change by another worker.
        from api.services.excel_dataset_service import excel_dataset_service
        from api.services.schema_service import schema_service
        excel_dataset_service._df = None
        schema_service._metadata = None
        from api.services.vector_service import vector_service
        vector_service.clear_cache()
        dataset_service._snapshot_cache.clear()
        try:
            from api.routes.dashboard import clear_dashboard_cache
            clear_dashboard_cache()
            from api.platform.planning import clear_intent_cache
            clear_intent_cache()
        except Exception:
            pass

    def _import_legacy(self):
        catalog = self._catalog()
        if not self.output_dir.exists():
            return
        pending = [p for p in self.output_dir.iterdir() if p.is_file() and p.suffix.lower() in {".csv", ".xlsx", ".xls"}
                   and not p.name.startswith("~$") and p.name not in catalog["importedFiles"]]
        if not pending:
            return
        with self._writer():
            catalog = self._catalog()
            changed = False
            for path in sorted(self.output_dir.iterdir()):
                if not path.is_file() or path.suffix.lower() not in {".csv", ".xlsx", ".xls"} or path.name.startswith("~$") or path.name in catalog["importedFiles"]:
                    continue
                df = self.parse_file(path.read_bytes(), path.name)
                stem, suffix = self._safe_name(path.name)
                entry = next((d for d in catalog["datasets"].values() if d["folder"].casefold() == stem.casefold()), None)
                if entry is None:
                    entry = {"id": "ds-" + uuid.uuid4().hex, "folder": stem, "name": stem + suffix, "versions": []}
                    self._save_version(catalog, entry, df, self._rows(df), "import", path.read_bytes(), index=False)
                catalog["importedFiles"].append(path.name)
                changed = True
            if changed:
                self._write_json(self.catalog_path, catalog)

    def list_datasets(self):
        if current_identity.get() is None and self.repository is None:
            self._import_legacy()  # CLI/test compatibility; HTTP reads never migrate data.
        catalog = self._catalog()
        visible = []
        for entry in catalog["datasets"].values():
            try:
                require_dataset_access(entry)
            except HTTPException:
                continue
            visible.append(self._item(entry, catalog["activeDatasetId"]))
        return visible

    def upload(self, content, filename, async_index=None, transformation_plan=None, ingestion_id=None, target_dataset_id=None, source_id=None):
        if async_index is None:
            async_index = self.default_async_index
        if transformation_plan is None:
            df = self.parse_file(content, filename)
        else:
            from api.platform.ingestion import ingestion_service
            df, _ = ingestion_service.prepare(content, filename, transformation_plan)
        stem, suffix = self._safe_name(filename)
        if source_id and not target_dataset_id:
            stem = stem + "_" + source_id[:8]
        with self._writer():
            catalog = self._catalog()
            if target_dataset_id:
                entry = self._entry(catalog, target_dataset_id)
            else:
                entry = next((d for d in catalog["datasets"].values() if d["folder"].casefold() == stem.casefold()), None)
            if ingestion_id:
                receipt = self._ingestion_receipt(catalog, ingestion_id)
                if receipt:
                    return receipt
            if entry is None:
                entry = {"id": "ds-" + uuid.uuid4().hex, "folder": stem, "name": stem + suffix, "versions": []}
                identity = current_identity.get()
                if identity:
                    entry.update(workspaceId=identity["workspace_id"], ownerId=identity["user_id"], readers=[], writers=[])
            else:
                require_dataset_access(entry, write=True)
            # Re-upload is a complete replacement snapshot; append has its own endpoint.
            result = self._save_version(catalog, entry, df, self._rows(df), "upload", content,
                                        index=not async_index, extension=suffix,
                                        provenance={"ingestionId": ingestion_id, "sourceId": source_id})
            dataset_id = entry["id"]
            version = result["version"]
            self._prune_old_versions(catalog, entry)

        if async_index:
            self._submit_indexing(dataset_id, version)

        return result

    def data(self, dataset_id, page=1, page_size=10, sort_field=None, sort_dir="asc", search="", version=None):
        catalog = self._catalog()
        entry = self._entry(catalog, dataset_id)
        if version is not None:
            self._snapshot(entry, version)
            entry = copy.deepcopy(entry)
            entry["currentVersion"] = version
        snap = self._snapshot(entry)
        if not snap.get("rows"):
            try:
                from api.platform.datasets_metadata_repository import datasets_metadata_repo
                table_name = entry.get("physical_table_name") or entry.get("folder") or entry.get("name")
                rows, cols = datasets_metadata_repo.load_rows_from_hana(table_name)
                if rows:
                    snap["rows"] = rows
                    if cols and not snap.get("columns"):
                        snap["columns"] = cols
            except Exception:
                pass
        rows = [dict(r, id=r["__rowId"]) if "id" not in r else dict(r) for r in snap.get("rows", [])]
        if search.strip():
            visible_columns = [c["name"] for c in snap["columns"]]
            rows = [r for r in rows if any(search.strip().casefold() in str(r.get(c, "")).casefold() for c in visible_columns)]
        if sort_field:
            if sort_field not in {c["name"] for c in snap["columns"]}:
                raise HTTPException(400, "Unknown sort column.")
            rows = sorted(rows, key=lambda r: (r.get(sort_field) is None,
                          0 if isinstance(r.get(sort_field), (int, float)) else 1,
                          r.get(sort_field) if isinstance(r.get(sort_field), (int, float)) else str(r.get(sort_field, ""))), reverse=sort_dir == "desc")
        return {"dataset": self._item(entry, catalog["activeDatasetId"]), "rows": rows[(page-1)*page_size:page*page_size],
                "totalRows": len(rows), "page": page, "pageSize": page_size, "totalPages": max(1, math.ceil(len(rows)/page_size))}

    def mutate(self, dataset_id, operation, payload, async_index=None, expected_version=None):
        if async_index is None:
            async_index = self.default_async_index
        with self._writer():
            catalog = self._catalog()
            entry = self._entry(catalog, dataset_id)
            require_dataset_access(entry, write=True)
            if expected_version is not None and entry["currentVersion"] != expected_version:
                raise HTTPException(409, "The dataset changed after you opened it. Refresh before saving edits.")
            snap = self._snapshot(entry)
            rows, columns = copy.deepcopy(snap["rows"]), copy.deepcopy(snap["columns"])

            # Ensure rows and columns are loaded from physical HANA table if not present in snap
            if not rows:
                try:
                    from api.platform.datasets_metadata_repository import datasets_metadata_repo
                    table_name = entry.get("physical_table_name") or entry.get("folder") or entry.get("name")
                    hana_rows, hana_cols = datasets_metadata_repo.load_rows_from_hana(table_name)
                    if hana_rows:
                        rows = copy.deepcopy(hana_rows)
                        if hana_cols and not columns:
                            columns = hana_cols
                except Exception:
                    pass

            names = {c["name"] for c in columns}
            if operation == "append":
                if not payload:
                    raise HTTPException(400, "No rows to append.")
                for incoming in payload:
                    unknown = set(incoming) - names - {"id", "__rowId"}
                    missing = names - set(incoming)
                    if unknown or missing:
                        raise HTTPException(400, f"Schema mismatch. Missing: {sorted(missing)}; extra: {sorted(unknown)}")
                    rows.append({**{k: incoming.get(k) for k in names}, "__rowId": uuid.uuid4().hex})
            else:
                lookup = {}
                for r in rows:
                    if r.get("__rowId"):
                        lookup[str(r["__rowId"])] = r
                    if r.get("id"):
                        lookup[str(r["id"])] = r
                    for pk_cand in ["ORDERID", "OrderID", "order_id"]:
                        if r.get(pk_cand):
                            lookup[str(r[pk_cand])] = r

                ids = []
                for r in payload:
                    if operation == "edit":
                        found_id = str(r.get("__rowId") or r.get("id") or r.get("ORDERID") or r.get("OrderID") or "")
                        ids.append(found_id)
                    else:
                        ids.append(str(r))

                if not ids or len(set(ids)) != len(ids) or any(i not in lookup for i in ids):
                    raise HTTPException(400, "Select valid, unique row IDs.")
                if operation == "edit":
                    for incoming, row_id in zip(payload, ids):
                        if set(incoming) - names - {"id", "__rowId"}:
                            raise HTTPException(400, "Unknown dataset column.")
                        target_row = lookup.get(row_id)
                        if target_row is not None:
                            target_row.update({k: v for k, v in incoming.items() if k in names})
                elif operation == "delete_rows":
                    rows = [r for r in rows if str(r.get("__rowId")) not in set(ids) and str(r.get("ORDERID")) not in set(ids)]

            # ── 1. Direct Physical SAP HANA Cloud Table Update ──
            try:
                from api.platform.datasets_metadata_repository import datasets_metadata_repo
                from api.database.hana_client import hana_client
                phys_table = datasets_metadata_repo._resolve_physical_table(entry.get("physical_table_name") or entry.get("folder") or entry.get("name"))
                if phys_table and hana_client:
                    col_names = [c["name"] for c in columns]
                    pk_cands = ["ORDERID", "OrderID", "ORDER_ID", "ID", "id"]
                    pk_col = next((c for c in col_names if c.upper() in pk_cands), col_names[0] if col_names else None)

                    if operation == "edit" and pk_col:
                        for row_edit in payload:
                            target_pk = row_edit.get(pk_col) or row_edit.get(pk_col.upper()) or row_edit.get("__rowId") or row_edit.get("id")
                            if target_pk is not None:
                                update_fields = [k for k in row_edit.keys() if k in names and k.upper() != pk_col.upper() and k != "__rowId" and k != "id"]
                                if update_fields:
                                    set_clause = ", ".join([f'"{f.upper()}" = ?' for f in update_fields])
                                    sql = f'UPDATE "{phys_table}" SET {set_clause} WHERE "{pk_col.upper()}" = ?'
                                    params = tuple(row_edit[f] for f in update_fields) + (str(target_pk),)
                                    hana_client.execute_query(sql, params)
                                    logger.info(f"Updated record {target_pk} directly in HANA table {phys_table}")
                    elif operation == "delete_rows" and pk_col:
                        for row_id in ids:
                            sql = f'DELETE FROM "{phys_table}" WHERE "{pk_col.upper()}" = ?'
                            hana_client.execute_query(sql, (str(row_id),))
                    elif operation == "append":
                        for row_add in payload:
                            insert_cols = [k for k in row_add.keys() if k in names and k != "__rowId" and k != "id"]
                            if insert_cols:
                                col_str = ", ".join([f'"{c.upper()}"' for c in insert_cols])
                                q_str = ", ".join(["?" for _ in insert_cols])
                                sql = f'INSERT INTO "{phys_table}" ({col_str}) VALUES ({q_str})'
                                hana_client.execute_query(sql, tuple(row_add[c] for c in insert_cols))
            except Exception as ex:
                logger.warning(f"Direct HANA physical table sync encountered error: {ex}")

            # ── 2. Direct Incremental VECTOR_TABLE Update (No 20k vector clone!) ──
            if operation == "edit":
                try:
                    from api.database.vector_client import vector_client
                    from api.services.ai_core_service import ai_core_service
                    for row_edit in payload:
                        target_pk = str(row_edit.get("ORDERID") or row_edit.get("OrderID") or row_edit.get("__rowId") or row_edit.get("id") or "")
                        full_row = lookup.get(target_pk) or row_edit
                        chunk_text = self._format_row_chunk(full_row, [c["name"] for c in columns], entry["name"])
                        emb = ai_core_service.generate_embedding(chunk_text)
                        vector_client.update_row_vector(dataset_id, target_pk, chunk_text, emb, {"source": entry["name"], "dataset_id": dataset_id})
                except Exception as ex:
                    logger.warning(f"Incremental vector update encountered error: {ex}")
            elif operation == "delete_rows":
                try:
                    from api.database.vector_client import vector_client
                    for row_id in ids:
                        vector_client.delete_row_vector(dataset_id, str(row_id))
                except Exception as ex:
                    logger.warning(f"Vector deletion encountered error: {ex}")

            try:
                df = self._frame(rows, columns)
            except (ValueError, TypeError):
                raise HTTPException(400, "Values do not match the dataset field types. Review the edited rows.") from None
            # Normalize numeric types while keeping stable row IDs.
            normalized = self._rows(df)
            for row, previous in zip(normalized, rows):
                row["__rowId"] = previous["__rowId"]
            result = self._save_version(catalog, entry, df, normalized, operation, index=False if operation == "edit" else not async_index)
            result.update(rowsUpdated=len(payload) if operation == "edit" else 0, rowsAppended=len(payload) if operation == "append" else 0,
                          totalRows=len(rows), remainingRows=len(rows))
            self._prune_old_versions(catalog, entry)
            version = result["version"]

            # ── 3. Carry Forward Semantic Model to New Version ──
            try:
                from api.platform.semantic import semantic_registry
                prev_models = semantic_registry.list(entry, entry["currentVersion"])
                if not prev_models and entry["versions"]:
                    for prev_v_info in reversed(entry["versions"]):
                        if prev_v_info["version"] != version:
                            prev_models = semantic_registry.list(entry, prev_v_info["version"])
                            if prev_models:
                                break
                if prev_models:
                    latest_model = sorted(prev_models, key=lambda m: m.get("revision", 1) if isinstance(m, dict) else getattr(m, "revision", 1))[-1]
                    overrides_dict = latest_model if isinstance(latest_model, dict) else latest_model.model_dump()
                    semantic_registry.propose(entry, version, snap, overrides=overrides_dict)
                    logger.info(f"Carried forward semantic model to version {version}")
            except Exception as exc:
                logger.warning(f"Could not carry forward semantic model: {exc}")

        if async_index and operation != "edit":
            self._submit_indexing(dataset_id, version)

        return result

    def restore(self, dataset_id, version):
        with self._writer():
            catalog = self._catalog()
            entry = self._entry(catalog, dataset_id)
            require_dataset_access(entry, write=True)
            self._snapshot(entry, version)  # Validate before publishing the pointer.
            entry.setdefault("audit", []).append({"action": "rollback", "fromVersion": entry["currentVersion"], "toVersion": version,
                                                  "userId": (current_identity.get() or {}).get("user_id"), "timestamp": datetime.now(timezone.utc).isoformat()})
            entry.update(currentVersion=version, updatedAt=datetime.now(timezone.utc).isoformat())
            catalog["activeDatasetId"] = dataset_id
            self._write_json(self.catalog_path, catalog)
            self._invalidate()
            return {"success": True, "message": f"Restored version {version}. Analytics and chat now use this version.",
                    "dataset": self._item(entry, dataset_id)}

    def activate(self, dataset_id):
        catalog = self._catalog()
        entry = self._entry(catalog, dataset_id)
        return {"success": True, "message": "Use the returned dataset version in your request context.", "dataset": self._item(entry, dataset_id)}

    def reindex(self, dataset_id):
        with self._writer():
            catalog = self._catalog()
            entry = self._entry(catalog, dataset_id)
            require_dataset_access(entry, write=True)
            snap = self._snapshot(entry)

            # Reconstruct chunks from row-level data if available or if transitioning to 1-row-per-chunk
            rows = snap.get("rows")
            if not rows:
                try:
                    from api.platform.datasets_metadata_repository import datasets_metadata_repo
                    hint = entry.get("physical_table_name") or entry.get("name")
                    hana_rows, _ = datasets_metadata_repo.load_rows_from_hana(hint)
                    if hana_rows:
                        rows = hana_rows
                        snap["rows"] = rows
                except Exception:
                    pass
                if not rows:
                    version = next((v for v in entry["versions"] if v["version"] == entry["currentVersion"]), None)
                    if version:
                        file_path = self.output_dir / entry["folder"] / version["filename"]
                        if file_path.exists():
                            try:
                                df = self.parse_file(file_path.read_bytes(), file_path.name)
                                rows = self._rows(df)
                                snap["rows"] = rows
                            except Exception:
                                pass

            if rows and snap.get("columns"):
                class ColumnsProxy:
                    columns = [c["name"] for c in snap["columns"]]
                snap["chunks"] = self._chunks(ColumnsProxy(), entry["name"], rows)

            vectors, status = self._index(snap["chunks"])
            if status != "Ready":
                raise HTTPException(503, "Embedding service unavailable. Dataset is still saved; please retry.")
            snap.update(embeddings=vectors, embeddingCount=len(vectors), embeddingStatus=status)
            snap["embeddingConfiguration"] = self._embedding_configuration()
            snap["hanaSyncStatus"] = self._sync_hana(entry, entry["currentVersion"], snap["chunks"], vectors)
            if self.repository is not None:
                version = next(v for v in entry["versions"] if v["version"] == entry["currentVersion"])
                version["snapshotKey"] = self.repository.save_snapshot(snap)
                self._write_json(self.catalog_path, catalog)
            else:
                self._write_json(self.output_dir / entry["folder"] / f".version_{entry['currentVersion']}.json", snap)
            self._invalidate()
            message = f"Current version embeddings refreshed ({len(vectors)} vectors)."
            if snap["hanaSyncStatus"] == "Error":
                message += " HANA sync unavailable; chat uses saved version embeddings."
            return {"success": True, "message": message, "dataset": self._item(entry, catalog["activeDatasetId"])}

    def delete(self, dataset_id):
        with self._writer():
            catalog = self._catalog()
            require_dataset_access(self._entry(catalog, dataset_id), write=True)
            del catalog["datasets"][dataset_id]
            if catalog["activeDatasetId"] == dataset_id:
                catalog["activeDatasetId"] = next(iter(catalog["datasets"]), None)
            self._write_json(self.catalog_path, catalog)
            self._invalidate()
            try:
                from api.database.vector_client import vector_client
                vector_client.delete_dataset(dataset_id)
            except Exception:
                pass
            return {"success": True, "message": "Dataset removed from analytics and chat."}

    def active(self):
        selection = current_selection.get()
        if selection is not None:
            return copy.deepcopy(selection.entry), copy.deepcopy(selection.snapshot)
        catalog = self._catalog()
        entry = catalog["datasets"].get(catalog["activeDatasetId"])
        return (entry, self._snapshot(entry)) if entry else (None, None)

    def active_path(self):
        selection = current_selection.get()
        if selection is not None:
            entry = selection.entry
            version = next(v for v in entry["versions"] if v["version"] == selection.context.version)
            return self.output_dir / entry["folder"] / version["filename"]
        catalog = self._catalog()
        entry = catalog["datasets"].get(catalog["activeDatasetId"])
        if not entry:
            return None
        version = next(v for v in entry["versions"] if v["version"] == entry["currentVersion"])
        return self.output_dir / entry["folder"] / version["filename"]

    def search(self, query, top_k):
        """Search SAP HANA Cloud Vector Engine directly for semantically nearest neighbor chunks and entity matches."""
        entry = None
        try:
            entry, _ = self.active()
        except Exception:
            pass

        dataset_id = entry["id"] if entry else None
        version = entry["currentVersion"] if entry else 1

        from api.services.embedding_service import embedding_service
        from api.database.vector_client import vector_client
        try:
            vector = embedding_service.get_embedding(query)
            results = vector_client.search_dataset_version(dataset_id, version, vector, top_k, text_query=query)
            if results:
                return results
        except Exception as exc:
            logger.warning(f"HANA Cloud vector retrieval failed: {exc}")

        # Fallback to local snapshot only if HANA Vector Engine is unreachable
        if entry:
            try:
                snap = self._snapshot(entry, version)
                words = set(re.findall(r"\w+", query.casefold()))
                scores = [len(words & set(re.findall(r"\w+", chunk.casefold()))) for chunk in snap.get("chunks", [])]
                indices = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
                return [{"ID": f"{entry['id']}:v{entry['currentVersion']}:{i}", "TEXT_CHUNK": snap["chunks"][i],
                         "SCORE": scores[i], "METADATA": json.dumps({"source": entry["name"], "dataset_id": entry["id"], "retrieval": "fallback"})}
                        for i in indices]
            except Exception:
                pass
        return []

    def _save_durable_version(self, catalog, entry, df, rows, operation, original, index, extension, provenance):
        number = max([v["version"] for v in entry["versions"]] + [0]) + 1
        suffix = extension or Path(entry["name"]).suffix.lower()
        if suffix == ".xls" and original is None:
            suffix = ".xlsx"
        filename = f"{entry['folder']}{'' if number == 1 else f'_V{number}'}{suffix}"
        chunks = self._chunks(df, entry["name"], rows)
        previous = self._snapshot(entry) if entry["versions"] else None
        vectors, status = self._index(chunks, previous) if index else ([], "Pending")
        hana_status = self._sync_hana(entry, number, chunks, vectors) if index else "Pending"
        snapshot = dict(rows=rows, columns=self._columns(df), chunks=chunks, embeddings=vectors,
                        embeddingCount=len(vectors), embeddingStatus=status, hanaSyncStatus=hana_status,
                        embeddingConfiguration=self._embedding_configuration(), dataProfile=df.attrs.get("data_profile"),
                        transformationPlan=df.attrs.get("transformation_plan"))
        if original is not None:
            raw = original
        elif suffix == ".csv":
            raw = df.to_csv(index=False).encode("utf-8")
        else:
            buffer = io.BytesIO()
            self._excel_export(df).to_excel(buffer, index=False, engine="openpyxl")
            raw = buffer.getvalue()
        raw_key = self.repository.objects.put(raw)
        reference = self.repository.save_snapshot(snapshot)
        now = datetime.now(timezone.utc).isoformat()
        entry["versions"].append(dict(version=number, filename=filename, createdAt=now, operation=operation,
                                      rowCount=len(rows), snapshotKey=reference, rawKey=raw_key, sizeBytes=len(raw), **(provenance or {})))
        entry.update(currentVersion=number, updatedAt=now)
        catalog["datasets"][entry["id"]] = entry
        catalog["activeDatasetId"] = entry["id"]
        self._write_json(self.catalog_path, catalog)
        return {"success": True, "message": f"Saved immutable data version {number}. Vector status: {status}.",
                "dataset": self._item(entry, entry["id"]), "version": number, "embeddings_generated": len(vectors)}

    def _index_durable_version(self, dataset_id, number):
        catalog = self._catalog()
        entry = catalog["datasets"].get(dataset_id)
        if entry is None or not any(v["version"] == number for v in entry["versions"]):
            return
        snapshot = self._snapshot(entry, number)
        previous_versions = [v["version"] for v in entry["versions"] if v["version"] < number]
        previous = self._snapshot(entry, max(previous_versions)) if previous_versions else None
        vectors, status = self._index(snapshot["chunks"], previous)
        hana_status = self._sync_hana(entry, number, snapshot["chunks"], vectors)
        snapshot.update(embeddings=vectors, embeddingCount=len(vectors), embeddingStatus=status, hanaSyncStatus=hana_status)
        snapshot["embeddingConfiguration"] = self._embedding_configuration()
        reference = self.repository.save_snapshot(snapshot)
        with self._writer():
            catalog = self._catalog()
            current = catalog["datasets"].get(dataset_id)
            if current is None:
                return
            version = next((v for v in current["versions"] if v["version"] == number), None)
            if version is not None:
                version["snapshotKey"] = reference
                self._write_json(self.catalog_path, catalog)

    def _ingestion_receipt(self, catalog, ingestion_id):
        for entry in catalog["datasets"].values():
            for version in entry["versions"]:
                if version.get("ingestionId") == ingestion_id:
                    require_dataset_access(entry, write=True)
                    pinned = copy.deepcopy(entry)
                    pinned["currentVersion"] = version["version"]
                    return {"success": True, "message": "Previously committed ingestion reused.", "dataset": self._item(pinned),
                            "version": version["version"], "embeddings_generated": self._snapshot(pinned).get("embeddingCount", 0)}
        return None

    def ingest_rows(self, dataset_id, incoming, mode, ingestion_id, source_id, keys=None, duplicate_policy="keep", deletion_field=None):
        """Atomic append/upsert with explicit source identities and idempotency receipt."""
        if mode not in ("append", "upsert") or duplicate_policy not in ("keep", "drop", "reject"):
            raise HTTPException(422, "Choose append/upsert and an explicit duplicate policy.")
        with self._writer():
            catalog = self._catalog()
            receipt = self._ingestion_receipt(catalog, ingestion_id)
            if receipt:
                return receipt
            entry = self._entry(catalog, dataset_id)
            require_dataset_access(entry, write=True)
            snapshot = self._snapshot(entry)
            rows = copy.deepcopy(snapshot["rows"])
            names = {column["name"] for column in snapshot["columns"]}
            incoming = copy.deepcopy(incoming)
            normalized = []
            for row in incoming:
                deleting = deletion_field is not None and row.get(deletion_field) is True
                if deletion_field and deletion_field in row and not isinstance(row[deletion_field], bool):
                    raise HTTPException(422, "Source deletion indicators must be boolean values.")
                fields = set(row) - ({deletion_field} if deletion_field else set())
                if fields != names and not (mode == "upsert" and deleting and keys and fields == set(keys)):
                    raise HTTPException(422, "Incoming fields do not match the dataset. Review the schema change before syncing.")
                try:
                    columns = [column for column in snapshot["columns"] if column["name"] in fields]
                    clean = self._rows(self._frame([row], columns))[0]
                    clean.pop("__rowId", None)
                except (ValueError, TypeError, OverflowError) as exc:
                    raise HTTPException(422, "Incoming values do not match the reviewed column types.") from exc
                if deletion_field:
                    clean[deletion_field] = deleting
                normalized.append(clean)
            incoming = normalized
            counts = dict(inserted=0, updated=0, deleted=0, unchanged=0)
            if mode == "upsert":
                if not keys or not set(keys) <= names:
                    raise HTTPException(422, "Upsert requires an approved stable key or composite key.")
                def key(row):
                    values = tuple(str(row.get(name)) for name in keys)
                    if any(row.get(name) is None or row.get(name) == "" for name in keys):
                        raise HTTPException(422, "Upsert keys cannot contain missing values.")
                    return values
                lookup = {key(row): row for row in rows}
                if len(lookup) != len(rows) or len({key(row) for row in incoming}) != len(incoming):
                    raise HTTPException(422, "The selected source key is not unique at this dataset grain.")
                numeric_fields = {column["name"] for column in snapshot["columns"] if column["type"] in ("number", "decimal")}
                def equivalent(previous, incoming_row):
                    from decimal import Decimal
                    for name in names:
                        left, right = previous.get(name), incoming_row.get(name)
                        if left is not None and right is not None and name in numeric_fields:
                            if Decimal(str(left)) != Decimal(str(right)):
                                return False
                        elif left != right:
                            return False
                    return True
                for row in incoming:
                    identity = key(row)
                    deleting = deletion_field is not None and row.pop(deletion_field, False) is True
                    previous = lookup.get(identity)
                    if deleting:
                        if previous:
                            del lookup[identity]; counts["deleted"] += 1
                        else:
                            counts["unchanged"] += 1
                    elif previous is None:
                        lookup[identity] = {**row, "__rowId": uuid.uuid4().hex}; counts["inserted"] += 1
                    elif equivalent(previous, row):
                        counts["unchanged"] += 1
                    else:
                        lookup[identity] = {**row, "__rowId": previous["__rowId"]}; counts["updated"] += 1
                rows = list(lookup.values())
            else:
                if deletion_field:
                    raise HTTPException(422, "Deletion events require upsert with stable source keys.")
                signatures = {json.dumps({name: row.get(name) for name in sorted(names)}, default=str, sort_keys=True) for row in rows}
                for row in incoming:
                    signature = json.dumps(row, default=str, sort_keys=True)
                    if signature in signatures and duplicate_policy != "keep":
                        if duplicate_policy == "reject":
                            raise HTTPException(409, "Duplicate incoming transaction requires review.")
                        counts["unchanged"] += 1
                        continue
                    rows.append({**row, "__rowId": uuid.uuid4().hex}); signatures.add(signature); counts["inserted"] += 1
            frame = self._frame(rows, snapshot["columns"])
            result = self._save_version(catalog, entry, frame, rows, mode, index=False,
                                        provenance={"ingestionId": ingestion_id, "sourceId": source_id, "counts": counts, "sourceKeys": keys})
            number = result["version"]
        self._submit_indexing(dataset_id, number)
        return result


dataset_service = DatasetService()
