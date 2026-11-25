"""Read-only preflight for an explicitly authorized HANA Cloud test environment."""

import json
import sys
from pathlib import Path


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    from api.platform.content_store import personal_store
    from api.platform.store import metadata_store

    legacy = metadata_store()
    if legacy.backend != "hana":
        raise SystemExit("A HANA Cloud platform binding is required.")
    content = personal_store()
    with content.transaction() as cursor:
        cursor.execute(
            "SELECT TOP 0 NAMESPACE, DOCUMENT_ID, REVISION, PAYLOAD FROM PLATFORM_DOCUMENTS"
        )
    with legacy.transaction() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM PLATFORM_DOCUMENTS WHERE NAMESPACE LIKE ?",
            ("%:dashboard:%",),
        )
        legacy_count = int(cursor.fetchone()[0])
    print(
        json.dumps(
            {
                "legacy_dashboard_documents": legacy_count,
                "personal_files_to_create": 0,
                "ownership_assignments": 0,
                "content_table_readable": True,
                "uses_application_pool": content.connection_pool() is legacy.connection_pool(),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
