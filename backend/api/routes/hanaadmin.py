import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Literal
from fastapi import APIRouter, HTTPException, Query, Body
from pydantic import BaseModel, Field
from api.database.hana_table_service import hana_table_service
from api.models.execution_context import require_admin
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hanaadmin", tags=["HANA Cloud Admin"])


class QueryPayload(BaseModel):
    sql: str = Field(..., description="Read-only SQL SELECT / WITH statement")
    maxRows: int = Field(100, ge=1, le=500, description="Max rows to return")


@router.get("")
async def hana_admin_overview():
    """HANA Cloud Admin Overview: Database connection status, stats, and live tables."""
    require_admin()
    try:
        stats = await run_in_threadpool(hana_table_service.get_database_stats)
        tables = await run_in_threadpool(hana_table_service.list_user_tables, include_internal=True)
        return {
            "success": True,
            "status": "online" if stats.get("connected") else "offline",
            "stats": stats,
            "tableCount": len(tables),
            "tables": tables,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch HANA Admin overview: {str(e)}")


@router.get("/stats")
async def get_stats():
    """Get SAP HANA Cloud database instance statistics and schema details."""
    require_admin()
    try:
        stats = await run_in_threadpool(hana_table_service.get_database_stats)
        return stats
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch database statistics: {str(e)}")


@router.get("/tables")
async def list_tables(include_internal: bool = Query(True, description="Include system and vector/chat internal tables")):
    """
    List all tables currently existing in the configured SAP HANA Cloud schema.
    Dynamically and automatically detects any newly created or future tables.
    """
    require_admin()
    try:
        tables = await run_in_threadpool(hana_table_service.list_user_tables, include_internal=include_internal)
        return {
            "success": True,
            "totalTables": len(tables),
            "tables": tables,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to query HANA database tables: {str(e)}")


@router.get("/tables/{table_name}")
async def get_table_details(table_name: str):
    """Get metadata, row count, and column schemas for a specific table."""
    require_admin()
    try:
        exists = await run_in_threadpool(hana_table_service.table_exists, table_name)
        if not exists:
            raise HTTPException(status_code=404, detail=f"Table '{table_name}' does not exist.")

        cols = await run_in_threadpool(hana_table_service.get_table_columns, table_name)
        tables = await run_in_threadpool(hana_table_service.list_user_tables, include_internal=True)
        matched = next((t for t in tables if t["name"].upper() == table_name.upper()), None)

        return {
            "success": True,
            "tableName": table_name.upper(),
            "exists": True,
            "rowCount": matched.get("rowCount", 0) if matched else None,
            "columnCount": len(cols),
            "isInternal": matched.get("isInternal", False) if matched else False,
            "columns": cols,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve details for table '{table_name}': {str(e)}")


@router.get("/tables/{table_name}/schema")
async def get_table_schema(table_name: str):
    """Get detailed column definitions and types for a table."""
    require_admin()
    try:
        cols = await run_in_threadpool(hana_table_service.get_table_columns, table_name)
        if not cols:
            exists = await run_in_threadpool(hana_table_service.table_exists, table_name)
            if not exists:
                raise HTTPException(status_code=404, detail=f"Table '{table_name}' not found.")
        return {
            "success": True,
            "tableName": table_name.upper(),
            "columns": cols,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch schema for table '{table_name}': {str(e)}")


@router.get("/tables/{table_name}/data")
async def get_table_data(
    table_name: str,
    page: int = Query(1, ge=1, description="Page number starting at 1"),
    pageSize: int = Query(25, ge=1, le=500, description="Number of records per page"),
    sortField: Optional[str] = Query(None, description="Column name to sort by"),
    sortDir: Literal["asc", "desc", "ASC", "DESC"] = Query("asc", description="Sort direction"),
    search: str = Query("", description="Search term for string columns"),
):
    """
    Retrieve paginated records from a HANA Cloud table with search filtering and sorting.
    Automatically handles any existing or future table.
    """
    require_admin()
    try:
        result = await run_in_threadpool(
            hana_table_service.get_table_data,
            table_name=table_name,
            page=page,
            page_size=pageSize,
            sort_col=sortField,
            sort_dir=sortDir.upper(),
            search=search,
        )
        return {
            "success": True,
            **result,
        }
    except ValueError as ve:
        raise HTTPException(status_code=404, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch data for table '{table_name}': {str(e)}")


@router.post("/query")
async def execute_sql_query(payload: QueryPayload):
    """
    Execute a read-only SQL SELECT / WITH query against SAP HANA Cloud.
    Safe execution with keyword validation and max row limits.
    """
    require_admin()
    try:
        result = await run_in_threadpool(
            hana_table_service.execute_read_only_query,
            sql_query=payload.sql,
            max_rows=payload.maxRows,
        )
        return result
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Query execution error: {str(e)}")


class DeleteRangePayload(BaseModel):
    mode: Literal["row_range", "id_range", "key_values"] = "row_range"
    fromRow: Optional[int] = Field(None, ge=1, description="Starting row number (1-based)")
    toRow: Optional[int] = Field(None, ge=1, description="Ending row number (1-based)")
    idColumn: Optional[str] = Field(None, description="Identifier column name")
    fromId: Optional[str] = Field(None, description="Starting ID")
    toId: Optional[str] = Field(None, description="Ending ID")
    keyValues: Optional[Dict[str, List[Any]]] = Field(None, description="Map of column name to values for parameterized deletion")


@router.post("/tables/{table_name}/delete-range")
async def delete_table_range(table_name: str, payload: DeleteRangePayload):
    """
    Delete a range of records from a table in SAP HANA Cloud.
    Supports row index range (from row X to row Y), ID range, or safe parameterized key-values.
    """
    require_admin()
    try:
        result = await run_in_threadpool(
            hana_table_service.delete_table_records_range,
            table_name=table_name,
            mode=payload.mode,
            from_row=payload.fromRow,
            to_row=payload.toRow,
            id_col=payload.idColumn,
            from_id=payload.fromId,
            to_id=payload.toId,
            key_values=payload.keyValues,
        )
        return result
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete records from '{table_name}': {str(e)}")


@router.delete("/tables/{table_name}")
async def drop_table(
    table_name: str,
    cascade_dataset: bool = Query(True, description="Also clean up matching dataset metadata & embeddings if table is a dataset table")
):
    """
    Safely drop a column table from SAP HANA Cloud.
    Protected system tables (e.g. DATASETS_METADATA, VECTOR_TABLE, etc.) cannot be dropped.
    If cascade_dataset is True and the table is linked to an uploaded dataset, cleans up associated metadata and vectors.
    """
    require_admin()
    try:
        clean_name = table_name.strip()
        protected = {
            "DATASETS_METADATA", "PLATFORM_METADATA", "PLATFORM_DOCUMENTS",
            "VECTOR_TABLE", "CHAT_MESSAGES", "CHAT_SESSIONS"
        }
        if clean_name.upper() in protected:
            raise HTTPException(
                status_code=400,
                detail=f"Dropping protected system table '{clean_name}' is strictly prohibited."
            )

        exists = await run_in_threadpool(hana_table_service.table_exists, clean_name)
        if not exists:
            raise HTTPException(status_code=404, detail=f"Table '{clean_name}' does not exist.")

        # Identify if this table is associated with an uploaded dataset
        matched_dataset_id = None
        dataset_cleaned = False
        if cascade_dataset:
            try:
                from api.services.dataset_service import dataset_service
                catalog = await run_in_threadpool(dataset_service._catalog)
                clean_upper = clean_name.upper()
                for ds_id, entry in list(catalog.get("datasets", {}).items()):
                    phys = (entry.get("physical_table_name") or "").upper()
                    folder = (entry.get("folder") or "").upper()
                    name_stem = Path(entry.get("name", "")).stem.upper().replace(" ", "_").replace("-", "_")
                    cand_names = {
                        phys,
                        folder,
                        name_stem,
                        f"DS_{folder[:18]}",
                        f"DS_{folder[:18]}_V1",
                        f"DS_{folder[:18]}_V{entry.get('currentVersion', 1)}",
                        f"DS_{name_stem[:18]}",
                        f"DS_{name_stem[:18]}_V1",
                        f"DS_{name_stem[:18]}_V{entry.get('currentVersion', 1)}"
                    }
                    if clean_upper in cand_names:
                        matched_dataset_id = ds_id
                        break
            except Exception as ex:
                logger.warning(f"Error checking matching dataset for table '{clean_name}': {ex}")

        # Drop the table in SAP HANA Cloud
        res = await run_in_threadpool(hana_table_service.drop_table, clean_name)

        # If matching dataset exists and cascade is True, delete dataset metadata & embeddings
        if cascade_dataset and matched_dataset_id:
            try:
                from api.services.dataset_service import dataset_service
                await run_in_threadpool(dataset_service.delete, matched_dataset_id)
                dataset_cleaned = True
                logger.info(f"Cascaded dataset cleanup for dataset '{matched_dataset_id}' on table '{clean_name}'")
            except Exception as ex:
                logger.warning(f"Associated dataset cleanup notice: {ex}")

        return {
            "success": True,
            "tableName": clean_name.upper(),
            "dropped": res.get("dropped", True),
            "datasetCleaned": dataset_cleaned,
            "matchedDatasetId": matched_dataset_id,
            "message": f"Table '{clean_name.upper()}' has been successfully dropped from SAP HANA Cloud."
        }
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to drop table '{table_name}': {str(e)}")


