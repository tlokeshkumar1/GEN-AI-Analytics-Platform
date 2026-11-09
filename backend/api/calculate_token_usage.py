#!/usr/bin/env python3
"""
backend/api/calculate_token_usage.py
====================================
Runner & Re-export for calculate_token_usage.
Ensures calculate_token_usage.py works directly inside backend/api and can be imported
by backend services without sys.path issues.
"""

from pathlib import Path
import sys

# Find root directory
current = Path(__file__).resolve().parent
root_dir = current.parent.parent
if str(root_dir) not in sys.path:
    sys.path.insert(0, str(root_dir))

# Import everything from root calculate_token_usage
try:
    from calculate_token_usage import (
        record_token_usage,
        estimate_tokens,
        load_token_history,
        test_live_api_call,
        run_live_monitor,
        main
    )
except ImportError:
    # If root file cannot be loaded directly, execute it
    root_script = root_dir / "calculate_token_usage.py"
    if root_script.exists():
        import importlib.util
        spec = importlib.util.spec_from_file_location("calculate_token_usage", str(root_script))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        record_token_usage = mod.record_token_usage
        estimate_tokens = mod.estimate_tokens
        load_token_history = mod.load_token_history
        test_live_api_call = mod.test_live_api_call
        run_live_monitor = mod.run_live_monitor
        main = mod.main


if __name__ == "__main__":
    main()
