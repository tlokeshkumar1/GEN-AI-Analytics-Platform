import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import api from '../services/api';
import { ContentFiles, contentChanged, useFiles } from '../components/ContentFiles';
import { refreshPersonalDashboard } from '../services/personalDashboardService';
import { PersonalDashboard } from '../screens/PersonalDashboard';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  getApiErrorMessage: (error: Error) => error.message,
}));
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(api.get).mockImplementation(async url => ({ data: url.includes('preferences') ? { folded: [], revision: 0 } : [] }));
});
afterEach(cleanup);

function FilesProbe({ label }: { label: string }) {
  const { files, loading } = useFiles();
  return <div>{label}: {loading ? 'loading' : files.length}</div>;
}

it('shares the active tree request and refreshes once for all subscribers', async () => {
  render(<><FilesProbe label="sidebar" /><FilesProbe label="dashboard" /></>);
  await screen.findByText('sidebar: 0');
  expect(screen.getByText('dashboard: 0')).toBeTruthy();
  expect(api.get).toHaveBeenCalledTimes(1);
  act(() => { contentChanged(); });
  await screen.findByText('dashboard: 0');
  expect(api.get).toHaveBeenCalledTimes(2);
});

it('isolates tree requests between account sessions', async () => {
  sessionStorage.setItem('auth_user', 'alice');
  const first = render(<FilesProbe label="alice" />);
  await screen.findByText('alice: 0');
  sessionStorage.setItem('auth_user', 'bob');
  render(<FilesProbe label="bob" />);
  await screen.findByText('bob: 0');
  expect(api.get).toHaveBeenCalledTimes(2);
  first.unmount();
});

it('loads archive/trash on demand and expands immediately while preferences save', async () => {
  vi.mocked(api.put).mockImplementation(() => new Promise(() => {}));
  render(<ContentFiles userKey="alice" active="" navigate={vi.fn()} />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(api.get).toHaveBeenCalledTimes(2); // active tree + preferences
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/content/tree', expect.objectContaining({ params: { deleted: false, archived: true } })));
  fireEvent.click(screen.getByRole('button', { name: 'My Files' }));
  expect(screen.getByRole('button', { name: 'My Files' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'My Files' }));
  expect(screen.getByRole('button', { name: 'My Files' }).getAttribute('aria-expanded')).toBe('true');
});

it('saves the latest rapid folder toggle after an earlier save completes', async () => {
  let finish!: (value: any) => void;
  vi.mocked(api.put).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(api.put).mockResolvedValueOnce({ data: { folded: [], revision: 2 } });
  render(<ContentFiles userKey="alice" active="" navigate={vi.fn()} />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  const root = screen.getByRole('button', { name: 'My Files' });
  fireEvent.click(root);
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  fireEvent.click(root);
  expect(root.getAttribute('aria-expanded')).toBe('true');
  await act(async () => { finish({ data: { folded: ['root'], revision: 1 } }); });
  expect(api.put).toHaveBeenLastCalledWith('/content/preferences', { folded: [], revision: 1 });
  expect(root.getAttribute('aria-expanded')).toBe('true');
});

it('parses partial stream lines and delivers widgets before the request completes', async () => {
  let finish!: (value: any) => void;
  let progress!: (event: any) => void;
  vi.mocked(api.post).mockImplementation((_url, _body, config) => {
    progress = config!.onDownloadProgress!;
    return new Promise(resolve => { finish = resolve; });
  });
  const widget = { type: 'widget', revision: 1, id: 'kpi', value: { error: 'No data' } };
  const line = JSON.stringify(widget);
  const onWidget = vi.fn();
  const pending = refreshPersonalDashboard('dashboard', 'page', 1, new AbortController().signal, onWidget);
  progress({ event: { target: { responseText: line.slice(0, 15) } } });
  expect(onWidget).not.toHaveBeenCalled();
  progress({ event: { target: { responseText: line + '\n' } } });
  expect(onWidget).toHaveBeenCalledWith('kpi', widget.value);
  finish({ data: line + '\n' + JSON.stringify({ type: 'complete', revision: 1 }) + '\n' });
  await pending;
  expect(onWidget).toHaveBeenCalledTimes(1);
});

it('rejects revision mismatches and incomplete streams', async () => {
  vi.mocked(api.post).mockResolvedValueOnce({ data: JSON.stringify({ type: 'start', revision: 2 }) + '\n' });
  await expect(refreshPersonalDashboard('d', 'p', 1, new AbortController().signal, vi.fn())).rejects.toThrow('Dashboard changed');
  vi.mocked(api.post).mockResolvedValueOnce({ data: JSON.stringify({ type: 'start', revision: 1 }) + '\n' });
  await expect(refreshPersonalDashboard('d', 'p', 1, new AbortController().signal, vi.fn())).rejects.toThrow('interrupted');
});

it('preserves results for layout changes and bypasses the result cache on manual refresh', async () => {
  const doc = { id: 'd', kind: 'dashboard', name: 'Metrics', revision: 1, permission: 'owner', pages: [{ id: 'p', name: 'Overview', widgets: [{ id: 'w', title: 'Units', width: 1, source: { id: 'units', dataset_id: 'ds', version: 1, semantic_revision: 1 } }] }] };
  vi.mocked(api.get).mockImplementation(async url => ({ data: url === '/content/tree' ? [] : doc }));
  vi.mocked(api.post).mockImplementation(async url => ({ data: url.endsWith('/refresh') ? { revision: 1, widgets: { w: { error: 'Example result' } } } : {} }));
  render(<PersonalDashboard id="d" navigate={vi.fn()} />);
  await screen.findByText('Example result');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false));
  act(() => { contentChanged({ dashboardId: 'd', layoutOnly: true }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false));
  expect(vi.mocked(api.post).mock.calls.filter(([url]) => url.endsWith('/refresh'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(vi.mocked(api.post).mock.calls.filter(([url]) => url.endsWith('/refresh'))).toHaveLength(2));
  expect(api.post).toHaveBeenLastCalledWith('/content/files/d/refresh', null, expect.objectContaining({ params: { page_id: 'p', stream: true, force: true } }));
});
