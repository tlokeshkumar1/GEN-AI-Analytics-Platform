import { describe, expect, it } from 'vitest';
import { dashboardIdFromRoute, dashboardRoute } from '../services/dashboardRoutes';
import type { FileEntry } from '../components/ContentFiles';

const folder: FileEntry = { id: 'f'.repeat(32), kind: 'folder', name: 'Power INDUSTRY', parent_id: null, description: '', revision: 1, deleted: false };
const dashboard: FileEntry = { ...folder, id: 'a'.repeat(32), kind: 'dashboard', name: 'transactions', parent_id: folder.id };
const files = [folder, dashboard];

describe('readable dashboard routes', () => {
  it('generates the folder path and resolves direct links and existing ID links', () => {
    const route = 'dashboards/My_Files/Power_INDUSTRY/transactions';
    expect(dashboardRoute(files, dashboard.id)).toBe(route);
    expect(dashboardIdFromRoute(files, route)).toBe(dashboard.id);
    expect(dashboardIdFromRoute(files, 'dashboards/' + dashboard.id)).toBe(dashboard.id);
    expect(dashboardIdFromRoute(files, route + '/')).toBe(dashboard.id);
  });
  it('round trips nested folders and reserved characters', () => {
    const nested = { ...folder, id: 'b'.repeat(32), name: 'R&D #1', parent_id: folder.id };
    const updated = [folder, nested, { ...dashboard, parent_id: nested.id, name: 'Sales % 你好' }];
    const path = dashboardRoute(updated, dashboard.id);
    expect(path).toContain('R%26D_%231');
    expect(dashboardIdFromRoute(updated, path)).toBe(dashboard.id);
    expect(dashboardIdFromRoute(updated, 'dashboards/My_Files/%zz')).toBeUndefined();
  });
  it('uses IDs for ambiguous names and rejects unavailable paths', () => {
    const duplicate = { ...folder, id: 'c'.repeat(32), name: 'Power_INDUSTRY' };
    const other = { ...dashboard, id: 'd'.repeat(32), parent_id: duplicate.id };
    const ambiguous = [...files, duplicate, other];
    expect(dashboardRoute(ambiguous, dashboard.id)).toBe('dashboards/' + dashboard.id);
    expect(dashboardIdFromRoute(ambiguous, 'dashboards/My_Files/Power_INDUSTRY/transactions')).toBeUndefined();
    expect(dashboardIdFromRoute([], 'dashboards/My_Files/Power_INDUSTRY/transactions')).toBeUndefined();
  });
});
