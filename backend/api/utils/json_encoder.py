import decimal
import datetime
from typing import Any

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False

try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False


def hana_json_default(obj: Any) -> Any:
    """
    Universal JSON serializer for SAP HANA Cloud, NumPy, Pandas, and Python types.
    Prevents 'TypeError: Object of type Decimal is not JSON serializable' across all APIs.
    """
    if isinstance(obj, decimal.Decimal):
        try:
            return int(obj) if obj % 1 == 0 else float(obj)
        except Exception:
            return float(obj)

    if isinstance(obj, (datetime.date, datetime.datetime)):
        return obj.isoformat()

    if PANDAS_AVAILABLE:
        if isinstance(obj, pd.Timestamp):
            return obj.isoformat()
        if pd.isna(obj):
            return None

    if NUMPY_AVAILABLE:
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()

    if isinstance(obj, set):
        return list(obj)

    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")

    if hasattr(obj, "to_dict"):
        return obj.to_dict()

    if hasattr(obj, "dict") and callable(obj.dict):
        return obj.dict()

    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def safe_json_dumps(obj: Any, **kwargs) -> str:
    """Safe wrapper for json.dumps using the hana_json_default serializer."""
    import json
    return json.dumps(obj, default=hana_json_default, **kwargs)

