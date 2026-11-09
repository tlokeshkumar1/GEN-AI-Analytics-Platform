from typing import List, Dict, Any
import threading
from api.services.ai_core_service import ai_core_service
from api.utils.logger import get_logger

logger = get_logger("services.vector_service")

# Query result cache
_query_cache = {}
_cache_lock = threading.Lock()

class VectorService:
    def clear_cache(self):
        with _cache_lock:
            _query_cache.clear()

    def search_similar_chunks(self, text_query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        from api.services.dataset_service import dataset_service
        from api.models.execution_context import current_selection
        if current_selection.get() is not None or dataset_service.repository is not None or dataset_service.catalog_path.exists():
            return dataset_service.search(text_query, top_k)
        # Check cache first
        cache_key = f"{text_query}:{top_k}"
        with _cache_lock:
            if cache_key in _query_cache:
                logger.debug(f"Vector search cache hit for: {text_query[:50]}")
                return _query_cache[cache_key]
        
        try:
            from api.database.vector_client import vector_client
            embedding = ai_core_service.generate_embedding(text_query)
            results = vector_client.similarity_search(embedding, top_k)
        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            results = []

        if not results:
            results = []
        
        # Cache the results
        with _cache_lock:
            _query_cache[cache_key] = results
        
        return results

    def add_document_vector(self, doc_id: str, text: str, metadata: Any = None):
        from api.database.vector_client import vector_client
        embedding = ai_core_service.generate_embedding(text)
        vector_client.store_vector(doc_id, text, embedding, metadata)

vector_service = VectorService()
