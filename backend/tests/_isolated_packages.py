"""Initialize package paths for isolated tests without eager router imports."""

import sys
import types
from pathlib import Path

for package in ("routes", "services", "database"):
    module = types.ModuleType(f"api.{package}")
    module.__path__ = [str(Path(__file__).resolve().parents[1] / "api" / package)]
    sys.modules.setdefault(f"api.{package}", module)
