from pydantic import BaseModel, ConfigDict
from typing import Optional


class DynamicRecord(BaseModel):
    """Dynamic, generic record container that accepts any columns without hardcoding."""
    model_config = ConfigDict(extra="allow")


class VectorRecord(BaseModel):
    id: str
    text_chunk: str
    embedding: list[float]
    metadata_json: Optional[str] = None
