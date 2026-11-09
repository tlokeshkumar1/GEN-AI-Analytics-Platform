#!/usr/bin/env python
import os
import sys
import argparse
import json
from pathlib import Path
from datetime import datetime
import pandas as pd
import requests

# Add backend directory to sys.path to enable importing api components
BASE_DIR = Path(__file__).resolve().parent
backend_path = BASE_DIR / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

# Attempt imports from backend app
try:
    from api.database.vector_client import vector_client
    from api.database.hana_client import hana_client
    from api.services.ai_core_service import ai_core_service
    from api.utils.logger import get_logger
    logger = get_logger("generate_embeddings_cli")
except ImportError as e:
    import logging
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger("generate_embeddings_cli")
    logger.error(f"Failed to import backend modules: {e}")
    raise ImportError(f"Backend modules could not be loaded: {e}")

def detect_id_column(df: pd.DataFrame) -> str:
    """Dynamically scan columns to find the most probable unique identifier."""
    # Common business keys / ID columns
    candidates = ["row_id", "rowid", "id", "key", "uuid", "order_id", "orderid", "transaction_id", "transactionid"]
    for col in df.columns:
        if str(col).lower() in candidates:
            return col
    # Any column ending with ID or Key
    for col in df.columns:
        col_lower = str(col).lower()
        if col_lower.endswith("id") or col_lower.endswith("key"):
            return col
    return ""

def format_row_to_text(row: pd.Series) -> str:
    """Format each row into a readable text representation using column names and values."""
    parts = []
    for col, val in row.items():
        if pd.isna(val) or val == "" or str(val).strip().lower() == "nan":
            continue
        # Convert floats ending in .0 to integers for cleaner readable text
        if isinstance(val, float) and val.is_integer():
            val = int(val)
        
        # Format column name nicely (e.g., GrossMarginUSD -> Gross Margin USD or sales_amount -> Sales amount)
        col_name = str(col).replace("_", " ").strip()
        parts.append(f"{col_name}: {val}.")
    return " ".join(parts)

def load_from_sac(url: str, client_id: str, client_secret: str, model_id: str) -> pd.DataFrame:
    """Fetch FactData from SAP Analytics Cloud Model API."""
    logger.info("Connecting to SAP Analytics Cloud...")
    if not url or not client_id or not client_secret or not model_id:
        logger.error("SAC configuration incomplete (missing sac-url, sac-client-id, sac-client-secret, or sac-model-id).")
        raise ValueError("SAC configuration incomplete.")
    
    # 1. Obtain OAuth Token
    token_url = f"{url}/oauth/token"
    try:
        token_res = requests.post(
            token_url,
            data={"grant_type": "client_credentials"},
            auth=(client_id, client_secret),
            timeout=15
        )
        token_res.raise_for_status()
        token = token_res.json().get("access_token")
    except Exception as e:
        logger.error(f"Failed to authenticate with SAP Analytics Cloud: {e}")
        raise e

    # 2. Get FactData
    fact_url = f"{url}/api/v1/dataexport/providers/sac/{model_id}/FactData"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    try:
        res = requests.get(fact_url, headers=headers, timeout=30)
        res.raise_for_status()
        data = res.json()
        rows = data.get("value", [])
        return pd.DataFrame(rows)
    except Exception as e:
        logger.error(f"Failed to retrieve SAC fact data: {e}")
        raise e

import hashlib

