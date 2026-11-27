"""Offline Cloud Foundry compatibility with synthetic bindings, never live services."""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch

from fastapi import HTTPException

from api import worker, xsuaa

ROOT = Path(__file__).resolve().parents[2]
XSUAA = {
    "clientid": "cf-test-client",
    "clientsecret": "synthetic-not-a-secret",
    "xsappname": "cf-test",
    "url": "https://uaa.example.test",
}
BINDINGS = {
    "xsuaa": [{"name": "cf-test-xsuaa", "plan": "application", "credentials": XSUAA}],
    "hana": [
        {
            "name": "cf-test-hdi",
            "credentials": {
                "host": "hana.example.test",
                "port": "443",
                "user": "CF_TEST",
                "password": "synthetic-not-a-secret",
                "schema": "CF_TEST_SCHEMA",
            },
        }
    ],
}


class CloudFoundryCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(
            os.environ,
            {
                "VCAP_APPLICATION": json.dumps({"application_name": "cf-test-api"}),
                "VCAP_SERVICES": json.dumps(BINDINGS),
                "XSUAA_SERVICE_NAME": "cf-test-xsuaa",
                "APP_ENV": "production",
                "PORT": "18080",
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_cf_config_reads_bindings_and_dynamic_port_without_dotenv(self):
        # Fresh interpreter: import-time settings must use CF bindings, not local .env.
        env = dict(os.environ)
        for key in (
            "HANA_ADDRESS",
            "HANA_PORT",
            "HANA_USER",
            "HANA_PASSWORD",
            "HANA_SCHEMA",
        ):
            env.pop(key, None)
        code = """
from unittest.mock import patch
with patch('dotenv.load_dotenv', side_effect=AssertionError('CF must not load .env')):
    from api.config import settings
assert settings.PORT == 18080
assert settings.APP_ENV == 'production'
assert settings.HANA_ADDRESS == 'hana.example.test'
assert settings.HANA_USER == 'CF_TEST'
assert settings.HANA_SCHEMA == 'CF_TEST_SCHEMA'
assert settings.XSUAA_CLIENT_ID == 'cf-test-client'
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=ROOT / "backend",
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_xsuaa_uses_the_named_cf_binding(self):
        self.assertEqual(xsuaa.xsuaa_credentials(), XSUAA)

    def test_missing_named_xsuaa_binding_fails_closed(self):
        with patch.dict(os.environ, {"XSUAA_SERVICE_NAME": "missing-service"}):
            with self.assertRaises(HTTPException) as raised:
                xsuaa.xsuaa_credentials()
        self.assertEqual(raised.exception.status_code, 503)

    def test_cf_rejects_development_tokens_even_in_development_mode(self):
        with patch.dict(os.environ, {"APP_ENV": "development"}):
            with self.assertRaises(HTTPException) as raised:
                xsuaa.validate_token("dev-token-forbidden", XSUAA)
        self.assertEqual(raised.exception.status_code, 401)

    def test_separate_worker_polls_configured_workspace_and_exits_once(self):
        jobs = ModuleType("api.platform.jobs")
        jobs.job_service = Mock()
        jobs.job_service.run_next.return_value = None
        with (
            patch.dict(sys.modules, {"api.platform.jobs": jobs}),
            patch.dict(os.environ, {"PLATFORM_WORKSPACE_ID": "cf-test-workspace"}),
            patch.object(sys, "argv", ["api.worker", "--once"]),
        ):
            worker.main()
        jobs.job_service.heartbeat.assert_called_once()
        self.assertEqual(
            jobs.job_service.heartbeat.call_args.args[1], "cf-test-workspace"
        )
        jobs.job_service.run_next.assert_called_once_with("cf-test-workspace")

    def test_worker_failure_is_observable_to_cf_task(self):
        jobs = ModuleType("api.platform.jobs")
        jobs.job_service = Mock()
        jobs.job_service.run_next.side_effect = RuntimeError("synthetic poll failure")
        with (
            patch.dict(sys.modules, {"api.platform.jobs": jobs}),
            patch.object(sys, "argv", ["api.worker", "--once"]),
            self.assertLogs("api.worker", level="ERROR"),
        ):
            with self.assertRaisesRegex(RuntimeError, "synthetic poll failure"):
                worker.main()


if __name__ == "__main__":
    unittest.main()
