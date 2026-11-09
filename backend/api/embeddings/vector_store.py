from typing import List, Dict, Any
from api.database.vector_client import vector_client

class VectorStore:
    def save(self, doc_id: str, text: str, embedding: List[float], metadata: Any = None):
        vector_client.store_vector(doc_id, text, embedding, metadata)

    def search(self, embedding: List[float], top_k: int = 5) -> List[Dict[str, Any]]:
        return vector_client.similarity_search(embedding, top_k)

vector_store = VectorStore()
