import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextvars import copy_context
from typing import List

from api.services.ai_core_service import ai_core_service, EmbeddingProviderError
from api.utils.logger import get_logger

logger = get_logger("services.embedding_service")


class EmbeddingBatchError(EmbeddingProviderError):
    """Keep completed inputs available to the dataset's retry checkpoint."""

    def __init__(self, error, completed):
        super().__init__(str(error), status_code=getattr(error, "status_code", None), request_id=getattr(error, "request_id", None))
        self.completed = completed


def _setting(name, default, maximum):
    try:
        return max(1, min(maximum, int(os.getenv(name, default))))
    except ValueError:
        return default


class EmbeddingService:
    def get_embedding(self, text: str) -> List[float]:
        return ai_core_service.generate_embedding(text)

    def _batch(self, texts):
        completed = {}
        try:
            try:
                vectors = ai_core_service.generate_embeddings(texts)
            except EmbeddingProviderError as error:
                # One subdivision only: at most three initial attempts plus two
                # smaller requests. Auth/model/rate-limit errors do not split.
                if error.status_code not in (413, 500, 502, 503, 504) or len(texts) < 2:
                    raise
                middle = len(texts) // 2
                logger.warning("Retrying failed batch of %s inputs as batches of %s and %s", len(texts), middle, len(texts) - middle)
                for part in (texts[:middle], texts[middle:]):
                    vectors = ai_core_service.generate_embeddings(part, max_retries=0)
                    if len(vectors) != len(part):
                        raise EmbeddingProviderError("Embedding provider returned an incomplete batch")
                    completed.update(zip(part, vectors))
                return completed
            if len(vectors) != len(texts):
                raise EmbeddingProviderError("Embedding provider returned an incomplete batch")
            return dict(zip(texts, vectors))
        except Exception as error:
            raise EmbeddingBatchError(error, completed) from error

    def batch_embeddings(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        batch_size = _setting("EMBEDDING_BATCH_SIZE", 32, 64)
        workers = _setting("EMBEDDING_MAX_WORKERS", 2, 4)
        batches = [texts[i:i + batch_size] for i in range(0, len(texts), batch_size)]
        logger.info("Generating embeddings | inputs=%s | batches=%s | batch_size=%s | concurrency=%s", len(texts), len(batches), batch_size, workers)
        completed = {}
        failure = None
        position = 0
        finished = 0
        # Stop submitting after a failure, but retain successful in-flight work.
        with ThreadPoolExecutor(max_workers=workers) as pool:
            pending = set()
            while position < min(workers, len(batches)):
                pending.add(pool.submit(copy_context().run, self._batch, batches[position]))
                position += 1
            while pending:
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    finished += 1
                    try:
                        completed.update(future.result())
                    except EmbeddingBatchError as error:
                        completed.update(error.completed)
                        failure = failure or error
                    logger.info("Embedding progress | batches_finished=%s/%s | completed_inputs=%s/%s", finished, len(batches), len(completed), len(texts))
                if failure is None:
                    while position < len(batches) and len(pending) < workers:
                        pending.add(pool.submit(copy_context().run, self._batch, batches[position]))
                        position += 1
        if failure:
            raise EmbeddingBatchError(failure, completed) from failure
        return [completed[text] for text in texts]


embedding_service = EmbeddingService()
