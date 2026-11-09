"""Authenticated SAP user context for API requests and chat ownership."""
from typing import Any, Dict, List, Optional
from fastapi import Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from api.xsuaa import authenticated_profile

security_scheme = HTTPBearer(auto_error=False)


class UserContext:
    def __init__(self, user_id: str, email: str, name: str, scopes: List[str], role: str, roles: List[str]):
        self.user_id = user_id
        self.email = email
        self.name = name
        self.scopes = scopes
        self.role = role
        self.roles = roles

    def to_dict(self) -> Dict[str, Any]:
        return vars(self).copy()


def get_current_user(auth: Optional[HTTPAuthorizationCredentials] = Security(security_scheme)) -> UserContext:
    authorization = f"Bearer {auth.credentials}" if auth else None
    return UserContext(**authenticated_profile(authorization))


def get_user_id_from_request(request: Request, body_user_id: Optional[str] = None) -> str:
    """Only a verified end-user token can establish ownership; ignore client IDs."""
    return authenticated_profile(request.headers.get("authorization"))["user_id"]