def process_and_upload(df: pd.DataFrame, source_name: str, sheet_name: str, batch_size: int):
    """Process a DataFrame, generate row text with SHA256 hashing and enriched metadata, and upload to vector engine."""
    if hasattr(vector_client, "_ensure_schema"):
        try:
            vector_client._ensure_schema()
        except Exception as e:
            logger.warning(f"Error executing schema verification: {e}")
    total_rows = len(df)

    if total_rows == 0:
        logger.warning(f"No rows to process for source: {source_name}, sheet: {sheet_name}")
        return

    logger.info(f"Processing sheet: '{sheet_name}' ({total_rows} rows)")
    id_col = detect_id_column(df)
    if id_col:
        logger.info(f"Detected ID column: '{id_col}'")
    else:
        logger.warning("No ID column detected. Falling back to row indices.")

    # Prepare rows with target document IDs, SHA256 content hash, and textual representation
    rows_to_process = []
    for idx, row in df.iterrows():
        # Clean ID
        row_id_val = str(row[id_col]).strip() if id_col else str(idx)
        # Create a globally unique ID within the vector table
        doc_id = f"{source_name}_{sheet_name}_{row_id_val}".replace(" ", "_")
        
        row_text = format_row_to_text(row)
        content_hash = hashlib.sha256(row_text.encode("utf-8")).hexdigest()

        # Extract useful filter metadata
        meta = {
            "source": source_name,
            "sheet": sheet_name,
            "row_id": row_id_val,
            "content_hash": content_hash,
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        for col_name in ["Country", "Region", "CustomerName", "Customer", "ProductName", "Product", "Category"]:
            if col_name in row and pd.notna(row[col_name]):
                meta[col_name.lower()] = str(row[col_name])

        rows_to_process.append({
            "doc_id": doc_id,
            "row_id_val": row_id_val,
            "text": row_text,
            "content_hash": content_hash,
            "metadata": meta
        })

    # Execute incremental updates in batches
    num_batches = (total_rows + batch_size - 1) // batch_size
    embedded_count = 0
    skipped_count = 0

    for i in range(num_batches):
        batch = rows_to_process[i * batch_size : (i + 1) * batch_size]
        batch_ids = [item["doc_id"] for item in batch]
        
        # Check database for existing records & hashes
        existing_hashes = {}
        if hana_client:
            try:
                placeholders = ",".join(["?"] * len(batch_ids))
                sql = f"SELECT ID, METADATA FROM VECTOR_TABLE WHERE ID IN ({placeholders})"
                results = hana_client.execute_query(sql, tuple(batch_ids))
                for r in results:
                    meta_raw = r.get("METADATA")
                    if meta_raw:
                        try:
                            m_dict = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
                            existing_hashes[r["ID"]] = m_dict.get("content_hash")
                        except Exception:
                            pass
            except Exception as ex:
                logger.warning(f"Could not query existing hashes from VECTOR_TABLE: {ex}. Doing insert/update.")

        for item in batch:
            doc_id = item["doc_id"]
            new_text = item["text"]
            c_hash = item["content_hash"]
            
            # Incremental Update Check via SHA256 hash
            if doc_id in existing_hashes and existing_hashes[doc_id] == c_hash:
                skipped_count += 1
                continue

            # Generate embedding
            logger.info(f"Generating embedding for ID: {doc_id}...")
            try:
                embedding = ai_core_service.generate_embedding(new_text)
            except Exception as e:
                logger.error(f"Embedding generation failed for {doc_id}: {e}")
                continue

            # Upload to SAP HANA Cloud Vector Engine
            if hana_client:
                # Use UPSERT to handle both insert and update
                vector_str = str(embedding)
                metadata_str = json.dumps(item["metadata"])
                sql = """
                    UPSERT VECTOR_TABLE (ID, TEXT_CHUNK, EMBEDDING, METADATA)
                    VALUES (?, ?, TO_REAL_VECTOR(?), ?)
                    WITH PRIMARY KEY
                """
                try:
                    hana_client.execute_query(sql, (doc_id, new_text, vector_str, metadata_str))
                    embedded_count += 1
                except Exception as ex:
                    logger.error(f"Failed to upsert vector for {doc_id}: {ex}")
            else:
                logger.error("HANA vector client is not available. Cannot store vector.")

    logger.info(f"Sheet '{sheet_name}' complete. Embedded/Updated: {embedded_count}, Skipped (unchanged): {skipped_count}")

def main():
    parser = argparse.ArgumentParser(description="Python-based dynamic embedding generation pipeline.")
    parser.add_argument("--source", type=str, required=True, help="Path to Excel/CSV file or 'sac' to load from SAP Analytics Cloud.")
    parser.add_argument("--sheet", type=str, default=None, help="Name of specific Excel sheet to load. Loads all sheets by default.")
    parser.add_argument("--batch-size", type=int, default=50, help="Batch size for database checking and ingestion.")
    
    # SAC details
    parser.add_argument("--sac-url", type=str, default=os.getenv("SAC_URL"), help="SAC Tenant URL")
    parser.add_argument("--sac-client-id", type=str, default=os.getenv("SAC_CLIENT_ID"), help="SAC OAuth Client ID")
    parser.add_argument("--sac-client-secret", type=str, default=os.getenv("SAC_CLIENT_SECRET"), help="SAC OAuth Client Secret")
    parser.add_argument("--sac-model-id", type=str, default=os.getenv("SAC_MODEL_ID"), help="SAC Model ID")

    args = parser.parse_args()

    # Load data dynamically
    source = args.source
    logger.info(f"[*] Loading data from: {source}")

    if source.lower() == "sac":
        df = load_from_sac(args.sac_url, args.sac_client_id, args.sac_client_secret, args.sac_model_id)
        process_and_upload(df, "SAC", "FactData", args.batch_size)
    else:
        file_path = Path(source)
        if not file_path.exists():
            logger.error(f"Source file not found: {source}")
            sys.exit(1)

        suffix = file_path.suffix.lower()
        source_name = file_path.stem

        if suffix == ".csv":
            df = pd.read_csv(file_path)
            process_and_upload(df, source_name, "CSV_Data", args.batch_size)
        elif suffix in [".xlsx", ".xls"]:
            xl = pd.ExcelFile(file_path)
            sheets = [args.sheet] if args.sheet else xl.sheet_names
            for sheet in sheets:
                df = pd.read_excel(xl, sheet_name=sheet)
                process_and_upload(df, source_name, sheet, args.batch_size)
        else:
            logger.error(f"Unsupported file format: {suffix}")
            sys.exit(1)

    logger.info("Pipeline executed successfully.")

if __name__ == "__main__":
    main()
