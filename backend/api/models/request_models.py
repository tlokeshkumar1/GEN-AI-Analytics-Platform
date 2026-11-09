from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any

class ChatRequest(BaseModel):
    message: str = Field(..., description="User prompt or question")
    session_id: Optional[str] = Field("default", description="Conversation session ID")
    user_id: Optional[str] = Field(None, description="Authenticated User ID")
    top_k: Optional[int] = Field(5, description="Number of vector context matches")
    stream: Optional[bool] = Field(False, description="Enable SSE streaming for processing events")

class AnalyticsRequest(BaseModel):
    query: str = Field(..., description="Natural language analytics question")
    chart_type: Optional[str] = Field("auto", description="Requested chart format (bar, line, pie, auto)")

