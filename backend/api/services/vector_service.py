from typing import List, Dict, Any, Optional
from collections import OrderedDict
import threading
import time
from api.services.ai_core_service import ai_core_service
from api.utils.logger import get_logger

logger = get_logger("services.vector_service")


class BoundedTTLCache:
    """Thread-safe bounded LRU cache with TTL expiration to prevent memory leaks."""

    def __init__(self, maxsize: int = 512, ttl_seconds: float = 300.0):
        self.maxsize = maxsize
        self.ttl = ttl_seconds
        self._cache: OrderedDict[str, tuple[Any, float]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if key not in self._cache:
                return None
            val, expiry = self._cache[key]
            if time.time() > expiry:
                del self._cache[key]
                return None
            self._cache.move_to_end(key)
            return val

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = (value, time.time() + self.ttl)
            if len(self._cache) > self.maxsize:
                self._cache.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


# Bounded LRU/TTL cache instance
_query_cache = BoundedTTLCache(maxsize=512, ttl_seconds=300.0)


class VectorService:
    def clear_cache(self):
        _query_cache.clear()

    def search_similar_chunks(self, text_query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        from api.services.dataset_service import dataset_service
        from api.models.execution_context import current_selection, current_identity

        if current_selection.get() is not None or dataset_service.repository is not None or dataset_service.catalog_path.exists():
            return dataset_service.search(text_query, top_k)

        # Check bounded cache with workspace isolation
        identity = current_identity.get()
        workspace_id = identity.get("workspace_id", "default") if identity else "default"
        cache_key = f"{workspace_id}:{text_query}:{top_k}"

        cached = _query_cache.get(cache_key)
        if cached is not None:
            logger.debug(f"Vector search cache hit for: {text_query[:50]}")
            return cached

        try:
            from api.database.vector_client import vector_client
            embedding = ai_core_service.generate_embedding(text_query)
            results = vector_client.similarity_search(embedding, top_k)
        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            results = []

        if not results:
            results = []

        # Store in bounded cache
        _query_cache.set(cache_key, results)
        return results

    def add_document_vector(self, doc_id: str, text: str, metadata: Any = None):
        from api.database.vector_client import vector_client
        embedding = ai_core_service.generate_embedding(text)
        vector_client.store_vector(doc_id, text, embedding, metadata)


vector_service = VectorService()
