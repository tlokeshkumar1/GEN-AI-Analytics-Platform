"""
Request Context — Observability & Structured Logging
======================================================
Tracks processing stages, timings, and metadata for each request.
"""

import uuid
import time
from typing import Dict, Any, List, Optional
from api.utils.logger import get_logger

logger = get_logger("utils.request_context")


class RequestContext:
    """
    Tracks a single request's lifecycle: intent, stages, timings, errors.
    Never logs API keys, passwords, or secrets.
    """

    def __init__(self):
        self.request_id: str = uuid.uuid4().hex[:12]
        self.start_time: float = time.time()
        self.intent: Optional[str] = None
        self.metric: Optional[str] = None
        self.dimension: Optional[str] = None
        self.model_used: Optional[str] = None
        self.filters: List[Dict[str, Any]] = []
        self.records_matched: int = 0
        self.stages: List[Dict[str, Any]] = []
        self.status: str = "pending"
        self.error: Optional[str] = None

        # Timing breakdown
        self.intent_time_ms: float = 0
        self.retrieval_time_ms: float = 0
        self.analytics_time_ms: float = 0
        self.llm_time_ms: float = 0
        self.graph_time_ms: float = 0

    def add_stage(self, stage: str, status: str, message: str,
                  details: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Add a processing stage and return it as a dict."""
        entry = {
            "stage": stage,
            "status": status,
            "message": message,
            "details": details,
            "timestamp_ms": round((time.time() - self.start_time) * 1000, 1),
        }
        self.stages.append(entry)
        return entry

    def get_processing_steps(self) -> List[Dict[str, Any]]:
        """Return stages in the format expected by ProcessingStep model."""
        return [
            {
                "stage": s["stage"],
                "status": s["status"],
                "message": s["message"],
                "details": s.get("details"),
            }
            for s in self.stages
        ]

    @property
    def total_time_ms(self) -> float:
        return round((time.time() - self.start_time) * 1000, 1)

    def finalize(self, status: str = "success") -> None:
        """Finalize and log the request summary."""
        self.status = status
        total = self.total_time_ms

        if not self.model_used:
            try:
                from api.services.ai_core_service import ai_core_service
                self.model_used = ai_core_service.last_used_model
            except Exception:
                pass

        log_data = {
            "request_id": self.request_id,
            "intent": self.intent,
            "metric": self.metric,
            "dimension": self.dimension,
            "model_used": self.model_used,
            "filters": len(self.filters),
            "records_matched": self.records_matched,
            "total_time_ms": total,
            "intent_time_ms": self.intent_time_ms,
            "retrieval_time_ms": self.retrieval_time_ms,
            "analytics_time_ms": self.analytics_time_ms,
            "llm_time_ms": self.llm_time_ms,
            "graph_time_ms": self.graph_time_ms,
            "status": self.status,
        }
        if self.error:
            log_data["error"] = self.error

        if status == "success":
            logger.info(f"[Request] {log_data}")
        else:
            logger.error(f"[Request] {log_data}")
