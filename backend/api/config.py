import os
import json
from pathlib import Path
from dotenv import load_dotenv
from pydantic import field_validator
from pydantic_settings import BaseSettings

# Load environment variables from root or local directory
BASE_DIR = Path(__file__).resolve().parent.parent.parent
env_path = BASE_DIR / ".env"
if not os.getenv("VCAP_APPLICATION"):
    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
    else:
        load_dotenv()

def _get_hana_credentials_from_vcap():
    """Extract HANA credentials from VCAP_SERVICES (CF environment)."""
    vcap_services = os.getenv("VCAP_SERVICES")
    if not vcap_services:
        return {}
    try:
        services = json.loads(vcap_services)
        # HDI container credentials are under 'hana' key
        hana_services = services.get("hana", [])
        for svc in hana_services:
            creds = svc.get("credentials", {})
            if creds.get("host") and creds.get("user") and creds.get("password"):
                return {
                    "host": creds.get("host", ""),
                    "port": int(creds.get("port", 443)),
                    "user": creds.get("user", ""),
                    "password": creds.get("password", ""),
                    "schema": creds.get("schema", ""),
                }
    except Exception:
        pass
    return {}

def _get_aicore_credentials_from_vcap():
    """Extract AI Core credentials from VCAP_SERVICES (CF environment)."""
    vcap_services = os.getenv("VCAP_SERVICES")
    if not vcap_services:
        return {}
    try:
        services = json.loads(vcap_services)
        aicore_services = services.get("aicore", [])
        for svc in aicore_services:
            creds = svc.get("credentials", {})
            if creds.get("clientid"):
                auth_url = creds.get("url", "")
                if auth_url and not auth_url.endswith("/oauth/token"):
                    auth_url = auth_url.rstrip("/") + "/oauth/token"
                service_urls = creds.get("serviceurls", {})
                base_url = service_urls.get("AI_API_URL", "")
                return {
                    "client_id": creds.get("clientid", ""),
                    "client_secret": creds.get("clientsecret", ""),
                    "auth_url": auth_url,
                    "base_url": base_url
                }
    except Exception:
        pass
    return {}

def _get_xsuaa_credentials_from_vcap():
    """Extract XSUAA credentials from VCAP_SERVICES or environment."""
    from api.xsuaa import xsuaa_credentials
    credentials = xsuaa_credentials()
    url = credentials.get("url", "")
    return {
        "client_id": credentials.get("clientid", ""),
        "client_secret": credentials.get("clientsecret", ""),
        "auth_url": url.rstrip("/") + "/oauth/token" if url else "",
        "url": url, "xsappname": credentials.get("xsappname", ""),
        "verification_key": credentials.get("verificationkey", ""),
        "identity_zone": credentials.get("identityzone", ""),
    }


_vcap_hana = _get_hana_credentials_from_vcap()
_vcap_aicore = _get_aicore_credentials_from_vcap()
_vcap_xsuaa = _get_xsuaa_credentials_from_vcap()

class Settings(BaseSettings):
    # SAP XSUAA Security Configuration
    XSUAA_URL: str = _vcap_xsuaa.get("url") or os.getenv("XSUAA_URL", "")
    XSUAA_AUTH_URL: str = _vcap_xsuaa.get("auth_url") or os.getenv("XSUAA_AUTH_URL", "")
    XSUAA_CLIENT_ID: str = _vcap_xsuaa.get("client_id") or os.getenv("XSUAA_CLIENT_ID", "")
    XSUAA_CLIENT_SECRET: str = _vcap_xsuaa.get("client_secret") or os.getenv("XSUAA_CLIENT_SECRET", "")
    XSUAA_XSAPPNAME: str = _vcap_xsuaa.get("xsappname") or os.getenv("XSUAA_XSAPPNAME", "")
    XSUAA_VERIFICATION_KEY: str = _vcap_xsuaa.get("verification_key") or os.getenv("XSUAA_VERIFICATION_KEY", "")

    # SAP AI Core Configuration
    AICORE_AUTH_URL: str = _vcap_aicore.get("auth_url") or os.getenv("AICORE_AUTH_URL", "")
    AICORE_CLIENT_ID: str = _vcap_aicore.get("client_id") or os.getenv("AICORE_CLIENT_ID", "")
    AICORE_CLIENT_SECRET: str = _vcap_aicore.get("client_secret") or os.getenv("AICORE_CLIENT_SECRET", "")
    AICORE_RESOURCE_GROUP: str = os.getenv("AICORE_RESOURCE_GROUP", "default")
    AICORE_BASE_URL: str = _vcap_aicore.get("base_url") or os.getenv("AICORE_BASE_URL", "")
    AICORE_DEPLOYMENT_ID: str = os.getenv("AICORE_DEPLOYMENT_ID", "")
    AICORE_DEPLOYMENT_URL: str = os.getenv("AICORE_DEPLOYMENT_URL", "")

    # NVIDIA API Configuration
    NVIDIA_API_KEY: str = os.getenv("NVIDIA_API_KEY", "")
    NVIDIA_EMBEDDING_MODEL: str = os.getenv("NVIDIA_EMBEDDING_MODEL", "nvidia/nemotron-3-embed-1b")
    NVIDIA_API_URL: str = os.getenv("NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/embeddings")
    NVIDIA_LLM_MODEL: str = os.getenv("NVIDIA_LLM_MODEL", "nvidia/nemotron-3.5-bolt-e4b")
    NVIDIA_LLM_URL: str = os.getenv("NVIDIA_LLM_URL", "https://integrate.api.nvidia.com/v1/chat/completions")


    # Explicit HANA settings can target existing tables in a legacy runtime-user schema.
    # Otherwise use the live HDI binding; Cloud Foundry never loads packaged .env files.
    HANA_ADDRESS: str = os.getenv("HANA_ADDRESS") or _vcap_hana.get("host", "")
    HANA_PORT: int = int(os.getenv("HANA_PORT") or _vcap_hana.get("port") or 443)
    HANA_USER: str = os.getenv("HANA_USER") or _vcap_hana.get("user", "")
    HANA_PASSWORD: str = os.getenv("HANA_PASSWORD") or _vcap_hana.get("password", "")
    HANA_SCHEMA: str = os.getenv("HANA_SCHEMA") or _vcap_hana.get("schema", "")
    HANA_VALIDATE_CERT: bool = os.getenv("HANA_VALIDATE_CERT", "true").lower() == "true"
    HANA_POOL_SIZE: int = int(os.getenv("HANA_POOL_SIZE", "20"))
    HANA_POOL_TIMEOUT: float = float(os.getenv("HANA_POOL_TIMEOUT", "30.0"))

    @field_validator("HANA_POOL_SIZE")
    @classmethod
    def validate_hana_pool_size(cls, v: int) -> int:
        if v <= 0:
            raise ValueError(f"HANA_POOL_SIZE must be greater than 0, got {v}")
        return v

    # Application Settings
    APP_ENV: str = os.getenv("APP_ENV", "development")
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    PORT: int = int(os.getenv("PORT", "8000"))
    ALLOWED_ORIGINS: str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000")
    MAX_UPLOAD_SIZE_MB: int = int(os.getenv("MAX_UPLOAD_SIZE_MB", "50"))

    # Data Freshness Settings
    DATA_REFRESH_INTERVAL_MINUTES: int = int(os.getenv("DATA_REFRESH_INTERVAL_MINUTES", "15"))
    DATA_STALE_MAX_HOURS: float = float(os.getenv("DATA_STALE_MAX_HOURS", "24"))

    class Config:
        case_sensitive = True

settings = Settings()
