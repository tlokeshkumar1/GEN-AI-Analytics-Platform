import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from typing import List, Dict, Any, Optional
import threading
import time
from api.config import settings
from api.utils.logger import get_logger

logger = get_logger("services.ai_core_service")


def _create_http_session() -> requests.Session:
    """Create a persistent HTTP session with connection pooling and retry backoff."""
    session = requests.Session()
    retry_strategy = Retry(
        total=2,
        backoff_factor=1.0,
        status_forcelist=[429, 502, 503, 504],
        allowed_methods=["POST", "GET"]
    )
    adapter = HTTPAdapter(
        pool_connections=10,
        pool_maxsize=20,
        max_retries=retry_strategy
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


class AICoreService:
    def __init__(self):
        self.auth_url = settings.AICORE_AUTH_URL
        self.client_id = settings.AICORE_CLIENT_ID
        self.client_secret = settings.AICORE_CLIENT_SECRET
        self.resource_group = settings.AICORE_RESOURCE_GROUP
        self.base_url = settings.AICORE_BASE_URL
        self.token = None
        self.last_used_model: Optional[str] = None
        self.session = _create_http_session()

    def get_token(self) -> Optional[str]:
        if not self.auth_url or not self.client_id:
            logger.error("AICore credentials not configured.")
            return None
        
        try:
            response = self.session.post(
                self.auth_url,
                data={"grant_type": "client_credentials"},
                auth=(self.client_id, self.client_secret),
                timeout=10
            )
            response.raise_for_status()
            self.token = response.json().get("access_token")
            return self.token
        except Exception as e:
            logger.error(f"Failed to fetch SAP AI Core OAuth token: {e}")
            return None

    def _request_with_retry(self, url: str, headers: dict, payload: dict, timeout: int, max_retries: int = 1) -> requests.Response:
        """Make HTTP request with exponential backoff retry using connection pool."""
        last_exception = None
        for attempt in range(max_retries + 1):
            try:
                res = self.session.post(url, json=payload, headers=headers, timeout=timeout)
                res.raise_for_status()
                return res
            except requests.exceptions.Timeout as e:
                last_exception = e
                if attempt < max_retries:
                    wait_time = (2 ** attempt) * 1  # 1s, 2s
                    logger.warning(f"Request timeout (attempt {attempt + 1}/{max_retries + 1}), retrying in {wait_time}s...")
                    time.sleep(wait_time)
                else:
                    logger.error(f"Request failed after {max_retries + 1} attempts: {e}")
                    raise
            except Exception as e:
                last_exception = e
                logger.error(f"Request failed: {e}")
                raise
        raise last_exception

    def generate_aicore_completion(self, prompt: str) -> Optional[str]:
        """
        Generate completion using SAP AI Core Generative AI Hub deployment.
        Dedicated for custom graph generation.
        """
        deploy_id = settings.AICORE_DEPLOYMENT_ID
        deploy_url = settings.AICORE_DEPLOYMENT_URL
        base_url = settings.AICORE_BASE_URL

        if not (deploy_id or deploy_url) or not self.auth_url or not self.client_id:
            logger.warning("[AI Core] Credentials or AICORE_DEPLOYMENT_ID not configured for Graph generation.")
            return None

        token = self.get_token()
        if not token:
            logger.error("[AI Core] Unable to obtain bearer token for SAP AI Core.")
            return None

        # Build deployment URL
        if deploy_url:
            url = deploy_url
        else:
            url = f"{base_url.rstrip('/')}/v2/inference/deployments/{deploy_id}/chat/completions"

        headers = {
            "Authorization": f"Bearer {token}",
            "AI-Resource-Group": self.resource_group or "default",
            "Content-Type": "application/json"
        }

        payload = {
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.2,
            "max_tokens": 1500
        }

        try:
            logger.info(f"[AI Core] Sending graph code generation request to SAP AI Core: {url}")
            t_start = time.perf_counter()
            res = self.session.post(url, json=payload, headers=headers, timeout=30)
            elapsed_ms = round((time.perf_counter() - t_start) * 1000, 1)
            if res.status_code == 200:
                data = res.json()
                choices = data.get("choices", [])
                if choices and "message" in choices[0]:
                    content = choices[0]["message"].get("content", "")
                    if content and content.strip():
                        self.last_used_model = f"sap-aicore-{deploy_id or 'default'}"
                        logger.info(f"[AI Core] Successfully received graph script from SAP AI Core (model: {deploy_id or 'default'})")
                        usage = data.get("usage", {})
                        p_tokens = usage.get("prompt_tokens", 0)
                        c_tokens = usage.get("completion_tokens", 0)
                        if p_tokens or c_tokens:
                            try:
                                from api.utils.calculate_token_usage import record_token_usage
                                record_token_usage(
                                    "AI Core Graph",
                                    f"gpt-4o-mini ({deploy_id or 'default'})",
                                    p_tokens,
                                    c_tokens,
                                    latency_ms=elapsed_ms
                                )
                            except Exception:
                                pass
                        return content
            else:
                logger.warning(f"[AI Core] SAP AI Core returned status {res.status_code}: {res.text[:200]}")
        except Exception as e:
            logger.warning(f"[AI Core] SAP AI Core request failed: {e}")

        return None

    def generate_nvidia_completion(self, prompt: str) -> str:
        """Generate text completion using NVIDIA NIM LLM API (dedicated for RAG Chat)."""
        api_key = settings.NVIDIA_API_KEY
        if not api_key:
            logger.error("NVIDIA API key not configured")
            raise RuntimeError("NVIDIA API key is not configured in environment settings.")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        from api.platform.ai_settings import ai_settings
        config = ai_settings()

        primary_model = config["llm_model"]
        fallback_models = [
            "meta/llama-3.2-11b-vision-instruct",
            "meta/llama-3.1-8b-instruct",
            "mistralai/mistral-7b-instruct-v0.3",
            "google/gemma-2-9b-it"
        ]

        models_to_try = [primary_model]
        for m in fallback_models:
            if m and m not in models_to_try:
                models_to_try.append(m)

        for idx, model_name in enumerate(models_to_try):
            payload = {
                "model": model_name,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": config["temperature"],
                "max_tokens": config["max_tokens"],
            }
            try:
                t_start = time.perf_counter()
                res = self.session.post(
                    settings.NVIDIA_LLM_URL,
                    json=payload,
                    headers=headers,
                    timeout=15
                )
                elapsed_ms = round((time.perf_counter() - t_start) * 1000, 1)
                if res.status_code == 200:
                    data = res.json()
                    result = data["choices"][0]["message"]["content"]
                    if result and result.strip():
                        try:
                            from api.utils.calculate_token_usage import record_token_usage
                            record_token_usage(
                                "Intent Engine",
                                model_name,
                                data.get("usage", {}).get("prompt_tokens", 0),
                                data.get("usage", {}).get("completion_tokens", 0),
                                latency_ms=elapsed_ms
                            )
                        except Exception:
                            pass
                        self.last_used_model = model_name
                        if idx == 0:
                            logger.info(f"[NVIDIA RAG] Model {model_name} completed successfully.")
                        else:
                            logger.info(f"[NVIDIA RAG] Fallback model {model_name} completed successfully.")
                        return result
                else:
                    logger.warning(f"[NVIDIA RAG] Model {model_name} returned {res.status_code}: {res.text[:100]}")
            except Exception as e:
                logger.warning(f"[NVIDIA RAG] Model {model_name} failed: {e}")

        raise RuntimeError(
            f"All {len(models_to_try)} NVIDIA NIM models failed to generate a response. "
            "Please check network access to integrate.api.nvidia.com or verify your API key."
        )

    def generate_completion(self, prompt: str) -> str:
        """Standard completion for RAG chat and general queries (uses NVIDIA NIM)."""
        return self.generate_nvidia_completion(prompt)

    def generate_embedding(self, text: str) -> List[float]:
        return self.generate_embeddings([text], input_type="query")[0]

    def generate_embeddings(self, texts: List[str], input_type="passage") -> List[List[float]]:
        api_key = settings.NVIDIA_API_KEY
        if not api_key:
            logger.error("NVIDIA API key not configured")
            raise RuntimeError("NVIDIA API key is not configured in environment settings.")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        from api.platform.ai_settings import ai_settings
        payload = {
            "model": ai_settings()["embedding_model"],
            "input": texts,
            "input_type": input_type
        }
        try:
            res = self._request_with_retry(
                settings.NVIDIA_API_URL,
                headers,
                payload,
                timeout=30,
                max_retries=2
            )
            items = sorted(res.json()["data"], key=lambda item: item.get("index", 0))
            if len(items) != len(texts):
                raise ValueError("Embedding provider returned an incomplete batch")
            if any(len(item["embedding"]) < 1536 for item in items):
                raise ValueError("Embedding provider returned fewer dimensions than the configured index")
            return [item["embedding"][:1536] for item in items]
        except Exception as e:
            logger.error(f"NVIDIA Embedding request failed: {e}")
            raise RuntimeError(f"NVIDIA Embedding request failed: {e}")


ai_core_service = AICoreService()
