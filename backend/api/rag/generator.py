import json
import time
import threading
import requests
from typing import Generator, Optional, List
from api.config import settings
from api.utils.logger import get_logger

logger = get_logger("rag.generator")


class RAGGenerator:
    """
    NVIDIA NIM LLM provider for RAG Chat.
    Supports both synchronous (generate) and streaming (generate_stream) generation.

    - generate()        → used by /api/chat (REST fallback) and analytical pipeline
    - generate_stream() → used by /api/chat/stream (SSE token streaming)
    """

    def __init__(self):
        self.api_url = settings.NVIDIA_LLM_URL
        self.api_key = settings.NVIDIA_API_KEY
        self.model = settings.NVIDIA_LLM_MODEL or "nvidia/nemotron-3.5-bolt-e4b"

        # Candidate fallback models (same priority as ai_core_service)
        self._fallback_models = [
            self.model,
            "nvidia/nemotron-3.5-bolt-e4b",
            "minimaxai/minimax-m3.1-flash",
        ]
        # Deduplicate while preserving order
        seen = set()
        self._candidate_models: List[str] = []
        for m in self._fallback_models:
            if m and m not in seen:
                self._candidate_models.append(m)
                seen.add(m)

    def _get_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    # ── Synchronous Generation ────────────────────────────────────────────────

    def generate(self, formatted_prompt: str,
                 system_prompt: str = "You explain approved enterprise dataset definitions and evidence.") -> str:
        """
        Synchronous completion via NVIDIA NIM.
        Used by: /api/chat, _handle_analytical, _generate_analytical_response, etc.
        Tries candidate models in priority order for resilience.
        """
        if not self.api_key:
            logger.error("[RAGGenerator] NVIDIA_API_KEY not configured")
            raise RuntimeError("NVIDIA API key is not configured in environment settings.")

        from api.platform.ai_settings import ai_settings
        config = ai_settings()
        headers = self._get_headers()

        models_to_try = []
        for m in [config["llm_model"], *self._candidate_models]:
            if m and m not in models_to_try:
                models_to_try.append(m)

        for idx, model_name in enumerate(models_to_try):
            payload = {
                "model": model_name,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": formatted_prompt},
                ],
                "temperature": config["temperature"],
                "max_tokens": config["max_tokens"],
                "stream": False,
            }
            t_start = time.perf_counter()
            try:
                res = requests.post(self.api_url, headers=headers, json=payload, timeout=60)
                elapsed_ms = round((time.perf_counter() - t_start) * 1000, 1)
                if res.status_code == 200:
                    data = res.json()
                    content = data["choices"][0]["message"]["content"]
                    if content and content.strip():
                        try:
                            from calculate_token_usage import record_token_usage
                            record_token_usage(
                                "RAG Generator",
                                model_name,
                                data.get("usage", {}).get("prompt_tokens", 0),
                                data.get("usage", {}).get("completion_tokens", 0),
                                latency_ms=elapsed_ms
                            )
                        except ImportError:
                            try:
                                import sys
                                from pathlib import Path
                                root_p = str(Path(__file__).resolve().parents[3])
                                if root_p not in sys.path:
                                    sys.path.insert(0, root_p)
                                from calculate_token_usage import record_token_usage
                                record_token_usage(
                                    "RAG Generator",
                                    model_name,
                                    data.get("usage", {}).get("prompt_tokens", 0),
                                    data.get("usage", {}).get("completion_tokens", 0),
                                    latency_ms=elapsed_ms
                                )
                            except Exception:
                                pass
                        except Exception:
                            pass
                        if idx == 0:
                            logger.info(f"[RAGGenerator] Model {model_name} completed successfully.")
                        else:
                            logger.info(f"[RAGGenerator] Fallback model {model_name} completed successfully.")
                        return content
                else:
                    logger.warning(f"[RAGGenerator] Model {model_name} returned status {res.status_code}: {res.text[:150]}")
            except requests.exceptions.Timeout:
                logger.warning(f"[RAGGenerator] Model {model_name} timed out, trying next fallback...")
            except Exception as e:
                logger.warning(f"[RAGGenerator] Model {model_name} failed ({e}), trying next fallback...")

        logger.error("[RAGGenerator] All NVIDIA NIM models failed or timed out.")
        raise RuntimeError("All NVIDIA NIM models failed or timed out.")

    # ── Streaming Generation ──────────────────────────────────────────────────

    def generate_stream(self, formatted_prompt: str,
                        system_prompt: str = "You explain approved enterprise dataset definitions and evidence.",
                        stop_event: Optional[threading.Event] = None
                        ) -> Generator[str, None, None]:
        """
        Token-by-token streaming generator via NVIDIA NIM (stream=True).
        Yields text chunks as they arrive from the model.
        Used by: /api/chat/stream → SSE → React progressive rendering.

        Falls back to synchronous generation if streaming is not supported
        by the specific NIM endpoint.
        """
        if not self.api_key:
            logger.error("[RAGGenerator] NVIDIA_API_KEY not configured")
            raise RuntimeError("NVIDIA API key is not configured in environment settings.")

        from api.platform.ai_settings import ai_settings
        config = ai_settings()
        payload = {
            "model": config["llm_model"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": formatted_prompt},
            ],
            "temperature": config["temperature"],
            "max_tokens": config["max_tokens"],
            "stream": True,
        }

        headers = self._get_headers()
        headers["Accept"] = "text/event-stream"

        if stop_event and stop_event.is_set():
            logger.info("[RAGGenerator] Stream aborted before request was initiated.")
            return

        streamed_any = False
        t_start = time.perf_counter()
        monitor_stop = threading.Event()
        resp = None

        try:
            if stop_event and stop_event.is_set():
                return

            resp = requests.post(
                self.api_url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=90,
            )

            # Monitor stop_event and close the response socket immediately on disconnect
            # so iter_lines() is interrupted instead of hanging on socket inactivity.
            if stop_event:
                def _close_on_stop():
                    while not monitor_stop.is_set():
                        if stop_event.wait(timeout=0.1):
                            try:
                                if resp:
                                    resp.close()
                            except Exception:
                                pass
                            break

                watcher = threading.Thread(target=_close_on_stop, daemon=True)
                watcher.start()

            if resp.status_code != 200:
                if stop_event and stop_event.is_set():
                    logger.info("[RAGGenerator] Stream stopped; aborting fallback generation.")
                    return
                logger.warning(
                    f"[RAGGenerator] Streaming request returned {resp.status_code}, "
                    f"falling back to synchronous generation."
                )
                # Fallback: yield the complete response as a single chunk
                full = self.generate(formatted_prompt, system_prompt)
                yield full
                return

            streamed_parts = []
            for line in resp.iter_lines():
                if stop_event and stop_event.is_set():
                    logger.info("[Generator] Aborting stream and thread exits immediately; no dangling HTTP requests to NIM.")
                    return

                if not line:
                    continue
                line_str = line.decode("utf-8").strip()

                if not line_str.startswith("data: "):
                    continue

                data_str = line_str[6:]
                if data_str == "[DONE]":
                    elapsed_ms = round((time.perf_counter() - t_start) * 1000, 1)
                    try:
                        from calculate_token_usage import record_token_usage, estimate_tokens
                        record_token_usage(
                            "RAG Stream",
                            self.model,
                            estimate_tokens(formatted_prompt),
                            estimate_tokens("".join(streamed_parts)),
                            latency_ms=elapsed_ms
                        )
                    except ImportError:
                        try:
                            import sys
                            from pathlib import Path
                            root_p = str(Path(__file__).resolve().parents[3])
                            if root_p not in sys.path:
                                sys.path.insert(0, root_p)
                            from calculate_token_usage import record_token_usage, estimate_tokens
                            record_token_usage(
                                "RAG Stream",
                                self.model,
                                estimate_tokens(formatted_prompt),
                                estimate_tokens("".join(streamed_parts)),
                                latency_ms=elapsed_ms
                            )
                        except Exception:
                            pass
                    except Exception:
                        pass
                    break

                try:
                    chunk = json.loads(data_str)
                    choices = chunk.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            streamed_any = True
                            streamed_parts.append(content)
                            yield content
                except (json.JSONDecodeError, KeyError, IndexError) as e:
                    logger.debug(f"[RAGGenerator] Skipping malformed stream chunk: {e}")

        except requests.exceptions.Timeout:
            if stop_event and stop_event.is_set():
                logger.info("[RAGGenerator] Streaming request stopped via stop_event.")
                return
            logger.warning("[RAGGenerator] Streaming request timed out.")
            if not streamed_any:
                if stop_event and stop_event.is_set():
                    logger.info("[RAGGenerator] Stream stopped; aborting fallback request.")
                    return
                logger.info("[RAGGenerator] Falling back to synchronous generation after stream timeout.")
                full = self.generate(formatted_prompt, system_prompt)
                yield full
        except Exception as e:
            if stop_event and stop_event.is_set():
                logger.info(f"[RAGGenerator] Streaming generation aborted via stop_event ({type(e).__name__}).")
                return
            logger.error(f"[RAGGenerator] Streaming generation error: {e}")
            if not streamed_any:
                if stop_event and stop_event.is_set():
                    logger.info("[RAGGenerator] Stream stopped; aborting fallback request.")
                    return
                logger.info("[RAGGenerator] Falling back to synchronous generation after stream error.")
                try:
                    full = self.generate(formatted_prompt, system_prompt)
                    yield full
                except Exception as fallback_err:
                    logger.error(f"[RAGGenerator] Synchronous fallback also failed: {fallback_err}")
                    raise
        finally:
            monitor_stop.set()
            if resp:
                try:
                    resp.close()
                except Exception:
                    pass


generator = RAGGenerator()
