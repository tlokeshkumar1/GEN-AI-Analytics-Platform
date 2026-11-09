from fastapi import APIRouter
from api.models.request_models import AnalyticsRequest
from api.models.response_models import AnalyticsResponse
from api.services.analytics_service import analytics_service
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api/analytics", tags=["Analytics"])

@router.post("", response_model=AnalyticsResponse)
async def execute_analytics(req: AnalyticsRequest):
    res = await run_in_threadpool(analytics_service.process_analytics_query, req.query)
    return AnalyticsResponse(**res)
