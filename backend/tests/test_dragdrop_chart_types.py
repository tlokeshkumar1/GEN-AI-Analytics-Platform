"""Create and publication requests accept every chart offered by the builder."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.routes import semantic as routes
from api.platform.contracts import AnalyticsItem

class DragDropChartTypeTests(unittest.TestCase):
    def test_create_and_save_endpoints_accept_builder_chart_types(self):
        app = FastAPI()
        app.include_router(routes.router)
        client = TestClient(app)
        selection = SimpleNamespace(entry={'id': 'projects'}, context=SimpleNamespace(
            version=1, semantic_revision=1, model_dump=lambda: {}))
        execution = SimpleNamespace(success=True, to_dict=lambda: {
            'success': True, 'data': [{'Planned_Progress': 50, 'Project_ID': 2}]})
        with patch.object(routes, 'selected', return_value=selection), \
             patch.object(routes.analytics_engine, 'execute', return_value=execution), \
             patch.object(routes.semantic_registry, 'save_item', side_effect=lambda e, v, r, item: item):
            for kind in ('kpi', 'table', 'bar', 'line', 'scatter', 'pie', 'area', 'donut', 'horizontal_bar', 'gauge', 'funnel', 'radar'):
                with self.subTest(kind=kind):
                    plan = {'metric': 'Project_ID', 'aggregation': 'COUNT', 'dimension': 'Planned_Progress', 'chart_type': kind}
                    response = client.post('/api/insights/execute', json=plan)
                    self.assertEqual(response.status_code, 200, response.text)
                    item = {'id': 'widget', 'title': 'Projects by progress', 'kind': kind, 'revision': 1,
                            'semantic_revision': 1, 'query_plan': plan, 'explanation': 'User reviewed preview',
                            'dependencies': ['Project_ID', 'Planned_Progress']}
                    response = client.post('/api/insights/definitions', json=item)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(AnalyticsItem.model_validate(response.json()).query_plan.chart_type, kind)
            response = client.post('/api/insights/execute', json={**plan, 'chart_type': 'unsupported'})
            self.assertEqual(response.status_code, 422)

    def test_publish_donut_preserves_existing_widget_references(self):
        import tempfile
        from pathlib import Path
        import pandas as pd
        from api.models.execution_context import current_selection, ExecutionContext
        from api.platform.store import MetadataStore
        from api.platform.semantic import SemanticRegistry
        from api.platform.contracts import SemanticModel, SemanticField
        from api.routes import dashboard as dashboard_routes
        from api.services.analytics_engine import AnalyticsEngine
        entry = {'id': 'projects', 'workspaceId': 'test', 'currentVersion': 1}
        selection = SimpleNamespace(entry=entry, context=ExecutionContext(workspace_id='test', user_id='tester', dataset_id='projects', version=1, semantic_revision=1))
        model = SemanticModel(dataset_id='projects', data_version=1, revision=1, domain='Projects',
            grain='One project', status='approved', fields=[
                SemanticField(name='Project_ID', semantic_name='Project ID', role='identifier', type='identifier', aggregations=['COUNT']),
                SemanticField(name='Planned_Progress', semantic_name='Planned Progress', role='measure', type='decimal', aggregations=['AVG', 'COUNT'])])
        frame = pd.DataFrame({'Project_ID': ['A', 'B', 'C'], 'Planned_Progress': [50, 50, 100]})
        with tempfile.TemporaryDirectory() as folder:
            store = MetadataStore(Path(folder) / 'metadata.sqlite3', backend='sqlite')
            registry = SemanticRegistry(store)
            namespace = registry.namespace(entry, 1, 'dashboard:1')
            old_ref = {'id': 'existing_widget', 'revision': 1}
            store.put(namespace, 'published', {'title': 'Existing Dashboard', 'items': [old_ref]})
            token = current_selection.set(selection)
            try:
                def execute(plan):
                    return AnalyticsEngine().execute(plan, dataframe=frame, semantic_model=model)
                with patch.object(dashboard_routes, 'semantic_registry', registry), \
                     patch.object(registry, 'get', return_value=model), \
                     patch.object(dashboard_routes.analytics_engine, 'execute', side_effect=execute):
                    proposed_plan = {'metric': 'Project_ID', 'aggregation': 'COUNT', 'dimension': 'Planned_Progress', 'chart_type': 'donut'}
                    analytics_ns = registry.namespace(entry, 1, 'analytics:1')
                    store.put(analytics_ns, 'new_donut:1', {'id': 'new_donut', 'title': 'Projects by planned progress',
                        'kind': 'donut', 'revision': 1, 'status': 'proposed', 'query_plan': proposed_plan})
                    result = dashboard_routes.publish_recommended_charts(dashboard_routes.PublishRecommendedRequest(items=[{
                        'id': 'new_donut', 'title': 'Projects by planned progress', 'kind': 'donut',
                        'query_plan': {'metric': 'Project_ID', 'aggregation': 'COUNT', 'dimension': 'Planned_Progress', 'chart_type': 'donut'}}]))
            finally:
                current_selection.reset(token)
            self.assertEqual(result['published_count'], 1)
            self.assertEqual(store.get(namespace, 'published')['value']['items'], [old_ref, {'id': 'new_donut', 'revision': 1}])
            definition = store.get(registry.namespace(entry, 1, 'analytics:1'), 'new_donut:1')['value']
            self.assertEqual(definition['status'], 'approved')
            self.assertEqual(definition['query_plan']['dimension'], 'Planned_Progress')
            self.assertEqual(definition['query_plan']['metric'], 'Project_ID')

    def test_saved_widget_publication_appends_existing_references(self):
        import tempfile
        from pathlib import Path
        from api.platform.store import MetadataStore
        entry = {'id': 'projects', 'currentVersion': 1, 'versions': [{'version': 1}]}
        old = SimpleNamespace(id='old', revision=1, status='approved')
        new = SimpleNamespace(id='new', revision=1, status='approved')
        with tempfile.TemporaryDirectory() as folder:
            store = MetadataStore(Path(folder) / 'metadata.sqlite3', backend='sqlite')
            store.put('dashboard', 'published', {'title': 'Existing', 'items': [{'id': 'old', 'revision': 1}]})
            registry = SimpleNamespace(store=store, items=lambda *a: [old, new], namespace=lambda *a: 'dashboard')
            with patch.object(routes, 'semantic_registry', registry), \
                 patch.object(routes.dataset_service, '_catalog', return_value={'datasets': {'projects': entry}}), \
                 patch.object(routes, '_resolve_semantic_rev', return_value=1):
                routes.publish_dashboard(routes.DashboardPublication(title='Updated', items=[{'id': 'new', 'revision': 1}]))
            self.assertEqual(store.get('dashboard', 'published')['value']['items'],
                [{'id': 'old', 'revision': 1}, {'id': 'new', 'revision': 1}])
