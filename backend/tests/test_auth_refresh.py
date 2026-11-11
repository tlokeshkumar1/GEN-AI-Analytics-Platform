"""Tests for XSUAA refresh token cookie issuance, rotation, and logout cleanup."""
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
routes_package = types.ModuleType("api.routes")
routes_package.__path__ = [str(Path(__file__).resolve().parents[1] / "api" / "routes")]
sys.modules.setdefault("api.routes", routes_package)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import auth as auth_routes


class AuthRefreshTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(auth_routes.router)
        self.client = TestClient(app)
        self.creds = {
            "url": "https://xsuaa.example.test",
            "clientid": "cid",
            "clientsecret": "csecret",
            "xsappname": "app",
        }
        self.claims = {"user_id": "u1", "email": "u1@example.test", "scope": ["app.Admin"], "sub": "u1", "iat": 1000, "exp": 1900}
        self.profile = {"user_id": "u1", "email": "u1@example.test", "name": "User One", "scopes": ["app.Admin"], "role": "Admin", "roles": ["Admin"]}

    def test_login_sets_httponly_refresh_cookie_and_refresh_rotates_access_token(self):
        login_oauth_res = Mock(status_code=200)
        login_oauth_res.json.return_value = {
            "access_token": "jwt-access-1",
            "refresh_token": "xsuaa-refresh-1",
            "expires_in": 900,
        }
        refresh_oauth_res = Mock(status_code=200)
        refresh_oauth_res.json.return_value = {
            "access_token": "jwt-access-2",
            "refresh_token": "xsuaa-refresh-2",
            "expires_in": 900,
        }

        with patch.object(auth_routes, "xsuaa_credentials", return_value=self.creds), \
             patch.object(auth_routes, "validate_token", return_value=(Mock(), self.claims)), \
             patch.object(auth_routes, "user_profile", return_value=self.profile), \
             patch("api.routes.auth.requests.post", side_effect=[login_oauth_res, refresh_oauth_res]) as mock_post:

            login_res = self.client.post("/api/auth/login", json={"email": "u1@example.test", "password": "secret", "rememberMe": True})
            self.assertEqual(login_res.status_code, 200, login_res.text)
            self.assertEqual(login_res.json()["token"], "jwt-access-1")
            self.assertEqual(login_res.json()["expires_in"], 900)
            self.assertIn("refresh_token=xsuaa-refresh-1", login_res.headers.get("set-cookie", ""))
            self.assertIn("HttpOnly", login_res.headers.get("set-cookie", ""))

            refresh_res = self.client.post("/api/auth/refresh", json={})
            self.assertEqual(refresh_res.status_code, 200, refresh_res.text)
            self.assertEqual(refresh_res.json()["token"], "jwt-access-2")
            self.assertEqual(refresh_res.json()["expires_in"], 900)
            self.assertIn("refresh_token=xsuaa-refresh-2", refresh_res.headers.get("set-cookie", ""))

            # Second call to XSUAA should have used grant_type=refresh_token
            self.assertEqual(mock_post.call_args_list[1].kwargs["data"]["grant_type"], "refresh_token")
            self.assertEqual(mock_post.call_args_list[1].kwargs["data"]["refresh_token"], "xsuaa-refresh-1")

            logout_res = self.client.post("/api/auth/logout")
            self.assertEqual(logout_res.status_code, 200)
            self.assertIn('refresh_token=""', logout_res.headers.get("set-cookie", ""))

    def test_refresh_without_cookie_or_expired_refresh_returns_401(self):
        with patch.object(auth_routes, "xsuaa_credentials", return_value=self.creds):
            res = self.client.post("/api/auth/refresh", json={})
            self.assertEqual(res.status_code, 401)

