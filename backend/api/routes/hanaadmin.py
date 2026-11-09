from typing import List, Dict, Any, Optional, Literal
from fastapi import APIRouter, HTTPException, Query, Body
from pydantic import BaseModel, Field
from api.database.hana_table_service import hana_table_service
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api/hanaadmin", tags=["HANA Cloud Admin"])


class QueryPayload(BaseModel):
    sql: str = Field(..., description="Read-only SQL SELECT / WITH statement")
    maxRows: int = Field(100, ge=1, le=500, description="Max rows to return")


@router.get("")
async def hana_admin_overview():
    """HANA Cloud Admin Overview: Database connection status, stats, and live tables."""
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
    mode: Literal["row_range", "id_range", "condition"] = "row_range"
    fromRow: Optional[int] = Field(None, ge=1, description="Starting row number (1-based)")
    toRow: Optional[int] = Field(None, ge=1, description="Ending row number (1-based)")
    idColumn: Optional[str] = Field(None, description="Identifier column name")
    fromId: Optional[str] = Field(None, description="Starting ID")
    toId: Optional[str] = Field(None, description="Ending ID")
    condition: Optional[str] = Field(None, description="Custom SQL WHERE condition")


@router.post("/tables/{table_name}/delete-range")
async def delete_table_range(table_name: str, payload: DeleteRangePayload):
    """
    Delete a range of records from a table in SAP HANA Cloud.
    Supports row index range (from row X to row Y), ID range, or WHERE condition.
    """
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
            condition=payload.condition,
        )
        return result
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete records from '{table_name}': {str(e)}")


