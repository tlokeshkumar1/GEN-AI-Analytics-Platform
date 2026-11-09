import sys
from pathlib import Path

# Ensure backend directory is in sys.path for module imports (e.g. from api....)
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.config import settings
from api.utils.context_middleware import DatasetContextMiddleware
from api.routes.health import router as health_router
from api.routes.auth import router as auth_router
from api.routes.users import router as users_router
from api.routes.dashboard import router as dashboard_router
from api.routes.analytics import router as analytics_router
from api.routes.chat import router as chat_router
from api.routes.chat_stream import router as chat_stream_router
from api.routes.graph import router as graph_router
from api.routes.upload import router as upload_router
from api.routes.datasets import router as datasets_router
from api.routes.semantic import router as semantic_router
from api.routes.system import router as system_router
from api.routes.database import router as database_router
from api.routes.hanaadmin import router as hanaadmin_router

app = FastAPI(
    title="GEN-AI Analytics Platform API",
    description="Enterprise Analytics & RAG Service powered by SAP HANA Cloud & SAP AI Core",
    version="1.0.0"
)

# Initialise chat history tables on startup
@app.on_event("startup")
def startup_init_chat_tables():
    try:
        from api.services.history_service import history_service
        history_service.init_tables()
    except Exception as e:
        import logging
        logging.getLogger("app").warning(f"Chat history table init skipped: {e}")

# CORS configuration
allowed_origins_list = [o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()]
app.add_middleware(DatasetContextMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins_list,
    allow_origin_regex=r"^https:\/\/.*(?:\.hana\.ondemand\.com|\.applicationstudio\.cloud\.sap|\.cfapps\..*\.hana\.ondemand\.com)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health_router)
app.include_router(auth_router)
app.include_router(users_router)
app.include_router(dashboard_router)
app.include_router(analytics_router)
app.include_router(chat_router)
app.include_router(chat_stream_router)
app.include_router(graph_router)
app.include_router(upload_router)
app.include_router(datasets_router)
app.include_router(semantic_router)
app.include_router(system_router)
app.include_router(database_router)
app.include_router(hanaadmin_router)

@app.get("/")
def root():
    return {
        "message": "Welcome to GEN-AI Analytics Platform API",
        "docs": "/docs",
        "health": "/api/health"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=settings.PORT, reload=True)
