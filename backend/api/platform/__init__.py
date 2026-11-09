"""Shared metadata, ingestion and review contracts for the analytics platform."""
import importlib.util as _util
import os as _os
import sys as _sys

import sysconfig as _sysconfig

# Re-export Python standard library 'platform' attributes.
# When commands like 'uvicorn app:app' are executed from inside backend/api,
# Python's import resolver finds this local 'platform' package on sys.path[0].
# Bridging to the standard library module prevents 'AttributeError' in pandas,
# uvicorn, and other ecosystem packages while keeping platform submodules accessible.
_stdlib_candidates = []
_stdlib_dir = _sysconfig.get_path("stdlib")
if _stdlib_dir:
    _stdlib_candidates.append(_os.path.join(_stdlib_dir, "platform.py"))

_stdlib_candidates.extend([
    _os.path.join(_sys.base_prefix, "Lib", "platform.py"),
    _os.path.join(_sys.base_prefix, "lib", f"python{_sys.version_info.major}.{_sys.version_info.minor}", "platform.py"),
    _os.path.join(_sys.base_prefix, "lib64", f"python{_sys.version_info.major}.{_sys.version_info.minor}", "platform.py"),
])

_std_mod = None
for _candidate in _stdlib_candidates:
    if _os.path.isfile(_candidate):
        _spec = _util.spec_from_file_location(__name__, _candidate)
        if _spec and _spec.loader:
            _std_mod = _util.module_from_spec(_spec)
            _spec.loader.exec_module(_std_mod)
            break

if _std_mod is not None:
    for _name in dir(_std_mod):
        if not _name.startswith("__"):
            globals()[_name] = getattr(_std_mod, _name)

    def __getattr__(name):
        if hasattr(_std_mod, name):
            return getattr(_std_mod, name)
        raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
