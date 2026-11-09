"""Three logical agents coordinated through persisted, validated stage outputs."""
from typing import Literal
from pydantic import BaseModel, Field
from api.models.execution_context import current_identity, require_dataset_access
from api.platform.contracts import DataProfile, TransformationPlan, SemanticModel, AnalyticsPlan
from api.platform.semantic import semantic_registry, now


class EngineeringOutput(BaseModel):
    dataset_id: str
    version: int
    profile: DataProfile | None
    transformation_plan: TransformationPlan | None


class WorkflowState(BaseModel):
    dataset_id: str
    version: int
    stage: Literal["data_engineering", "semantic_modelling", "semantic_review", "analytics_planning", "analytics_review", "failed"]
    status: Literal["running", "awaiting_review", "completed", "failed"]
    attempts: int = Field(ge=1)
    outputs: dict
    updated_at: str
    error: str | None = None


class DataEngineeringAgent:
    def output(self, entry, version, snapshot):
        return EngineeringOutput(dataset_id=entry["id"], version=version, profile=snapshot.get("dataProfile"),
                                 transformation_plan=snapshot.get("transformationPlan"))


class SemanticModellingAgent:
    def propose(self, entry, version, snapshot, overrides=None) -> SemanticModel:
        return semantic_registry.propose(entry, version, snapshot, overrides)


class AnalyticsPlanningAgent:
    def propose(self, entry, version, revision, snapshot) -> AnalyticsPlan:
        return semantic_registry.propose_analytics(entry, version, revision, snapshot)


class WorkflowOrchestrator:
    def state(self, entry, version):
        require_dataset_access(entry)
        row = semantic_registry.store.get(semantic_registry.namespace(entry, version, "workflow"), "run")
        return row["value"] if row else None

    def save(self, entry, version, stage, status, outputs, error=None):
        namespace = semantic_registry.namespace(entry, version, "workflow")
        row = semantic_registry.store.get(namespace, "run")
        value = WorkflowState(dataset_id=entry["id"], version=version, stage=stage, status=status,
                              attempts=max(1, (row["value"]["attempts"] if row else 0) + (1 if status == "running" else 0)),
                              outputs={**(row["value"]["outputs"] if row else {}), **outputs}, updated_at=now(), error=error)
        semantic_registry.store.put(namespace, "run", value.model_dump(mode="json"), row["revision"] if row else 0)
        return value

    def propose_semantics(self, entry, version, snapshot, overrides=None):
        require_dataset_access(entry, write=True)
        engineering = DataEngineeringAgent().output(entry, version, snapshot)
        self.save(entry, version, "semantic_modelling", "running", {"data_engineering": engineering.model_dump(mode="json")})
        try:
            model = SemanticModellingAgent().propose(entry, version, snapshot, overrides)
            self.save(entry, version, "semantic_review", "awaiting_review", {"semantic_revision": model.revision})
            return model
        except Exception as exc:
            self.save(entry, version, "failed", "failed", {}, "Semantic proposal failed. Review the source profile and semantic constraints.")
            raise

    def propose_analytics(self, entry, version, revision, snapshot):
        require_dataset_access(entry, write=True)
        semantic_registry.get(entry, version, revision, approved=True)
        self.save(entry, version, "analytics_planning", "running", {"semantic_revision": revision})
        try:
            plan = AnalyticsPlanningAgent().propose(entry, version, revision, snapshot)
            self.save(entry, version, "analytics_review", "awaiting_review", {"analytics_items": [{"id": item.id, "revision": item.revision} for item in plan.items]})
            return plan
        except Exception:
            self.save(entry, version, "failed", "failed", {}, "Analytics planning failed. Review approved field meanings and aggregations.")
            raise


workflow_orchestrator = WorkflowOrchestrator()
