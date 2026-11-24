from api.routes.health import router as health_router
from api.routes.dashboard import router as dashboard_router
from api.routes.analytics import router as analytics_router
from api.routes.chat import router as chat_router

__all__ = ["health_router", "dashboard_router", "analytics_router", "chat_router"]
