import io
from typing import Dict, Any, Optional
import pandas as pd

from api.services.dataset_service import dataset_service
from api.database.hana_table_service import hana_table_service
from api.platform.agent_preprocessing import preprocessing_agent
from api.platform.agent_domain_classifier import domain_classifier_agent
from api.platform.agent_chart_recommender import chart_recommender_agent
from api.platform.semantic import semantic_registry
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
    ) -> Dict[str, Any]:
        """
        Orchestrate the 3-Agent Ingestion Pipeline:
        1. Agent 1: Data Preprocessing (remove duplicates, clean nulls, normalize formatting)
        2. Agent 2: 5-Row Domain Classifier & Semantic Modeling
        3. Dynamic HANA Storage: Persist clean data
        4. Agent 3: Visualization & Chart Recommendations
        """
        logger.info(f"[UploadService] Starting 3-agent ingestion for file: {filename}")

        # Step 0: Parse raw content
        try:
            if transformation_plan is None:
                df_raw = dataset_service.parse_file(content, filename)
            else:
                from api.platform.ingestion import ingestion_service
                df_raw, _ = ingestion_service.prepare(content, filename, transformation_plan)
        except Exception as e:
            logger.error(f"Error parsing raw file {filename}: {e}")
            raise

        # ── AGENT 1: Preprocessing & Cleaning ────────────────────────────────
        logger.info("[UploadService] Triggering Agent 1: Preprocessing...")
        clean_df, audit = preprocessing_agent.clean(df_raw)
        logger.info(f"[UploadService] Agent 1 finished: {audit.get('message')}")

        # Re-export clean dataframe to bytes for snapshot & vector generation
        clean_buffer = io.BytesIO()
        if filename.lower().endswith(".csv"):
            clean_df.to_csv(clean_buffer, index=False, encoding="utf-8")
        else:
            with pd.ExcelWriter(clean_buffer, engine="openpyxl") as writer:
                clean_df.to_excel(writer, index=False)
        clean_content = clean_buffer.getvalue()

        # Step 1: Upload clean dataset version & create vector embeddings
        result = dataset_service.upload(
            clean_content,
            filename,
            async_index=async_index,
            transformation_plan=transformation_plan
        )
        dataset_entry = result["dataset"]
        dataset_id = dataset_entry["id"]
        version = result["version"]

        # ── AGENT 2: Domain Classification & Semantics (First 5 Rows) ────────
        logger.info("[UploadService] Triggering Agent 2: Domain Classifier...")
        semantic_model = domain_classifier_agent.analyze(
            df=clean_df,
            dataset_id=dataset_id,
            data_version=version
        )
        domain = semantic_model.domain
        logger.info(f"[UploadService] Agent 2 finished: Classified as domain '{domain}' with {len(semantic_model.fields)} fields.")

        # Persist semantic model into platform store
        try:
            catalog = dataset_service._catalog()
            raw_entry = dataset_service._entry(catalog, dataset_id)
            snapshot = dataset_service._snapshot(raw_entry, version)
            semantic_registry.propose(raw_entry, version, snapshot, overrides=semantic_model.model_dump())
            logger.info(f"[UploadService] Proposed semantic model saved to registry for {dataset_id} v{version}")
        except Exception as exc:
            logger.warning(f"[UploadService] Note: Could not auto-propose model to registry: {exc}")

        # ── Dynamic Relational Storage in SAP HANA Cloud ──────────────────────
        cloud_table_info = None
        # Use user-specified table or dynamically derive a clean table name
        active_table = target_table_name or f"DS_{dataset_entry.get('folder', 'DATASET')[:18].upper()}_V{version}"
        table_action = (target_table_action or "replace").lower()

        if table_action != "none":
            try:
                cloud_table_info = hana_table_service.persist_dataframe(
                    df=clean_df,
                    table_name=active_table,
                    action=table_action,
                )
                logger.info(f"[UploadService] Clean data persisted to HANA table '{active_table}'.")
            except Exception as e:
                logger.error(f"[UploadService] Dynamic HANA table error for '{active_table}': {e}")
                cloud_table_info = {
                    "success": False,
                    "table_name": active_table,
                    "error": str(e),
                    "message": f"Dataset saved, but dynamic HANA table sync encountered an issue: {str(e)}",
                }

        # ── AGENT 3: Chart & Visualization Recommender ───────────────────────
        logger.info("[UploadService] Triggering Agent 3: Chart Recommender...")
        recommendations = chart_recommender_agent.recommend(clean_df, semantic_model)
        logger.info(f"[UploadService] Agent 3 finished: Produced {len(recommendations)} recommended charts.")

        # Build response message
        msg_parts = [
            f"Successfully processed {len(clean_df)} clean rows (removed {audit['duplicates_removed']} duplicates, remediated {audit['null_values_cleaned']} nulls).",
            f"Identified domain: {domain.upper()}.",
            f"Generated {len(recommendations)} curated chart recommendations."
        ]
        if cloud_table_info and cloud_table_info.get("success"):
            msg_parts.append(f"Synced to HANA table '{cloud_table_info['table_name']}'.")

        return {
            "filename": dataset_entry.get("currentFilename", filename),
            "rows_processed": len(clean_df),
            "embeddings_generated": result.get("embeddings_generated", 0),
            "embedding_status": dataset_entry.get("embeddingStatus", "Ready"),
            "dataset": dataset_entry,
            "version": version,
            "status": "success",
            "message": " ".join(msg_parts),
            "cloud_table": cloud_table_info,
            "preprocessing_audit": audit,
            "domain": domain,
            "semantic_model": semantic_model.model_dump(),
            "recommendations": recommendations,
        }


upload_service = UploadService()
