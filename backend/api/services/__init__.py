"""Load service exports on demand, without database writes during package import."""
from importlib import import_module

__all__ = ["hana_service", "ai_core_service", "vector_service", "embedding_service", "analytics_service", "dashboard_service"]


def __getattr__(name):
    if name in __all__:
        value = getattr(import_module(f"api.services.{name}"), name)
        globals()[name] = value
        return value
    raise AttributeError(name)
