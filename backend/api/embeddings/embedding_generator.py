from typing import List
from api.services.ai_core_service import ai_core_service

class EmbeddingGenerator:
    def generate(self, text: str) -> List[float]:
        return ai_core_service.generate_embedding(text)

embedding_generator = EmbeddingGenerator()
