"""My Files documents in the configured application HANA schema."""

from functools import lru_cache

from api.database.connection import db_manager
from api.platform.store import MetadataStore


class PersonalStore(MetadataStore):
    def __init__(self, pool):
        super().__init__(backend="hana")
        self.pool = pool

    def connection_pool(self):
        return self.pool


@lru_cache(maxsize=1)
def personal_store():
    # Share application storage; ContentWorkspace retains per-user namespaces
    # and checks ownership and sharing permissions before accessing documents.
    return PersonalStore(db_manager)
