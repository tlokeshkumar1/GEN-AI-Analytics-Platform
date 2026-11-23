from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import json
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
from api.services.intent_engine import intent_engine
from api.models.query_plan import QueryPlan
from api.services.analytics_engine import analytics_engine
from api.platform.charts import render_chart

from api.utils.logger import get_logger

logger = get_logger("routes.graph")

router = APIRouter(prefix="/api/graph", tags=["Custom Graph Generation"])


class AdvancedGraphRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    query_plan: QueryPlan
    idempotency_key: str = Field(min_length=8, max_length=200)


@router.post("/advanced")
def advanced_graph(req: AdvancedGraphRequest):
    import os
    from api.models.execution_context import current_selection, require_dataset_access
    from api.platform.jobs import job_service
    selection = current_selection.get()
    if selection is None:
        raise HTTPException(409, "Select a dataset version first.")
    require_dataset_access(selection.entry, write=True)
    return job_service.enqueue("custom_chart", {"dataset_id": selection.context.dataset_id,
                               "context": selection.context.model_dump(), "query_plan": req.query_plan.model_dump(exclude_none=True, by_alias=True),
                               "prompt": req.prompt}, req.idempotency_key)


class GraphRequest(BaseModel):
    prompt: str = Field(..., description="Natural language description of requested visualization")
    query_plan: Optional[QueryPlan] = None
    chart_type: str = "bar"
    dataset_id: Optional[str] = None


class GraphResponse(BaseModel):
    status: str
    prompt: str
    image_base64: str
    chart_type: Optional[str] = None
    insights: Optional[str] = None
    message: str
    records_matched: Optional[int] = None
    query_plan: Optional[Dict[str, Any]] = None
    # ── New optional fields (backward-compatible) ─────────────────────────
    records_in_source: Optional[int] = None
    verified: Optional[bool] = None
    data_as_of: Optional[str] = None


@router.post("/generate", response_model=GraphResponse)
def generate_graph(req: GraphRequest):
    """
    Step 3 — Receive user's natural-language graph request.
    Classifies intent via IntentEngine and delegates to PythonGraphAgent for code generation & execution.
    """
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Graph prompt cannot be empty.")

    from api.platform.data_resolution import dataset_scope
    with dataset_scope(req.dataset_id):
        # Classify intent and structure query plan
        plan = req.query_plan.model_dump(exclude_none=True, by_alias=True) if req.query_plan else intent_engine.classify(req.prompt)
        result = analytics_engine.execute(plan)
        if not result.success:
            raise HTTPException(422, result.error)
        return GraphResponse(status="success", prompt=req.prompt,
                             image_base64=render_chart(result.data, req.chart_type), chart_type=req.chart_type,
                             message="Rendered from deterministic DataFrame results", query_plan=plan,
                             records_matched=result.records_matched, records_in_source=result.records_total)


class PythonGraphAgentRequest(BaseModel):
    prompt: Optional[str] = None
    query_plan: Optional[Dict[str, Any]] = None
    metric: Optional[str] = None
    dimension: Optional[str] = None
    chart_type: Optional[str] = None
    aggregation: Optional[str] = "SUM"
    dataset_id: Optional[str] = None


@router.post("/python-agent/generate")
def generate_python_graph_agent(req: PythonGraphAgentRequest):
    """
    Executes the full 10-step PythonGraphAgent workflow.
    Supports natural language prompt (Mode 2) OR structured data options without prompt (Mode 3).
    """
    from api.services.python_graph_agent import python_graph_agent
    from api.services.dataset_service import dataset_service
    from api.models.execution_context import current_selection
    from api.platform.data_resolution import selected_dataset

    selection_token = None
    if req.dataset_id:
        selection_token = current_selection.set(selected_dataset(req.dataset_id))

    prompt = req.prompt
    plan = dict(req.query_plan) if req.query_plan else {}

    if req.metric:
        plan["metric"] = req.metric
    if req.dimension:
        plan["dimension"] = req.dimension
    if req.chart_type:
        plan["chart_type"] = req.chart_type
    if req.aggregation:
        plan["aggregation"] = req.aggregation

    if not prompt:
        metric_name = req.metric or "Revenue"
        dim_name = req.dimension or "Region"
        chart_name = req.chart_type or "bar"
        prompt = f"Generate a {chart_name} chart of {req.aggregation or 'total'} {metric_name} by {dim_name}"

    try:
        result = python_graph_agent.generate_custom_graph(
            prompt=prompt,
            query_plan=plan if plan else None
        )
        return result
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"Custom graph generation failed: {str(e)}")
    finally:
        if selection_token is not None:
            current_selection.reset(selection_token)


class GenAIDashboardRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    dataset_id: Optional[str] = None
    conversation_history: Optional[List[Dict[str, str]]] = None


class GenAIWidgetExecutionRequest(BaseModel):
    widget: Dict[str, Any]
    dataset_id: Optional[str] = None


@router.post("/genai-dashboard/generate")
def generate_genai_dashboard(req: GenAIDashboardRequest):
    """
    Executes the 10-step Analysis-First Gen AI Dashboard workflow:
    Understand -> Explore -> Identify -> Relate -> Generate & Execute -> Validate -> Analyze -> Recommend -> Render -> Visualize.
    """
    from api.services.genai_dashboard_service import genai_dashboard_service

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Dashboard prompt cannot be empty.")

    from api.platform.data_resolution import dataset_scope
    try:
        with dataset_scope(req.dataset_id):
            return genai_dashboard_service.generate_dashboard(
                prompt=req.prompt,
                target_dataset_id=req.dataset_id,
                conversation_history=req.conversation_history
            )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Gen AI dashboard generation failed")
        raise HTTPException(status_code=500, detail="Dashboard generation failed. Retry the request.") from exc


@router.post("/genai-dashboard/generate-stream")
def generate_genai_dashboard_stream(req: GenAIDashboardRequest):
    """
    Real-time SSE Streaming endpoint for 10-step Analysis-First Gen AI Dashboard workflow.
    Streams progress events step-by-step as each stage executes, followed by final result.
    """
    from api.services.genai_dashboard_service import genai_dashboard_service

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Dashboard prompt cannot be empty.")

    from api.platform.data_resolution import dataset_scope, selected_dataset
    selected_dataset(req.dataset_id)  # Authorize before opening the SSE response.

    def event_stream():
        iterator = iter(genai_dashboard_service.generate_dashboard_stream(
            prompt=req.prompt, target_dataset_id=req.dataset_id, conversation_history=req.conversation_history))
        try:
            while True:
                # Each next() can run in a different threadpool context. Reset before yielding.
                with dataset_scope(req.dataset_id):
                    chunk = next(iterator)
                yield f"data: {json.dumps(chunk)}\n\n"
        except StopIteration:
            return
        except Exception as exc:
            if isinstance(exc, HTTPException):
                message = exc.detail
            elif isinstance(exc, ValueError):
                message = str(exc)
            else:
                logger.exception("Gen AI dashboard streaming failed")
                message = "Dashboard generation failed. Retry the request."
            yield f"data: {json.dumps({'type': 'error', 'message': message})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/genai-dashboard/execute-widget")
def execute_genai_widget(req: GenAIWidgetExecutionRequest):
    """Calculates data for an accepted proactive recommendation or customized widget."""
    from api.services.genai_dashboard_service import genai_dashboard_service

    from api.platform.data_resolution import dataset_scope
    try:
        with dataset_scope(req.dataset_id):
            return genai_dashboard_service.execute_single_widget(
                widget_spec=req.widget,
                target_dataset_id=req.dataset_id
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Widget execution failed: {str(e)}")



