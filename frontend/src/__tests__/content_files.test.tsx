import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentFiles } from '../components/ContentFiles';
import api from '../services/api';
import { PublishToFiles } from '../components/PublishToFiles';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  getApiErrorMessage: () => 'Storage unavailable',
}));
const dashboard = {
  id: 'a'.repeat(32),
  kind: 'dashboard',
  name: 'Operations',
  parent_id: null,
  revision: 1,
  permission: 'owner',
  description: '',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: url.includes('/preferences') ? { folded: [], revision: 0 } : [],
  }));
});
afterEach(cleanup);
describe('My Files', () => {
  it('publishes a reviewed reference into a specific page and opens the saved dashboard', async () => {
    const pageId = 'b'.repeat(32);
    vi.mocked(api.get).mockImplementation(async (url) => ({
      data:
        url === '/content/tree'
          ? [dashboard]
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
    await screen.findByRole('option', { name: 'My Files / Operations' });
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: dashboard.id } });
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
  it('creates a root dashboard only after the backend confirms', async () => {
    const navigate = vi.fn();
    render(<ContentFiles userKey="alice" active="" navigate={navigate} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    fireEvent.click(screen.getByText('+ Add Files'));
    fireEvent.click(screen.getByText('Create dashboard'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Operations' } });
    vi.mocked(api.post).mockRejectedValueOnce(new Error());
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    vi.mocked(api.post).mockResolvedValueOnce({ data: dashboard });
    vi.mocked(api.put).mockResolvedValueOnce({ data: { folded: [], revision: 1 } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('dashboards/' + dashboard.id));
    expect(api.post).toHaveBeenCalledWith('/content/files', {
      kind: 'dashboard',
      name: 'Operations',
      description: '',
      parent_id: null,
    });
  });
  it('saves expansion through the preferences API', async () => {
    vi.mocked(api.put).mockResolvedValueOnce({ data: { revision: 1, folded: ['root'] } });
    render(<ContentFiles userKey="alice" active="" navigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'My Files' }));
    await waitFor(() => expect(screen.queryByText('+ Add Files')).toBeNull());
    expect(api.put).toHaveBeenCalledWith('/content/preferences', { revision: 0, folded: ['root'] });
  });
});
