from fastapi import APIRouter
from api.models.request_models import AnalyticsRequest
from api.models.response_models import AnalyticsResponse
from api.services.analytics_service import analytics_service

router = APIRouter(prefix="/api/analytics", tags=["Analytics"])

@router.post("", response_model=AnalyticsResponse)
def execute_analytics(req: AnalyticsRequest):
    res = analytics_service.process_analytics_query(req.query)
    return AnalyticsResponse(**res)
