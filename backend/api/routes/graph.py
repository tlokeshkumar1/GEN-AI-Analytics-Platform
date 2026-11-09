from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
from api.services.intent_engine import intent_engine
from api.models.query_plan import QueryPlan
from api.services.analytics_engine import analytics_engine
from api.platform.charts import render_chart

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
    if not os.getenv("PLATFORM_CHART_IMAGE"):
        raise HTTPException(503, "Configure an isolated chart worker image before requesting advanced charts.")
    return job_service.enqueue("custom_chart", {"dataset_id": selection.context.dataset_id,
                               "context": selection.context.model_dump(), "query_plan": req.query_plan.model_dump(exclude_none=True, by_alias=True),
                               "prompt": req.prompt}, req.idempotency_key)


class GraphRequest(BaseModel):
    prompt: str = Field(..., description="Natural language description of requested visualization")
    query_plan: Optional[QueryPlan] = None
    chart_type: str = "bar"


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


@router.post("/python-agent/generate")
def generate_python_graph_agent(req: PythonGraphAgentRequest):
    """
    Executes the full 10-step PythonGraphAgent workflow.
    Supports natural language prompt (Mode 2) OR structured data options without prompt (Mode 3).
    """
    from api.services.python_graph_agent import python_graph_agent

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
        raise HTTPException(status_code=500, detail=f"Custom graph generation failed: {str(e)}")


