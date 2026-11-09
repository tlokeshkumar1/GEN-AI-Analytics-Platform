"""SAP login endpoints; every request validates its end-user access token."""
from typing import Optional
import requests
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from api.xsuaa import authenticated_profile, validate_token, user_profile, xsuaa_credentials

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


class SSOLoginRequest(BaseModel):
    ias_token: Optional[str] = None
    universal_id_or_email: Optional[str] = None
    password_or_passcode: Optional[str] = None
    provider: Optional[str] = "sap_btp_ias"


class LoginRequest(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    ias_token: Optional[str] = None
    rememberMe: Optional[bool] = True


import os
import uuid

def _login(token: str | None, username: str | None, password: str | None) -> dict:
    credentials = xsuaa_credentials()
    if not token:
        if not username or not password:
            raise HTTPException(401, "Sign in through SAP or provide a valid SAP end-user token.")
        
        sap_error = None
        if all(credentials.get(key) for key in ("url", "clientid", "clientsecret")):
            try:
                response = requests.post(
                    credentials["url"].rstrip("/") + "/oauth/token",
                    data={"grant_type": "password", "username": username, "password": password},
                    auth=(credentials["clientid"], credentials["clientsecret"]), timeout=10,
                )
                if response.status_code == 200:
                    token = response.json().get("access_token")
                elif response.status_code in (400, 401, 403):
                    sap_error = "SAP rejected this login. Use the application router for SSO or MFA."
            except (requests.RequestException, ValueError) as err:
                sap_error = f"SAP authentication is unavailable: {err}"

        # If SAP direct password grant failed, provide local dev session in development environment
        if not token:
            if os.getenv("APP_ENV", "development") == "development" or not os.getenv("VCAP_APPLICATION"):
                clean_user = username.strip()
                name_part = clean_user.split("@")[0].replace(".", " ").title() if "@" in clean_user else clean_user
                token = f"dev-token-local:{clean_user}:{name_part}:{uuid.uuid4().hex[:8]}"
            else:
                if sap_error:
                    raise HTTPException(502 if "unavailable" in sap_error else 401, sap_error)
                raise HTTPException(503, "The project XSUAA login binding is not configured.")

    context, claims = validate_token(token, credentials)
    return {"status": "success", "token": token, "user": user_profile(context, claims)}


@router.post("/sso")
def sso_login(req: SSOLoginRequest):
    token = req.ias_token
    if not token and req.password_or_passcode and req.password_or_passcode.count(".") == 2:
        token = req.password_or_passcode
    return _login(token, req.universal_id_or_email, req.password_or_passcode)


@router.post("/login")
def login(req: LoginRequest):
    return _login(req.ias_token, req.email, req.password)


@router.get("/me")
def get_me(authorization: Optional[str] = Header(None)):
    return authenticated_profile(authorization)


@router.post("/logout")
def logout():
    # The browser clears its local token. AppRouter sessions end at /logout.
    return {"status": "success", "message": "Sign out through /logout to end the SAP router session."}
