"""SAP login endpoints; every request validates its end-user access token."""
import os
import uuid
from typing import Optional
import requests
from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel
from api.xsuaa import authenticated_profile, validate_token, user_profile, xsuaa_credentials

router = APIRouter(prefix="/api/auth", tags=["Authentication"])

REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_MAX_AGE = 43200  # 12 hours, matching xs-security.json refresh-token-validity


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


class RefreshRequest(BaseModel):
    refresh_token: Optional[str] = None


def _is_https_request(request: Optional[Request]) -> bool:
    if request is None:
        return False
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return forwarded == "https" or request.url.scheme == "https"


def _set_refresh_cookie(
    response: Optional[Response],
    request: Optional[Request],
    refresh_token: Optional[str],
    remember_me: bool = True,
) -> None:
    if response is None or not refresh_token:
        return
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=refresh_token,
        httponly=True,
        samesite="lax",
        secure=_is_https_request(request),
        path="/api/auth",
        max_age=REFRESH_COOKIE_MAX_AGE if remember_me else None,
    )


def _clear_refresh_cookie(response: Optional[Response], request: Optional[Request]) -> None:
    if response is None:
        return
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path="/api/auth",
        httponly=True,
        samesite="lax",
        secure=_is_https_request(request),
    )


def _login(
    token: str | None,
    username: str | None,
    password: str | None,
    request: Optional[Request] = None,
    response: Optional[Response] = None,
    remember_me: bool = True,
) -> dict:
    credentials = xsuaa_credentials()
    refresh_token: str | None = None
    expires_in: int | None = None

    if not token:
        if not username or not password:
            raise HTTPException(401, "Sign in through SAP or provide a valid SAP end-user token.")

        sap_error = None
        if all(credentials.get(key) for key in ("url", "clientid", "clientsecret")):
            try:
                oauth_res = requests.post(
                    credentials["url"].rstrip("/") + "/oauth/token",
                    data={"grant_type": "password", "username": username, "password": password},
                    auth=(credentials["clientid"], credentials["clientsecret"]),
                    timeout=10,
                )
                if oauth_res.status_code == 200:
                    payload = oauth_res.json()
                    token = payload.get("access_token")
                    refresh_token = payload.get("refresh_token")
                    expires_in = payload.get("expires_in")
                elif oauth_res.status_code in (400, 401, 403):
                    sap_error = "SAP rejected this login. Use the application router for SSO or MFA."
            except (requests.RequestException, ValueError) as err:
                sap_error = f"SAP authentication is unavailable: {err}"

        # If SAP direct password grant failed, provide local dev session in development environment
        if not token:
            if os.getenv("APP_ENV", "development") == "development" or not os.getenv("VCAP_APPLICATION"):
                from urllib.parse import quote
                stripped_user = username.strip()
                clean_user = quote(stripped_user, safe="@.")
                raw_name = stripped_user.split("@")[0].replace(".", " ").title() if "@" in stripped_user else stripped_user
                name_part = quote(raw_name, safe="")
                token = f"dev-token-local:{clean_user}:{name_part}:{uuid.uuid4().hex[:8]}"
            else:
                if sap_error:
                    raise HTTPException(502 if "unavailable" in sap_error else 401, sap_error)
                raise HTTPException(503, "The project XSUAA login binding is not configured.")

    context, claims = validate_token(token, credentials)
    if expires_in is None and isinstance(claims, dict) and claims.get("exp") and claims.get("iat"):
        try:
            expires_in = max(1, int(claims["exp"]) - int(claims["iat"]))
        except (TypeError, ValueError):
            expires_in = None

    _set_refresh_cookie(response, request, refresh_token, remember_me=remember_me)
    result = {"status": "success", "token": token, "user": user_profile(context, claims)}
    if expires_in is not None:
        result["expires_in"] = expires_in
    return result


@router.post("/sso")
def sso_login(req: SSOLoginRequest, request: Request, response: Response):
    token = req.ias_token
    if not token and req.password_or_passcode and req.password_or_passcode.count(".") == 2:
        token = req.password_or_passcode
    return _login(token, req.universal_id_or_email, req.password_or_passcode, request=request, response=response)


@router.post("/login")
def login(req: LoginRequest, request: Request, response: Response):
    return _login(
        req.ias_token,
        req.email,
        req.password,
        request=request,
        response=response,
        remember_me=True if req.rememberMe is None else bool(req.rememberMe),
    )


@router.post("/refresh")
def refresh_session(
    request: Request,
    response: Response,
    req: Optional[RefreshRequest] = None,
):
    """Exchange a valid HttpOnly XSUAA refresh_token cookie for a fresh access_token."""
    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME) or (req.refresh_token if req else None)
    if not refresh_token:
        raise HTTPException(401, "Your SAP session has expired. Sign in again.")

    credentials = xsuaa_credentials()
    if not all(credentials.get(key) for key in ("url", "clientid", "clientsecret")):
        raise HTTPException(503, "The project XSUAA login binding is not configured.")

    try:
        oauth_res = requests.post(
            credentials["url"].rstrip("/") + "/oauth/token",
            data={"grant_type": "refresh_token", "refresh_token": refresh_token},
            auth=(credentials["clientid"], credentials["clientsecret"]),
            timeout=10,
        )
    except requests.RequestException as err:
        raise HTTPException(502, f"SAP token refresh is unavailable: {err}") from None

    if oauth_res.status_code in (400, 401, 403):
        _clear_refresh_cookie(response, request)
        raise HTTPException(401, "Your SAP session has expired. Sign in again.")
    if oauth_res.status_code != 200:
        raise HTTPException(502, f"SAP token refresh failed with status {oauth_res.status_code}.")

    try:
        payload = oauth_res.json()
    except ValueError:
        raise HTTPException(502, "SAP token refresh returned an invalid response.") from None

    new_token = payload.get("access_token")
    if not new_token:
        _clear_refresh_cookie(response, request)
        raise HTTPException(401, "Your SAP session has expired. Sign in again.")

    next_refresh = payload.get("refresh_token") or refresh_token
    expires_in = payload.get("expires_in")
    context, claims = validate_token(new_token, credentials)
    if expires_in is None and isinstance(claims, dict) and claims.get("exp") and claims.get("iat"):
        try:
            expires_in = max(1, int(claims["exp"]) - int(claims["iat"]))
        except (TypeError, ValueError):
            expires_in = None

    _set_refresh_cookie(response, request, next_refresh, remember_me=True)
    result = {"status": "success", "token": new_token, "user": user_profile(context, claims)}
    if expires_in is not None:
        result["expires_in"] = expires_in
    return result


@router.get("/me")
def get_me(authorization: Optional[str] = Header(None)):
    return authenticated_profile(authorization)


@router.post("/logout")
def logout(request: Request, response: Response):
    # Clear HttpOnly refresh cookie; browser clears local token and AppRouter sessions end at /logout.
    _clear_refresh_cookie(response, request)
    return {"status": "success", "message": "Sign out through /logout to end the SAP router session."}
