from typing import List
from api.embeddings.embedding_generator import embedding_generator
from api.embeddings.vector_store import vector_store

class EmbeddingLoader:
    def load_texts(self, texts: List[str], id_prefix: str = "doc"):
        for i, text in enumerate(texts):
            vec = embedding_generator.generate(text)
            vector_store.save(f"{id_prefix}_{i}", text, vec)

embedding_loader = EmbeddingLoader()
