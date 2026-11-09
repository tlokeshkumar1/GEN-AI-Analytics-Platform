"""Load database clients only when requested."""
from importlib import import_module

_EXPORTS = {"db_manager": "connection", "hana_client": "hana_client", "vector_client": "vector_client"}
__all__ = list(_EXPORTS)


def __getattr__(name):
    if name in _EXPORTS:
        value = getattr(import_module(f"api.database.{_EXPORTS[name]}"), name)
        globals()[name] = value
        return value
    raise AttributeError(name)
