import asyncio
from fastapi import APIRouter, UploadFile, File, HTTPException, Query, Form, Request
from fastapi.responses import StreamingResponse
from api.platform.contracts import TransformationPlan
from api.models.response_models import UploadResponse
from api.services.upload_service import upload_service
from api.utils.validation import validate_excel_file
from api.utils.json_encoder import safe_json_dumps
from api.utils.logger import get_logger
from api.config import settings
from starlette.concurrency import run_in_threadpool

logger = get_logger("routes.upload")
HEARTBEAT_INTERVAL = 15.0

router = APIRouter(prefix="/api/upload", tags=["Upload"])


async def _read_upload_payload(file: UploadFile, plan: str | None) -> tuple[bytes, TransformationPlan | None]:
    """Validate uploaded spreadsheet, stream bounded bytes, and parse any transformation plan."""
    validate_excel_file(file.filename)
    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024

    buffer = bytearray()
    chunk_size = 1024 * 1024  # 1MB chunks
    while chunk := await file.read(chunk_size):
        buffer.extend(chunk)
        if len(buffer) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File exceeds maximum allowed upload size of {settings.MAX_UPLOAD_SIZE_MB}MB."
            )

    try:
        transformation = TransformationPlan.model_validate_json(plan) if plan else None
    except ValueError:
        raise HTTPException(422, "Invalid transformation plan.") from None

    return bytes(buffer), transformation


@router.post("", response_model=UploadResponse)
async def upload_dataset(
    file: UploadFile = File(...),
    sync: bool = Query(False),
    plan: str | None = Form(None),
    target_table_name: str | None = Form(None),
    target_table_action: str | None = Form(None),
):
    try:
        content, transformation = await _read_upload_payload(file, plan)
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


@router.post("/stream")
async def upload_dataset_stream(
    request: Request,
    file: UploadFile = File(...),
    sync: bool = Query(False),
    plan: str | None = Form(None),
    target_table_name: str | None = Form(None),
    target_table_action: str | None = Form(None),
):
    """Stream sequential 3-agent upload progress via Server-Sent Events (SSE)."""
    content, transformation = await _read_upload_payload(file, plan)
    filename = file.filename or "dataset"

    event_queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def progress_callback(event: dict) -> None:
        loop.call_soon_threadsafe(event_queue.put_nowait, event)

    async def event_generator():
        pipeline_task = None
        try:
            yield f"data: {safe_json_dumps({'type': 'request_started', 'filename': filename})}\n\n"

            pipeline_task = asyncio.ensure_future(
                asyncio.to_thread(
                    upload_service.process_file,
                    content,
                    filename,
                    False if sync else None,
                    transformation,
                    target_table_name,
                    target_table_action,
                    progress_callback,
                )
            )

            last_event_time = loop.time()

            while True:
                if await request.is_disconnected():
                    logger.info("[UploadStream] Client disconnected, stopping SSE stream.")
                    return

                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=0.1)
                    yield f"data: {safe_json_dumps(event)}\n\n"
                    last_event_time = loop.time()
                except asyncio.TimeoutError:
                    now = loop.time()
                    if (now - last_event_time) >= HEARTBEAT_INTERVAL:
                        yield ": heartbeat\n\n"
                        last_event_time = now

                if pipeline_task.done():
                    while not event_queue.empty():
                        event = event_queue.get_nowait()
                        yield f"data: {safe_json_dumps(event)}\n\n"
                    break

            result = pipeline_task.result()
            validated = UploadResponse(**result).model_dump()
            yield f"data: {safe_json_dumps({'type': 'result', 'data': validated})}\n\n"
            yield f"data: {safe_json_dumps({'type': 'request_completed'})}\n\n"
        except asyncio.CancelledError:
            logger.info("[UploadStream] SSE generation cancelled.")
        except Exception as e:
            logger.error("[UploadStream] SSE upload failed (%s): %s", type(e).__name__, e, exc_info=True)
            detail = e.detail if isinstance(e, HTTPException) else f"Failed to process file: {str(e)}"
            yield f"data: {safe_json_dumps({'type': 'error', 'message': detail})}\n\n"
            yield f"data: {safe_json_dumps({'type': 'request_completed'})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
