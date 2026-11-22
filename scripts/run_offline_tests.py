"""Run backend regressions without reading .env or contacting external providers."""
import argparse
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pattern", default="test_*.py")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    sys.path.insert(0, str(root / "backend"))
    with tempfile.TemporaryDirectory(prefix="genai-tests-") as folder:
        environment = {key: "" for key in (
            "HANA_ADDRESS", "HANA_USER", "HANA_PASSWORD", "NVIDIA_API_KEY", "AICORE_CLIENT_ID",
            "AICORE_CLIENT_SECRET", "XSUAA_APPLICATION_CREDENTIALS", "VCAP_APPLICATION",
        )}
        environment.update(VCAP_SERVICES="{}", XSUAA_APPLICATION_CREDENTIALS="{}", APP_ENV="development", PLATFORM_METADATA_BACKEND="sqlite",
                           PLATFORM_OBJECT_BACKEND="local", PLATFORM_DATASET_BACKEND="local",
                           PLATFORM_CHAT_WORKSPACE_ACCESS="true", PLATFORM_AUTO_APPROVE_SEMANTICS="true",
                           PLATFORM_CATEGORICAL_NULL_POLICY="label",
                           PLATFORM_METADATA_PATH=str(Path(folder) / "metadata.sqlite3"))
        with patch.dict(os.environ, environment), patch("tempfile.tempdir", folder), \
             patch("dotenv.load_dotenv", return_value=False), \
             patch("requests.sessions.Session.request", side_effect=RuntimeError("External network disabled in offline tests")), \
             patch("hdbcli.dbapi.connect", side_effect=RuntimeError("Live HANA disabled in offline tests")):
            suite = unittest.defaultTestLoader.discover(str(root / "backend" / "tests"), pattern=args.pattern)
            result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
