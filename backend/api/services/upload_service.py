import io
import os
import re
import hashlib
from typing import Dict, Any, Optional, Callable
import pandas as pd

from api.services.dataset_service import dataset_service
from api.database.hana_table_service import hana_table_service
from api.platform.agent_preprocessing import preprocessing_agent
from api.platform.agent_domain_classifier import domain_classifier_agent
from api.platform.agent_chart_recommender import chart_recommender_agent
from api.platform.semantic import semantic_registry
from api.platform.workflow import workflow_orchestrator
from api.models.execution_context import current_identity
from api.utils.logger import get_logger

logger = get_logger("services.upload_service")


class UploadService:
    def process_file(
        self,
        content: bytes,
        filename: str,
        async_index: bool = None,
        transformation_plan=None,
        target_table_name: str = None,
        target_table_action: str = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """
        Orchestrate the 3-Agent Ingestion Pipeline:
        1. Agent 1: Data Preprocessing (remove duplicates, clean nulls, normalize formatting)
        2. Agent 2: 5-Row Domain Classifier & Semantic Modeling
        3. Dynamic HANA Storage: Persist clean data
        4. Agent 3: Visualization & Chart Recommendations
        """
        logger.info(f"[UploadService] Starting 3-agent ingestion for file: {filename}")
        filename = str(filename).replace("\\", "/").rsplit("/", 1)[-1]
        warnings = []

        def _emit(stage: int, status: str, message: str, data: Optional[Dict[str, Any]] = None) -> None:
            if progress_callback is None:
                return
            try:
                progress_callback({
                    "type": "stage",
                    "stage": stage,
                    "status": status,
                    "message": message,
                    "data": data or {},
                })
            except Exception as cb_exc:
                logger.debug(f"[UploadService] Progress callback error ignored: {cb_exc}")

        # ── STAGE 1 / AGENT 1: Parse + Preprocessing & Cleaning ─────────────
        _emit(1, "running", "Triggering Agent 1: Preprocessing...")
        try:
            if transformation_plan is None:
                df_raw = dataset_service.parse_file(content, filename)
            else:
                from api.platform.ingestion import ingestion_service
                df_raw, _ = ingestion_service.prepare(content, filename, transformation_plan)
        except Exception as e:
            logger.error(f"Error parsing raw file {filename}: {e}")
            raise

        logger.info("[UploadService] Triggering Agent 1: Preprocessing...")
        clean_df, audit = preprocessing_agent.clean(df_raw, transformation_plan.parsing if transformation_plan else None)
        if clean_df.empty or not len(clean_df.columns):
            _emit(1, 'failed', 'Preprocessing produced no usable rows or columns.')
            raise ValueError('The dataset contains no usable rows after preprocessing.')
        logger.info(f"[UploadService] Agent 1 finished: {audit.get('message')}")

        # Re-export clean dataframe to bytes for snapshot & vector generation
        clean_buffer = io.BytesIO()
        if filename.lower().endswith(".csv"):
            clean_df.to_csv(clean_buffer, index=False, encoding="utf-8")
        else:
            with pd.ExcelWriter(clean_buffer, engine="openpyxl") as writer:
                dataset_service._excel_export(clean_df).to_excel(writer, index=False)
        clean_content = clean_buffer.getvalue()

        _emit(
            1,
            "completed",
            audit.get("message") or "Preprocessing complete.",
            {"preprocessing_audit": audit, "rows_processed": len(clean_df)},
        )

        # ── STAGE 2 / AGENT 2: Dataset Indexing + Domain Classification ─────
        _emit(2, "running", "Triggering Agent 2: Domain Classifier...")

        # Step 1: Upload clean dataset version & create vector embeddings
        # Note: clean_content is already normalized by IngestionService.prepare() + Agent 1 into a clean
        # single-sheet table with row-1 headers, so raw sheet/header/transform options must not be re-applied.
        sheet_name = (
            transformation_plan.parsing.sheet
            if (transformation_plan and getattr(transformation_plan, 'parsing', None) and getattr(transformation_plan.parsing, 'sheet', None))
            else getattr(transformation_plan, 'sheet', None)
        )
        base_title = filename.rsplit('.', 1)[0]
        display_name = f"{base_title} - {sheet_name}" if sheet_name else (target_table_name or base_title)

        result = dataset_service.upload(
            clean_content,
            filename,
            async_index=async_index,
            transformation_plan=None,
            table_name=target_table_name,
            display_name=display_name,
            sheet_name=sheet_name,
            prepared_frame=clean_df,
        )
        dataset_entry = result["dataset"]
        dataset_id = dataset_entry["id"]
        version = result["version"]

        # Grant workspace-wide read access so User (Member) role can view datasets in
        # Executive Dashboard, Build Your KPI, and Data Explorer.
        try:
            with dataset_service._writer():
                cat = dataset_service._catalog()
                rentry = dataset_service._entry(cat, dataset_id)
                if not rentry.get("readers"):
                    rentry["readers"] = ["*"]
                    dataset_service._write_json(dataset_service.catalog_path, cat)
        except Exception as grant_exc:
            logger.debug(f"[UploadService] Note: Could not set default workspace readers: {grant_exc}")

        logger.info("[UploadService] Triggering Agent 2: Domain Classifier...")
        semantic_model = domain_classifier_agent.analyze(
            df=clean_df,
            dataset_id=dataset_id,
            data_version=version,
            dataset_name=display_name or filename,
        )
        domain = semantic_model.domain
        logger.info(f"[UploadService] Agent 2 finished: Classified as domain '{domain}' with {len(semantic_model.fields)} fields.")

        # Persist semantic model into platform store
        raw_entry = None
        persisted_model = None
        try:
            catalog = dataset_service._catalog()
            raw_entry = dataset_service._entry(catalog, dataset_id)
            snapshot = dataset_service._snapshot(raw_entry, version)
            persisted_model = semantic_registry.propose(raw_entry, version, snapshot, overrides=semantic_model.model_dump())
            if persisted_model.status != "approved" and os.getenv("PLATFORM_AUTO_APPROVE_SEMANTICS", "true").lower() == "true":
                persisted_model = semantic_registry.review(raw_entry, version, persisted_model.revision, "approved")
                workflow_orchestrator.save(
                    raw_entry,
                    version,
                    "semantic_review",
                    "completed",
                    {"semantic_revision": persisted_model.revision, "auto_approved": True},
                )
            semantic_model = persisted_model
            logger.info(f"[UploadService] Semantic model saved & directly approved (status={semantic_model.status}) for {dataset_id} v{version}")
            try:
                with dataset_service._writer():
                    cat = dataset_service._catalog()
                    rentry = dataset_service._entry(cat, dataset_id)
                    for v in rentry.get("versions", []):
                        if v.get("version") == version:
                            v["semanticRevision"] = persisted_model.revision
                    dataset_service._write_json(dataset_service.catalog_path, cat)
            except Exception as ex_cat:
                logger.debug(f"[UploadService] Could not persist semanticRevision to catalog: {ex_cat}")
        except Exception as exc:
            logger.warning(f"[UploadService] Note: Could not direct-approve model to registry: {exc}")
            warnings.append("Semantic model persistence failed; review and save the model before publishing.")

        _emit(
            2,
            "completed" if persisted_model is not None else "failed",
            f"Classified as domain '{domain}' with {len(semantic_model.fields)} fields." if persisted_model is not None else "Domain metadata could not be persisted. Retry ingestion before generating recommendations.",
            {
                "domain": domain,
                "semantic_model": semantic_model.model_dump(),
                "dataset": dataset_entry,
                "version": version,
                "embeddings_generated": result.get("embeddings_generated", 0),
                "embedding_status": dataset_entry.get("embeddingStatus", "Ready"),
            },
        )

        # ── STAGE 3: Dynamic Relational Storage in SAP HANA Cloud ────────────
        cloud_table_info = None
        # Use user-specified table or dynamically derive a clean table name
        folder = (raw_entry or {}).get("folder") or dataset_entry.get("folder") or base_title
        table_stem = re.sub(r"[^A-Za-z0-9_]", "_", folder).upper()[:18] or "DATASET"
        table_identity = hashlib.sha256(dataset_id.encode()).hexdigest()[:8].upper()
        active_table = target_table_name or f"DS_{table_stem}_{table_identity}_V{version}"
        table_action = (target_table_action or "replace").lower()
        _emit(3, "running", f"Provisioning SAP HANA Cloud table '{active_table}'...")

        if table_action != "none":
            try:
                cloud_table_info = hana_table_service.persist_dataframe(
                    df=clean_df,
                    table_name=active_table,
                    action=table_action,
                )
                if not cloud_table_info or not cloud_table_info.get("success"):
                    raise RuntimeError("HANA did not confirm successful table synchronization")
                cloud_table_info = {**cloud_table_info, "table_name": cloud_table_info.get("table_name") or active_table}
                active_table = cloud_table_info["table_name"]
                logger.info(f"[UploadService] Clean data persisted to HANA table '{active_table}'.")
                try:
                    with dataset_service._writer():
                        cat = dataset_service._catalog()
                        rentry = dataset_service._entry(cat, dataset_id)
                        rentry["tableName"] = active_table
                        rentry["table_name"] = active_table
                        rentry["tableManagedByUpload"] = target_table_name is None
                        for item in rentry.get("versions", []):
                            if item["version"] == version:
                                item["tableName"] = active_table
                        if target_table_name:
                            rentry["displayName"] = target_table_name
                            rentry["display_name"] = target_table_name
                            rentry["name"] = target_table_name
                        dataset_service._write_json(dataset_service.catalog_path, cat)
                except Exception as ex:
                    logger.debug(f"[UploadService] Note: Could not update table_name on catalog entry: {ex}")
            except Exception as e:
                logger.error(f"[UploadService] Dynamic HANA table error for '{active_table}': {e}")
                warnings.append("Dataset snapshot saved, but HANA table synchronization failed. Retry storage synchronization before publishing.")
                cloud_table_info = {
                    "success": False,
                    "table_name": active_table,
                    "error": str(e),
                    "message": f"Dataset saved, but dynamic HANA table sync encountered an issue: {str(e)}",
                }

        _emit(
            3,
            "failed" if cloud_table_info and not cloud_table_info.get("success") else "completed",
            f"Synced to HANA table '{active_table}'." if cloud_table_info and cloud_table_info.get("success") else f"HANA storage finalized for '{active_table}'.",
            {"cloud_table": cloud_table_info or {"success": True, "table_name": active_table, "action": table_action}},
        )

        # ── STAGE 4 / AGENT 3: Chart & Visualization Recommender ─────────────
        prerequisites_ready = persisted_model is not None and not (cloud_table_info and not cloud_table_info.get('success'))
        recommendations = []
        if not prerequisites_ready:
            _emit(4, 'failed', 'Agent 3 cannot execute until domain metadata and dataset storage succeed.', {'recommendations': []})
        else:
            _emit(4, "running", "Triggering Agent 3: Chart Recommender...")
            logger.info("[UploadService] Triggering Agent 3: Chart Recommender...")
            recommendations = chart_recommender_agent.recommend(
                clean_df,
                semantic_model,
                dataset_name=display_name or filename,
            )
            if raw_entry is not None and persisted_model is not None and recommendations:
                try:
                    semantic_registry.persist_recommendations(
                        raw_entry,
                        version,
                        persisted_model.revision,
                        recommendations,
                        model=persisted_model,
                    )
                except Exception as exc:
                    logger.warning(f"[UploadService] Note: Could not persist proposed recommendations: {exc}")
            logger.info(f"[UploadService] Agent 3 finished: Produced {len(recommendations)} recommended charts.")
            _emit(
                4,
                "completed",
                f"Produced {len(recommendations)} recommended charts.",
                {"recommendations": recommendations},
            )

        # Build response message
        msg_parts = [
            f"Successfully processed {len(clean_df)} clean rows (removed {audit['duplicates_removed']} duplicates, remediated {audit['null_values_cleaned']} nulls).",
            f"Identified domain: {domain.upper()}.",
            f"Generated {len(recommendations)} curated chart recommendations."
        ]
        if cloud_table_info and cloud_table_info.get("success"):
            msg_parts.append(f"Synced to HANA table '{cloud_table_info['table_name']}'.")

        storage_failed = bool(cloud_table_info and not cloud_table_info.get("success"))
        if storage_failed and not any("HANA" in warning for warning in warnings):
            warnings.append("HANA table synchronization failed. Retry storage synchronization before publishing.")
        ingestion_status = "partial" if storage_failed or warnings else "ready"
        try:
            with dataset_service._writer():
                cat = dataset_service._catalog()
                rentry = dataset_service._entry(cat, dataset_id)
                for item in rentry.get("versions", []):
                    if item["version"] == version:
                        item["ingestionStatus"] = ingestion_status
                        item["storageAction"] = table_action
                        item["storageTarget"] = active_table
                rentry["ingestionStatus"] = ingestion_status
                rentry["preprocessingAudit"] = audit
                rentry["domain"] = domain
                rentry["cloudTable"] = cloud_table_info
                dataset_service._write_json(dataset_service.catalog_path, cat)
                dataset_entry = dataset_service._item(rentry, cat.get("activeDatasetId"))
        except Exception as audit_save_exc:
            logger.warning(f"Could not persist preprocessing audit to catalog: {audit_save_exc}")

        return {
            "filename": dataset_entry.get("currentFilename", filename),
            "rows_processed": len(clean_df),
            "embeddings_generated": result.get("embeddings_generated", 0),
            "embedding_status": dataset_entry.get("embeddingStatus", "Ready"),
            "dataset": dataset_entry,
            "version": version,
            "status": "partial" if ingestion_status == "partial" else "success",
            "ready_for_publication": ingestion_status == "ready" and semantic_model.status == "approved",
            "warnings": warnings,
            "message": " ".join(msg_parts + warnings),
            "cloud_table": cloud_table_info,
            "preprocessing_audit": audit,
            "domain": domain,
            "semantic_model": semantic_model.model_dump(),
            "recommendations": recommendations,
        }


upload_service = UploadService()
