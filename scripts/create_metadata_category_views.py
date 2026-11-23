"""Inspect/create eight read-only metadata views. Dry-run by default; no API startup DDL."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
MIGRATION = ROOT / 'backend/db/migrations/003_metadata_category_views.sql'

def definitions():
    source = '\n'.join(line for line in MIGRATION.read_text(encoding='utf-8').splitlines() if not line.startswith('--'))
    statements = [part.strip() for part in source.split(';') if part.strip()]
    assert len(statements) == 8
    return [(statement.split('"')[1], statement) for statement in statements]

def fingerprint(cursor):
    cursor.execute('SELECT NAMESPACE, DOCUMENT_ID, REVISION, PAYLOAD FROM PLATFORM_DOCUMENTS ORDER BY NAMESPACE, DOCUMENT_ID')
    records = []
    for ns, key, revision, payload in cursor.fetchall():
        if hasattr(payload, 'read'): payload = payload.read()
        records.append((ns, key, revision, hashlib.sha256(payload.encode('utf-8')).hexdigest()))
    return records

def verify_source(before, after):
    before_map = {(row[0], row[1]): row[2:] for row in before}
    after_map = {(row[0], row[1]): row[2:] for row in after}
    if before_map.keys() != after_map.keys():
        raise RuntimeError('Source record identities changed; retry during a quiet period')
    changed = [key for key in before_map if before_map[key] != after_map[key]]
    if any(key[0].partition(':')[2] != 'workers' for key in changed):
        raise RuntimeError('Non-heartbeat source records changed; retry during a quiet period')
    return changed

def run(apply=False):
    from api.database.connection import db_manager
    connection = db_manager.get_connection()
    if connection is None: raise RuntimeError('HANA connection unavailable')
    cursor = connection.cursor()
    try:
        cursor.execute('SELECT CURRENT_SCHEMA FROM DUMMY')
        schema = cursor.fetchone()[0]
        before = fingerprint(cursor)
        definitions_list = definitions()
        # Refuse all name collisions before creating any view.
        for name, statement in definitions_list:
            cursor.execute('SELECT OBJECT_TYPE FROM SYS.OBJECTS WHERE SCHEMA_NAME = ? AND OBJECT_NAME = ?', (schema, name))
            if cursor.fetchall():
                raise RuntimeError(f'{name} already exists. Inspect it before applying this migration again.')
        names = [name for name, _ in definitions_list]
        predicates = [statement.split('WHERE ', 1)[1].rsplit('WITH READ ONLY', 1)[0].strip() for _, statement in definitions_list]
        cursor.execute('SELECT NAMESPACE, DOCUMENT_ID FROM PLATFORM_DOCUMENTS WHERE NOT (' + ' OR '.join('(' + p + ')' for p in predicates) + ')')
        unclassified = len(cursor.fetchall())
        if not apply:
            print(json.dumps({'mode': 'dry-run', 'source_records': len(before), 'views_to_create': names, 'unclassified_records_preserved': unclassified}, indent=2))
            return
        # HANA DDL is not assumed to be atomic across all eight statements.
        created = []
        try:
            for name, statement in definitions_list:
                cursor.execute(statement)
                created.append(name)
            memberships = []
            counts = {}
            for name, _ in definitions_list:
                cursor.execute(f'SELECT NAMESPACE, DOCUMENT_ID FROM "{name}"')
                keys = [tuple(row) for row in cursor.fetchall()]
                counts[name] = len(keys)
                memberships.extend(keys)
            if len(memberships) != len(set(memberships)):
                raise RuntimeError('Category views overlap')
            if len(memberships) + unclassified != len(before):
                raise RuntimeError('Coverage changed during verification; retry during a quiet period')
            after = fingerprint(cursor)
            changed = verify_source(before, after)
            connection.commit()
            print(json.dumps({'mode': 'applied', 'views': counts, 'source_record_identities_verified': len(before), 'source_records_written_by_migration': 0, 'concurrent_worker_updates': len(changed), 'unclassified_records_preserved': unclassified}, indent=2))
        except Exception:
            for name in reversed(created):
                cursor.execute(f'DROP VIEW "{name}"')
            connection.commit()
            raise
    finally:
        cursor.close()
        db_manager.return_connection(connection)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    run(parser.parse_args().apply)
