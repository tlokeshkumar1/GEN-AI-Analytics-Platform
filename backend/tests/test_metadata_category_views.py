import importlib.util
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('metadata_views', ROOT / 'scripts/create_metadata_category_views.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)

class MetadataCategoryViewTests(unittest.TestCase):
    def test_namespaces_are_disjoint_and_unknown_categories_remain_in_source(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.create_function('LOCATE', 2, lambda text, substring: text.find(substring) + 1)
        db.execute('CREATE TABLE PLATFORM_DOCUMENTS (NAMESPACE TEXT, DOCUMENT_ID TEXT, REVISION INTEGER, PAYLOAD TEXT)')
        namespaces = ['default:analytics:1:ds-one:v1', 'default:dashboard:1:ds-one:v1',
            'default:semantic:ds-one:v1', 'default:workflow:ds-one:v1', 'default:datasets',
            'platform:objects', 'default:workers', 'project_user_logins',
            'default:credentials', 'analytics:settings']
        for index, namespace in enumerate(namespaces):
            db.execute('INSERT INTO PLATFORM_DOCUMENTS VALUES (?, ?, ?, ?)', (namespace, str(index), 1, '{}'))
        before = db.execute('SELECT * FROM PLATFORM_DOCUMENTS ORDER BY DOCUMENT_ID').fetchall()
        memberships = []
        for name, ddl in migration.definitions():
            db.execute(ddl.replace('WITH READ ONLY', ''))
            rows = db.execute(f'SELECT * FROM "{name}"').fetchall()
            self.assertEqual(len(rows), 1, name)
            memberships.extend(row[0] for row in rows)
            artifact = ROOT / 'backend/db/src/views' / (name.lower() + '.hdbview')
            self.assertEqual(artifact.read_text().strip(), ddl.removeprefix('CREATE '))
            self.assertTrue(ddl.endswith('WITH READ ONLY'))
        self.assertEqual(len(memberships), len(set(memberships)))
        self.assertEqual(db.execute('SELECT * FROM PLATFORM_DOCUMENTS ORDER BY DOCUMENT_ID').fetchall(), before)

    def test_live_worker_updates_do_not_hide_data_loss_or_other_changes(self):
        rows = [('default:workers', 'worker', 1, 'old'), ('default:datasets', 'catalog', 1, 'original')]
        updated = [('default:workers', 'worker', 2, 'new'), rows[1]]
        self.assertEqual(migration.verify_source(rows, updated), [('default:workers', 'worker')])
        with self.assertRaises(RuntimeError):
            migration.verify_source(rows, updated[:1])
        with self.assertRaises(RuntimeError):
            migration.verify_source(rows, [rows[0], ('default:datasets', 'catalog', 2, 'changed')])
