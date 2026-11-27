import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentFiles } from '../components/ContentFiles';
import { Sidebar } from '../components/Sidebar';
import api from '../services/api';
import { SaveDashboardDialog } from '../components/SaveDashboard';
import { PersonalDashboard } from '../screens/PersonalDashboard';
import { ExecutiveDashboard, invalidateDashboardCache } from '../screens/ExecutiveDashboard';
import { PublishToFiles } from '../components/PublishToFiles';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  getApiErrorMessage: () => 'Storage unavailable',
}));
const folder = { id: 'f'.repeat(32), kind: 'folder', name: 'Reports', parent_id: null, permission: 'owner', revision: 1, description: '', deleted: false };
const dashboard = {
  id: 'a'.repeat(32),
  kind: 'dashboard',
  name: 'Operations',
  parent_id: folder.id,
  revision: 1,
  permission: 'owner',
  description: '',
};
beforeEach(() => {
  vi.resetAllMocks();
  invalidateDashboardCache();
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: url.includes('/preferences') ? { folded: [], revision: 0 } : [],
  }));
});
afterEach(cleanup);
describe('My Files', () => {
  it('opens folder actions outside the sidebar and supports keyboard and outside dismissal', async () => {
    vi.mocked(api.get).mockImplementation(async url => ({
      data: url.includes('/preferences') ? { folded: [], revision: 0 } : [folder],
    }));
    render(<ContentFiles userKey="alice" active="" navigate={vi.fn()} />);
    const trigger = await screen.findByRole('button', { name: 'Actions for Reports' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Actions for Reports' });
    expect(screen.getByRole('region', { name: 'Personal files' }).contains(menu)).toBe(false);
    const first = screen.getByRole('menuitem', { name: 'Add to favourites' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create folder' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Create folder' })).toBeTruthy();
  });
  it('keeps storage configuration errors and retry links out of the sidebar on load', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('My Files HANA service is not bound to the API.'));
    render(<ContentFiles userKey="alice" active="" navigate={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.getByRole('button', { name: 'Add Files' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('Storage unavailable')).toBeNull();
  });
  it('uses the same section styling and expansion behavior as the other sidebar groups', async () => {
    render(<Sidebar activePath="" isOpen isCollapsed={false} onNavigate={vi.fn()} onClose={vi.fn()} user={{ email: 'alice', role: 'Admin' }} />);
    const mine = screen.getByRole('button', { name: 'My Files' });
    expect(mine.className).toBe(screen.getByRole('button', { name: 'AI Dashboards' }).className);
    expect(mine.className).toBe(screen.getByRole('button', { name: 'Administration' }).className);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    vi.mocked(api.put).mockResolvedValue({ data: { folded: ['root'], revision: 1 } });
    fireEvent.click(mine);
    await waitFor(() => expect(mine.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.queryByText('Add Files')).toBeNull();
  });
  it('publishes a reviewed reference into a specific page and opens the saved dashboard', async () => {
    const pageId = 'b'.repeat(32);
    vi.mocked(api.get).mockImplementation(async (url) => ({
      data:
        url === '/content/tree'
          ? [folder, dashboard]
          : { ...dashboard, pages: [{ id: pageId, name: 'Overview', widgets: [] }] },
    }));
    vi.mocked(api.post).mockResolvedValueOnce({ data: { placements_written: 1 } });
    const navigate = vi.fn();
    const item = {
      id: 'units',
      revision: 2,
      semantic_revision: 1,
      title: 'Units',
      kind: 'kpi',
      dataset_id: 'ops',
      dataset_name: 'Operations',
      version: 3,
      status: 'approved' as const,
      reviewer: 'alice',
      explanation: 'Reviewed',
      query_plan: {},
      dependencies: [],
    };
    render(<PublishToFiles items={[item]} close={vi.fn()} navigate={navigate} />);
    await screen.findByRole('option', { name: 'My Files / Reports' });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
    fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: dashboard.id } });
    await screen.findByRole('option', { name: 'Overview' });
    fireEvent.click(screen.getByText('Publish selected (1)'));
    fireEvent.click(await screen.findByText('Open dashboard'));
    expect(navigate).toHaveBeenCalledWith('dashboards/' + dashboard.id);
    expect(api.post).toHaveBeenCalledWith('/content/files/' + dashboard.id + '/publish', {
      request_id: expect.any(String),
      page_id: pageId,
      revision: 1,
      duplicates: 'skip',
      sources: [{ id: 'units', revision: 2, semantic_revision: 1, dataset_id: 'ops', version: 3 }],
    });
  });
  it('starts with Add Files and creates a folder before a named dashboard', async () => {
    const navigate = vi.fn();
    render(<ContentFiles userKey="alice" active="" navigate={navigate} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    for (const name of ['Create dashboard', 'Shared with me', 'Favourites', 'Recently viewed']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // Archive/trash remain reachable without eagerly fetching their contents.
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deleted Files' })).toBeTruthy();
    fireEvent.click(screen.getByText('Add Files'));
    expect(screen.getByRole('dialog', { name: 'Create folder' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reports' } });
    vi.mocked(api.post).mockRejectedValueOnce(new Error());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    vi.mocked(api.get).mockImplementation(async url => ({ data: url.includes('preferences') ? { folded: [], revision: 0 } : [folder] }));
    vi.mocked(api.post).mockResolvedValueOnce({ data: folder });
    vi.mocked(api.put).mockResolvedValue({ data: { folded: [], revision: 1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Create dashboard' });
    expect(screen.getByLabelText('Name')).toHaveProperty('value', '');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Operations' } });
    vi.mocked(api.post).mockResolvedValueOnce({ data: dashboard });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('dashboards/' + dashboard.id));
    expect(api.post).toHaveBeenLastCalledWith('/content/files', {
      kind: 'dashboard', name: 'Operations', description: '', parent_id: folder.id,
    });
  });
  it('offers inline destination creation and blocks publication without confirmation', async () => {
    render(<PublishToFiles items={[]} close={vi.fn()} navigate={vi.fn()} />);
    expect(await screen.findByText('Create your first folder to organize this dashboard.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ New Dashboard' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '+ New Folder' }));
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Reports' } });
    vi.mocked(api.get).mockResolvedValue({ data: [folder] });
    vi.mocked(api.post).mockResolvedValueOnce({ data: folder });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '+ New Dashboard' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: '+ New Dashboard' }));
    expect(screen.getByLabelText('Destination folder')).toHaveProperty('value', folder.id);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it('saves an unnamed dashboard with a folder and name through the content repository', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [folder] });
    vi.mocked(api.post).mockResolvedValue({ data: dashboard });
    const saved = vi.fn();
    render(<SaveDashboardDialog close={vi.fn()} saved={saved} />);
    await screen.findByRole('option', { name: 'My Files / Reports' });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
    fireEvent.change(screen.getByLabelText('Dashboard name'), { target: { value: 'Operations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(dashboard));
    expect(api.post).toHaveBeenCalledWith('/content/dashboards/save', { name: 'Operations', parent_id: folder.id, sources: [] });
  });
  it('sends each widgets own dataset version when saving a dashboard', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [folder] });
    vi.mocked(api.post).mockResolvedValue({ data: dashboard });
    const items = [2, 7].map((version, index) => ({
      id: 'metric', revision: 1, dataset_id: `dataset-${index}`, version,
      semantic_revision: 3, title: 'Metric', kind: 'kpi', query_plan: {},
      dependencies: [], explanation: '', status: 'approved' as const,
    }));
    render(<SaveDashboardDialog items={items} close={vi.fn()} saved={vi.fn()} />);
    await screen.findByRole('option', { name: 'My Files / Reports' });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
    fireEvent.change(screen.getByLabelText('Dashboard name'), { target: { value: 'Combined report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/content/dashboards/save', {
      name: 'Combined report', parent_id: folder.id,
      sources: items.map(({ id, revision, dataset_id, version, semantic_revision }) => ({ id, revision, dataset_id, version, semantic_revision })),
    }));
  });
  it('shows a spinner, prevents repeated saves and restores controls after an error', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [folder] });
    let rejectSave!: (reason: Error) => void;
    vi.mocked(api.post).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const saved = vi.fn();
    const close = vi.fn();
    render(<SaveDashboardDialog close={close} saved={saved} />);
    await screen.findByRole('option', { name: 'My Files / Reports' });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
    fireEvent.change(screen.getByLabelText('Dashboard name'), { target: { value: 'Operations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    const saving = screen.getByRole('button', { name: 'Saving dashboard...' });
    expect(saving).toHaveProperty('disabled', true);
    expect(saving.querySelector('svg.animate-spin')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Saving dashboard...');
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Dashboard name').matches(':disabled')).toBe(true);
    fireEvent.click(saving);
    expect(api.post).toHaveBeenCalledTimes(1);
    rejectSave(new Error('Save failed'));
    await screen.findByRole('alert');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save dashboard' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveProperty('disabled', false);
    expect(saved).not.toHaveBeenCalled();
    vi.mocked(api.post).mockResolvedValueOnce({ data: dashboard });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(dashboard));
  });
  it('asks for a name on first Save and updates the same destination on the next Save', async () => {
    vi.mocked(api.get).mockImplementation(async url => ({ data: url === '/content/tree' ? [folder] :
      url.startsWith('/dashboard?') ? { title: 'Dashboard', widgets: [], status: 'draft' } : [] }));
    vi.mocked(api.post).mockResolvedValue({ data: dashboard });
    const navigate = vi.fn();
    render(<ExecutiveDashboard onNavigate={navigate} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: 'Save dashboard' })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    await screen.findByRole('option', { name: 'My Files / Reports' });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
    fireEvent.change(screen.getByLabelText('Dashboard name'), { target: { value: 'Operations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('dashboards/' + dashboard.id));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/content/dashboards/save', {
      dashboard_id: dashboard.id, revision: dashboard.revision, sources: [],
    }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('saves a named dashboard in place and exposes Save As in its contextual menu', async () => {
    const doc = { ...dashboard, pages: [{ id: 'b'.repeat(32), name: 'Overview', widgets: [] }] };
    vi.mocked(api.get).mockImplementation(async url => ({ data: url === '/content/tree' ? [folder, dashboard] : doc }));
    vi.mocked(api.post).mockResolvedValue({ data: { ...doc, revision: 2 } });
    render(<PersonalDashboard id={dashboard.id} navigate={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Operations' });
    const buttons = screen.getAllByRole('button');
    expect(buttons.indexOf(screen.getByText('Save'))).toBe(buttons.indexOf(screen.getByText('Configure KPIs')) + 1);
    expect(buttons.indexOf(screen.getByText('Refresh'))).toBe(buttons.indexOf(screen.getByText('Save')) + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Dashboard saved.');
    expect(api.post).toHaveBeenCalledWith('/content/dashboards/save', { dashboard_id: dashboard.id, revision: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard actions' }));
    fireEvent.click(screen.getByText('Save As'));
    expect(await screen.findByRole('dialog', { name: 'Save dashboard as' })).toBeTruthy();
  });
  it('saves expansion through the preferences API', async () => {
    vi.mocked(api.put).mockResolvedValueOnce({ data: { revision: 1, folded: ['root'] } });
    render(<ContentFiles userKey="alice" active="" navigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'My Files' }));
    await waitFor(() => expect(screen.queryByText('Add Files')).toBeNull());
    expect(api.put).toHaveBeenCalledWith('/content/preferences', { revision: 0, folded: ['root'] });
  });
});
