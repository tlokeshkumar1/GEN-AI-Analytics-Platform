from fastapi import APIRouter, UploadFile, File, HTTPException, Query, Form
from api.platform.contracts import TransformationPlan
from api.models.response_models import UploadResponse
from api.services.upload_service import upload_service
from api.utils.validation import validate_excel_file
from api.config import settings
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api/upload", tags=["Upload"])

@router.post("", response_model=UploadResponse)
async def upload_dataset(
    file: UploadFile = File(...),
    sync: bool = Query(False),
    plan: str | None = Form(None),
    target_table_name: str | None = Form(None),
    target_table_action: str | None = Form(None),
):
    validate_excel_file(file.filename)
    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024

    try:
        buffer = bytearray()
        chunk_size = 1024 * 1024  # 1MB chunks
        while chunk := await file.read(chunk_size):
            buffer.extend(chunk)
            if len(buffer) > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"File exceeds maximum allowed upload size of {settings.MAX_UPLOAD_SIZE_MB}MB."
                )
        content = bytes(buffer)

        try:
            transformation = TransformationPlan.model_validate_json(plan) if plan else None
        except ValueError:
            raise HTTPException(422, "Invalid transformation plan.") from None

        res = await run_in_threadpool(
            upload_service.process_file,
            content,
            file.filename,
            False if sync else None,
            transformation,
            target_table_name,
            target_table_action,
        )
        return UploadResponse(**res)
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"Failed to process file: {str(e)}")
