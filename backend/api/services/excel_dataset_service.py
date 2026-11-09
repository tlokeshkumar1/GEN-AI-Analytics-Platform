import os
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from datetime import datetime, timezone
import pandas as pd
from api.config import settings
from api.utils.logger import get_logger

logger = get_logger("services.excel_dataset_service")


class ExcelDatasetService:
    def __init__(self):
        self._df: Optional[pd.DataFrame] = None
        self._records_count: Optional[int] = None
        self._data_as_of: Optional[datetime] = None
        self._file_mtime: Optional[float] = None
        self._last_load_time: Optional[datetime] = None
        self._loaded_path: Optional[Path] = None
        import tempfile
        self._default_path = Path(tempfile.gettempdir()) / "HANA_ACTIVE_DATASET.pkl"

    def _resolve_dataset_path(self) -> Path:
        import tempfile
        return Path(tempfile.gettempdir()) / "HANA_ACTIVE_DATASET.pkl"

    def _needs_reload(self) -> bool:
        """Determine whether the dataset should be reloaded from SAP HANA Cloud."""
        if self._df is None or self._df.empty:
            return True
        if self._last_load_time is not None:
            elapsed = (datetime.now(timezone.utc) - self._last_load_time).total_seconds()
            refresh_seconds = settings.DATA_REFRESH_INTERVAL_MINUTES * 60
            if elapsed >= refresh_seconds:
                return True
        return False

    def _load_dataset(self) -> pd.DataFrame:
        """Load dataset directly from SAP HANA Cloud as the single source of truth."""
        try:
            from api.database.hana_client import hana_client
            from api.platform.datasets_metadata_repository import datasets_metadata_repo
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            hint = None
            if sel and getattr(sel, "entry", None):
                hint = sel.entry.get("physical_table_name") or sel.entry.get("name")
            target_table = datasets_metadata_repo._resolve_physical_table(hint)

            # Query actual total count safely from HANA
            cnt_rows = hana_client.execute_query(f'SELECT COUNT(*) AS CNT FROM "{target_table}"')
            self._records_count = int(cnt_rows[0].get("CNT") or 0) if cnt_rows else None

            # Bounded sample (e.g. 2000 rows) for schema introspection without OOM on Cloud Foundry
            rows = hana_client.execute_query(f'SELECT * FROM "{target_table}" LIMIT 2000')
            if rows:
                self._df = pd.DataFrame(rows)
                self._loaded_path = None
                self._file_mtime = None
                self._data_as_of = datetime.now(timezone.utc)
                self._last_load_time = datetime.now(timezone.utc)
                logger.info(f"Loaded schema sample of {len(self._df)} rows (Total: {self._records_count}) from SAP HANA Cloud table '{target_table}'.")
                return self._df
        except Exception as e:
            logger.warning(f"Could not load directly from SAP HANA Cloud: {e}")

        logger.warning("Returning empty DataFrame until active in SAP HANA Cloud.")
        self._df = pd.DataFrame()
        self._records_count = 0
        self._data_as_of = None
        self._file_mtime = None
        self._last_load_time = datetime.now(timezone.utc)
        return self._df

    def get_df(self) -> pd.DataFrame:
        """
        Return the current DataFrame, reloading from disk if stale or unloaded.
        Guarantees freshness within DATA_REFRESH_INTERVAL_MINUTES.
        """
        from api.models.execution_context import current_selection
        selection = current_selection.get()
        if selection is not None:
            rows = selection.snapshot.get("rows")
            if rows:
                from api.services.dataset_service import dataset_service
                return dataset_service._frame(rows, selection.snapshot.get("columns", []))
            # If snapshot rows are empty (e.g. data stored in HANA column table), load from HANA Cloud
        if self._needs_reload():
            self._load_dataset()
        return self._df

    def get_data_as_of(self) -> Optional[str]:
        """Return the ISO 8601 UTC timestamp of the data source's last modification."""
        self.get_df()
        return self._data_as_of.isoformat() if self._data_as_of else None

    def get_records_in_source(self) -> int:
        """Return the total number of records in the source dataset."""
        if self._records_count is not None:
            return self._records_count
        df = self.get_df()
        return len(df) if df is not None else 0

    def get_dataset_path(self) -> Path:
        return self._resolve_dataset_path()

    def get_fast_dataset_path(self) -> Path:
        """Return a fast path for external scripts (like PythonGraphAgent) in temp dir without local output dependencies."""
        import tempfile
        temp_pkl = Path(tempfile.gettempdir()) / "HANA_ACTIVE_DATASET.pkl"
        df = self.get_df()
        if df is not None and not df.empty:
            try:
                df.to_pickle(temp_pkl)
                return temp_pkl
            except Exception:
                pass
        return temp_pkl

    def parse_dataset(self, file_path: str) -> Dict[str, Any]:
        df = self.get_df()
        return {
            "status": "success",
            "file_path": str(self._default_path),
            "rows": len(df),
            "columns": df.columns.tolist(),
            "data_as_of": self.get_data_as_of(),
        }

    def check_health(self, max_stale_hours: Optional[float] = None) -> Dict[str, Any]:
        """
        Perform a loud health check on the data source.
        Raises RuntimeError if:
          - The dataset file cannot be found.
          - The dataset file is empty.
          - The data is staler than max_stale_hours.
        Returns a status dict on success.
        """
        threshold = max_stale_hours if max_stale_hours is not None else settings.DATA_STALE_MAX_HOURS

        resolved_path = self._resolve_dataset_path()
        if not resolved_path.exists():
            msg = f"[HealthCheck FAIL] Dataset file not found at any candidate path. Primary: {self._default_path}"
            logger.error(msg)
            raise RuntimeError(msg)

        file_size = resolved_path.stat().st_size
        if file_size == 0:
            msg = f"[HealthCheck FAIL] Dataset file is empty (0 bytes): {resolved_path}"
            logger.error(msg)
            raise RuntimeError(msg)

        file_mtime = datetime.fromtimestamp(resolved_path.stat().st_mtime, tz=timezone.utc)
        age_hours = (datetime.now(timezone.utc) - file_mtime).total_seconds() / 3600.0

        if age_hours > threshold:
            msg = (
                f"[HealthCheck FAIL] Dataset is stale: last modified {age_hours:.1f} hours ago "
                f"(threshold: {threshold:.1f} hours). Path: {resolved_path}"
            )
            logger.error(msg)
            raise RuntimeError(msg)

        # Try actually reading the file
        try:
            df = self.get_df()
            if df.empty:
                msg = f"[HealthCheck FAIL] Dataset loaded but contains 0 rows: {resolved_path}"
                logger.error(msg)
                raise RuntimeError(msg)
        except FileNotFoundError:
            raise
        except Exception as exc:
            msg = f"[HealthCheck FAIL] Cannot read dataset: {exc}"
            logger.error(msg)
            raise RuntimeError(msg) from exc

        result = {
            "status": "healthy",
            "path": str(resolved_path),
            "rows": len(df),
            "columns": len(df.columns),
            "data_as_of": file_mtime.isoformat(),
            "age_hours": round(age_hours, 2),
            "threshold_hours": threshold,
        }
        logger.info(f"[HealthCheck OK] {result}")
        return result


excel_dataset_service = ExcelDatasetService()
