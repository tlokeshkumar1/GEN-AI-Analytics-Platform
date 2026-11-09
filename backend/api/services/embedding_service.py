from typing import List
from api.services.ai_core_service import ai_core_service

class EmbeddingService:
    def get_embedding(self, text: str) -> List[float]:
        return ai_core_service.generate_embedding(text)

    def batch_embeddings(self, texts: List[str]) -> List[List[float]]:
        from concurrent.futures import ThreadPoolExecutor
        from contextvars import copy_context
        from api.utils.logger import get_logger
        logger = get_logger("services.embedding_service")

        batch_size = 64
        batches = [texts[i:i + batch_size] for i in range(0, len(texts), batch_size)]
        total_batches = len(batches)
        if total_batches > 5:
            logger.info(f"Generating embeddings for {len(texts)} chunks across {total_batches} batches...")

        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(copy_context().run, ai_core_service.generate_embeddings, batch) for batch in batches]
            results = []
            for idx, future in enumerate(futures, 1):
                results.extend(future.result())
                if total_batches > 5 and (idx % 20 == 0 or idx == total_batches):
                    logger.info(f"Embedding progress: {idx}/{total_batches} batches ({len(results)}/{len(texts)} vectors)")
            return results

embedding_service = EmbeddingService()
