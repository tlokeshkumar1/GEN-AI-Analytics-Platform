from fastapi import APIRouter, Header, Response

from api.services.xsuaa_users_service import list_users, require_user_admin

router = APIRouter(prefix="/api/users", tags=["User Management"])


@router.get("")
def get_users(response: Response, authorization: str | None = Header(None)):
    require_user_admin(authorization)
    response.headers["Cache-Control"] = "no-store"
    return list_users(authorization)
