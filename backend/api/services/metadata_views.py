"""Read-only browsing for the eight metadata category views."""
import json
from fastapi import HTTPException
from api.database.connection import db_manager
from api.database.hana_table_service import serialize_hana_value

CATEGORIES = {
    'PM_ANALYTICS_V': ('KPIs & Charts', 'Widget definitions, calculations and approval status'),
    'PM_DASHBOARDS_V': ('Dashboards', 'Published dashboards and their widget references'),
    'PM_SEMANTIC_MODELS_V': ('Semantic Models', 'Fields, business meanings and relationships'),
    'PM_WORKFLOWS_V': ('Agent Workflows', 'Ingestion stages, processing state and results'),
    'PM_DATASET_CATALOG_V': ('Dataset Catalog', 'Registered datasets, versions and file references'),
    'PM_ARTIFACT_OBJECTS_V': ('Files & Embeddings', 'Uploaded files, dataset snapshots and embedding objects'),
    'PM_WORKERS_V': ('Workers', 'Worker heartbeat records'),
    'PM_USER_LOGINS_V': ('User Sessions', 'Login, logout and activity tracking'),
}

def publication_keys(cursor):
    cursor.execute("SELECT NAMESPACE, PAYLOAD FROM PM_DASHBOARDS_V WHERE DOCUMENT_ID = 'published'")
    keys = set()
    for namespace, payload in cursor.fetchall():
        value = json.loads(serialize_hana_value(payload))
        analytics_namespace = namespace.replace(':dashboard:', ':analytics:', 1)
        for ref in value.get('items', []):
            keys.add((analytics_namespace, f"{ref['id']}:{ref['revision']}"))
    return keys


def browse_views(view_name=None, page=1, page_size=25, publication='all'):
    if publication not in ('all', 'published', 'unpublished'):
        raise HTTPException(422, 'Invalid publication filter.')
    if view_name is not None and view_name not in CATEGORIES:
        raise HTTPException(404, 'Unknown metadata view.')
    connection = db_manager.get_connection()
    if connection is None:
        raise HTTPException(503, 'HANA connection unavailable.')
    cursor = connection.cursor()
    try:
        cursor.execute('SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = CURRENT_SCHEMA')
        existing = {row[0] for row in cursor.fetchall()} & CATEGORIES.keys()
        if view_name:
            if view_name not in existing:
                raise HTTPException(404, 'This metadata view has not been deployed.')
            published_keys = set()
            publication_counts = None
            where = ''
            params = ()
            cursor.execute(f'SELECT COUNT(*) FROM "{view_name}"')
            all_count = int(cursor.fetchone()[0])
            total = all_count
            if view_name == 'PM_ANALYTICS_V':
                if 'PM_DASHBOARDS_V' not in existing:
                    raise HTTPException(503, 'Dashboard view is required to determine publication status.')
                published_keys = publication_keys(cursor)
                ordered_keys = sorted(published_keys)
                predicate = ' OR '.join('(NAMESPACE = ? AND DOCUMENT_ID = ?)' for _ in ordered_keys) or '1 = 0'
                key_params = tuple(value for key in ordered_keys for value in key)
                cursor.execute(f'SELECT COUNT(*) FROM "{view_name}" WHERE ({predicate})', key_params)
                published_count = int(cursor.fetchone()[0])
                publication_counts = {'all': all_count, 'published': published_count, 'unpublished': all_count - published_count}
                if publication != 'all':
                    where = f" WHERE {'NOT ' if publication == 'unpublished' else ''}({predicate})"
                    params = key_params
                    total = publication_counts[publication]
            cursor.execute(f'SELECT NAMESPACE, DOCUMENT_ID, REVISION, PAYLOAD FROM "{view_name}"{where} ORDER BY NAMESPACE, DOCUMENT_ID LIMIT ? OFFSET ?',
                           params + (page_size, (page - 1) * page_size))
            rows = []
            for namespace, key, revision, payload in cursor.fetchall():
                payload = serialize_hana_value(payload)
                text = str(payload)
                rows.append({'namespace': namespace, 'documentId': key, 'revision': revision,
                             'payload': text[:16000], 'truncated': len(text) > 16000,
                             **({'published': (namespace, key) in published_keys} if view_name == 'PM_ANALYTICS_V' else {})})
            return {'viewName': view_name, 'totalRows': total, 'page': page, 'pageSize': page_size, 'rows': rows, 'publicationCounts': publication_counts}
        counts = {}
        if existing:
            cursor.execute(' UNION ALL '.join(f"SELECT '{name}' AS VIEW_NAME, COUNT(*) AS CNT FROM \"{name}\"" for name in sorted(existing)))
            counts = {row[0]: int(row[1]) for row in cursor.fetchall()}
        return {'views': [{'name': name, 'label': label, 'description': description,
                           'rowCount': counts.get(name, 0), 'available': name in existing, 'readOnly': True}
                          for name, (label, description) in CATEGORIES.items()]}
    finally:
        cursor.close()
        db_manager.return_connection(connection)
