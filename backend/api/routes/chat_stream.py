import os
import json
import asyncio
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse
from api.models.request_models import ChatRequest
from api.rag.pipeline import RAGPipeline
from api.services.history_service import history_service
from api.utils.logger import get_logger
from api.utils.json_encoder import safe_json_dumps, hana_json_default

logger = get_logger("routes.chat_stream")

router = APIRouter(prefix="/api/chat", tags=["Chatbot Stream"])

# SSE heartbeat interval (seconds) — keeps connection alive through proxies
HEARTBEAT_INTERVAL = 15.0


@router.post("/stream")
async def chat_stream(req: ChatRequest, request: Request):
    """
    Server-Sent Events (SSE) endpoint for real-time processing feedback & chat responses.

    Event lifecycle:
        request_started  → Pipeline begins
        stage            → Intent detection, vector retrieval, calculation, etc.
        token            → Individual LLM token (progressive rendering)
        final_answer     → Complete assembled response text
        result           → Full structured payload (sources, metadata, session_id)
        request_completed → Pipeline finished

    Each pipeline stage emits events as they happen via a thread-safe asyncio.Queue,
    so the frontend receives updates in real time rather than after the pipeline completes.
    Persists both user query and bot response to HANA Cloud.
    """
    import threading
    import uuid

    # Queue bridges the sync pipeline thread → async SSE generator
    event_queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()
    stop_event = threading.Event()

    # ── Resolve or create session ─────────────────────────────────────────
    from api.utils.auth import get_user_id_from_request
    user_id = get_user_id_from_request(request, req.user_id)
    session_id = None
    chat_history = []
    try:
        session_id = history_service.get_or_create_session(req.session_id, user_id=user_id, first_message=req.message)
    except Exception as exc:
        session_id = req.session_id or f"ephemeral-{uuid.uuid4().hex[:8]}"
        logger.warning(f"HANA chat session creation failed ({exc}); using ephemeral session {session_id}.")

    if not session_id.startswith("ephemeral-"):
        try:
            history_service.save_message(
                session_id=session_id,
                role="user",
                content=req.message,
            )
        except Exception as exc:
            logger.warning(f"Failed to persist user message for session {session_id} ({exc}).")

        try:
            chat_history = history_service.get_recent_history(session_id, limit=10)
        except Exception as exc:
            logger.warning(f"Failed to load recent history for session {session_id} ({exc}); continuing with empty history.")
            chat_history = []

    def stage_callback(event: dict) -> None:
        """Thread-safe callback invoked by the pipeline for each stage transition or token."""
        loop.call_soon_threadsafe(event_queue.put_nowait, event)

    async def event_generator():
        pipeline_task = None
        try:
            # Signal that processing has started
            yield f"data: {safe_json_dumps({'type': 'request_started', 'session_id': session_id})}\n\n"

            # Run the STREAMING pipeline in a worker thread, passing the callback
            # This uses run_stream() which emits both stage AND token events
            pipeline_task = asyncio.ensure_future(
                asyncio.to_thread(RAGPipeline().run_stream, req.message, req.top_k, stage_callback, chat_history, stop_event)
            )

            # Track time since last event for heartbeat
            last_event_time = asyncio.get_event_loop().time()

            # Yield stage/token events as they arrive from the queue
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    logger.info("[ChatStream] Client disconnected, stopping SSE.")
                    stop_event.set()
                    if pipeline_task and not pipeline_task.done():
                        pipeline_task.cancel()
                    return

                # Wait for next event with a timeout so we can check pipeline completion
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=0.1)
                    yield f"data: {safe_json_dumps(event)}\n\n"
                    last_event_time = asyncio.get_event_loop().time()
                except asyncio.TimeoutError:
                    # Send heartbeat if no events for HEARTBEAT_INTERVAL seconds
                    now = asyncio.get_event_loop().time()
                    if (now - last_event_time) >= HEARTBEAT_INTERVAL:
                        yield ": heartbeat\n\n"
                        last_event_time = now

                # If the pipeline task is done, drain any remaining events
                if pipeline_task.done():
                    while not event_queue.empty():
                        event = event_queue.get_nowait()
                        yield f"data: {safe_json_dumps(event)}\n\n"
                    break

            # Get the final result from the pipeline
            result = pipeline_task.result()

            # Save the chatbot response to HANA Cloud if persistent
            try:
                history_service.save_message(
                    session_id=session_id,
                    role="assistant",
                    content=result.get("reply", ""),
                    sources=result.get("sources", []),
                    intent=result.get("intent"),
                    metadata={
                        "chart_type": result.get("chart_type"),
                        "insights": result.get("insights"),
                        "graph_image": result.get("graph_image"),
                    },
                )
            except Exception as exc:
                logger.warning(f"Failed to persist assistant response ({exc}); session {session_id} is ephemeral.")

            # Inject session_id into result data
            result["session_id"] = session_id

            # Emit final_answer event (complete assembled text)
            final_answer_event = {
                "type": "final_answer",
                "content": result.get("reply", ""),
            }
            yield f"data: {safe_json_dumps(final_answer_event)}\n\n"

            # Emit the full result payload (preserves backward compatibility)
            yield f"data: {safe_json_dumps({'type': 'result', 'data': result})}\n\n"

            # Signal completion
            yield f"data: {safe_json_dumps({'type': 'request_completed'})}\n\n"

        except asyncio.CancelledError:
            stop_event.set()
            logger.info("[ChatStream] SSE generation cancelled.")

        except Exception as e:
            stop_event.set()
            logger.error("[ChatStream] SSE generation failed (%s): %s", type(e).__name__, e, exc_info=True)
            detail = e.detail if isinstance(e, HTTPException) else (str(e) if os.getenv("APP_ENV", "development") == "development" and str(e) else "Chat processing failed. Please retry.")

            # Emit a failed stage event so the frontend can show the error
            error_stage = {
                "type": "stage",
                "stage": "error",
                "status": "failed",
                "message": detail,
                "error": detail,
            }
            yield f"data: {safe_json_dumps(error_stage)}\n\n"

            err_payload = {"type": "error", "message": detail, "session_id": session_id}
            yield f"data: {safe_json_dumps(err_payload)}\n\n"
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
