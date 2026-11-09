from fastapi import APIRouter, Depends
from api.models.response_models import HealthResponse
from api.database.connection import db_manager
from api.services.ai_core_service import ai_core_service

router = APIRouter(prefix="/api", tags=["Health & Authentication"])

@router.get("/health", response_model=HealthResponse)
def get_health_status():
    hana_status = db_manager.is_connected()
    
    return HealthResponse(
        status="available" if hana_status else "degraded",
        app_name="GEN-AI Analytics Platform API",
        version="1.0.0",
        hana_connected=hana_status,
        ai_core_connected=None,
        ai_core_configured=bool(ai_core_service.client_id)
    )

@router.get("/health/test-version")
def get_test_version():
    return {"version": "v_test_12345"}

