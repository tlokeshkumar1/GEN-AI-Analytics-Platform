from typing import List, Dict, Any
from api.services.vector_service import vector_service

class ContextRetriever:
    def retrieve(self, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        # Cap retrieval window to top 5 chunks (under 2,000 tokens) instead of hardcoding 25 chunks (28,870 tokens)
        k = min(max(top_k, 3), 6)
        results = vector_service.search_similar_chunks(query, k)
        
        # Sort chunks primarily by relevance score descending so the most grounded evidence is first
        def chunk_priority(chunk):
            score = chunk.get("SCORE")
            try:
                return -float(score)
            except Exception:
                return 0.0

        sorted_results = sorted(results, key=chunk_priority)
        return sorted_results

retriever = ContextRetriever()
