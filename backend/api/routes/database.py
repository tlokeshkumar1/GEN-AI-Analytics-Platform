from typing import List, Dict, Any, Optional, Literal
from fastapi import APIRouter, HTTPException, Query
from api.database.hana_table_service import hana_table_service
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api/database", tags=["Database"])


@router.get("/tables")
async def list_tables(include_internal: bool = Query(False, description="Include system and vector/chat internal tables")):
    """List accessible tables in the SAP HANA Cloud database schema."""
    try:
        tables = await run_in_threadpool(hana_table_service.list_user_tables, include_internal=include_internal)
        return {"tables": tables}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to query HANA database tables: {str(e)}")


@router.get("/tables/{table_name}/exists")
async def check_table_exists(table_name: str):
    """Check if a table exists in SAP HANA Cloud."""
    try:
        exists = await run_in_threadpool(hana_table_service.table_exists, table_name)
        return {"tableName": table_name, "exists": exists}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to check table existence: {str(e)}")


@router.get("/tables/{table_name}/data")
async def get_table_data(
    table_name: str,
    page: int = Query(1, ge=1),
    pageSize: int = Query(25, ge=1, le=500),
    sortField: Optional[str] = Query(None),
    sortDir: Literal["asc", "desc", "ASC", "DESC"] = Query("asc"),
    search: str = Query(""),
):
    """Retrieve paginated rows from any HANA table."""
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
        return result
    except ValueError as ve:
        raise HTTPException(status_code=404, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch data for table '{table_name}': {str(e)}")
