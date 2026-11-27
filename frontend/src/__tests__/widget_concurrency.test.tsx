import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import api from '../services/api';
import { GeneratedWidgetSections, type GeneratedWidget } from '../components/dashboard/GeneratedWidgetSections';
import { PublishToFiles } from '../components/PublishToFiles';
import { RecommendationReview } from '../components/RecommendationReview';
import { runWidgetTask } from '../services/widgetTaskQueue';

vi.mock('../services/api', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, getApiErrorMessage: (error: Error) => error.message }));
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); localStorage.clear(); });
afterEach(cleanup);
const widget = (id: string): GeneratedWidget => ({ saved: true, definition: {
  id, title: id, kind: 'kpi', dataset_id: 'ds', version: 2, semantic_revision: 3, revision: 1,
  status: 'proposed', query_plan: { metric: 'units', aggregation: 'SUM' }, dependencies: ['units'], explanation: '',
}, result: { success: true, data: [{ units: 12 }], summary: {}, records_matched: 1, execution_time_ms: 0, execution_backend: 'dataframe' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('runs mixed approve/reject requests together and keeps unrelated cards usable', async () => {
  const first = deferred<any>(); const second = deferred<any>(); const third = deferred<any>();
  vi.mocked(api.post).mockImplementation(url => url.includes('/A/') ? first.promise : url.includes('/B/') ? second.promise : third.promise);
  render(<GeneratedWidgetSections widgets={['A', 'B', 'C'].map(widget)} onPublished={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve A' }));
  expect(screen.getByRole('button', { name: 'Reject B' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Reject B' }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve C' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  await act(async () => { third.resolve({ data: { status: 'approved', reviewer: 'alice' } }); });
  expect(screen.getByRole('button', { name: 'Publish C' })).toHaveProperty('disabled', false);
  expect(screen.getByRole('button', { name: 'Approve A' })).toHaveProperty('disabled', true);
  await act(async () => {
    first.resolve({ data: { status: 'approved', reviewer: 'alice' } });
    second.resolve({ data: { status: 'rejected', reviewer: 'alice' } });
  });
  expect(screen.getByRole('button', { name: 'Publish A' })).toHaveProperty('disabled', false);
  expect(screen.getByRole('button', { name: 'Publish B' })).toHaveProperty('disabled', true);
  expect(vi.mocked(api.post).mock.calls.map(([, body]) => body)).toEqual([{ decision: 'approved' }, { decision: 'rejected' }, { decision: 'approved' }]);
});

it('bulk reviews the selected cards and keeps individual failures available for retry', async () => {
  vi.mocked(api.post).mockImplementation(async url => {
    if (url.includes('/B/')) throw new Error('B review failed');
    return { data: { status: 'approved', reviewer: 'alice' } };
  });
  render(<GeneratedWidgetSections widgets={['A', 'B', 'C'].map(widget)} onPublished={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
  await screen.findByText('B review failed');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Publish C' })).toHaveProperty('disabled', false));
  expect(screen.getByRole('button', { name: 'Publish A' })).toHaveProperty('disabled', false);
  expect(screen.getByRole('button', { name: 'Approve B' })).toHaveProperty('disabled', false);
  expect(api.post).toHaveBeenCalledTimes(3);
});

it('limits the shared task pool to four concurrent requests and releases slots after failure', async () => {
  const gates = Array.from({ length: 7 }, () => deferred<number>());
  const started: number[] = [];
  const pending = gates.map((gate, index) => runWidgetTask(() => { started.push(index); return gate.promise; }));
  const settled = Promise.allSettled(pending);
  await waitFor(() => expect(started).toHaveLength(4));
  gates[0].reject(new Error('One failed'));
  await waitFor(() => expect(started).toHaveLength(5));
  gates[1].resolve(1); gates[2].resolve(2);
  await waitFor(() => expect(started).toHaveLength(7));
  gates.slice(3).forEach((gate, index) => gate.resolve(index + 3));
  expect((await settled).filter(result => result.status === 'fulfilled')).toHaveLength(6);
});

it('rejects all selected proposals together and removes them from the publish selection', async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { status: 'rejected', reviewer: 'alice' } });
  render(<GeneratedWidgetSections widgets={['A', 'B', 'C'].map(widget)} defaultSelected onPublished={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reject selected' }));
  await waitFor(() => expect(screen.getAllByText('Rejected')).toHaveLength(3));
  expect(api.post).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('button', { name: 'Publish Selected Widgets (0)' })).toHaveProperty('disabled', true);
});

it('starts publication to multiple selected dashboards before either request finishes', async () => {
  const folder = { id: 'f'.repeat(32), kind: 'folder', name: 'Reports', permission: 'owner', parent_id: null };
  const makeDashboard = (id: string, name: string) => ({ id, name, kind: 'dashboard', parent_id: folder.id, permission: 'owner', revision: 1, pages: [{ id: 'c'.repeat(32), name: 'Overview', widgets: [] }] });
  const first = makeDashboard('a'.repeat(32), 'First'); const second = makeDashboard('b'.repeat(32), 'Second');
  vi.mocked(api.get).mockImplementation(async url => ({ data: url === '/content/tree' ? [folder, first, second] : url.endsWith(first.id) ? first : second }));
  const one = deferred<any>(); const two = deferred<any>();
  vi.mocked(api.post).mockImplementation(url => url.includes(first.id) ? one.promise : two.promise);
  render(<PublishToFiles items={[{ ...widget('A').definition, status: 'approved', reviewer: 'alice' }]} close={vi.fn()} navigate={vi.fn()} />);
  await screen.findByRole('option', { name: 'My Files / Reports' });
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
  fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: first.id } });
  await screen.findByRole('option', { name: 'Overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Include this destination and choose another' }));
  fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: second.id } });
  await screen.findByRole('option', { name: 'Overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Publish selected (1)' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  await act(async () => { one.resolve({ data: { placements_written: 1 } }); two.resolve({ data: { placements_written: 1 } }); });
  expect(await screen.findAllByRole('button', { name: 'Open dashboard' })).toHaveLength(2);
});

it('loads upload recommendations from their exact source and supports parallel reviews there too', async () => {
  const recommendations = ['A', 'B'].map(id => ({ ...widget(id).definition, selected_by_default: true, preview_value: '12', definition: widget(id).definition }));
  vi.mocked(api.get).mockResolvedValue({ data: recommendations.map(rec => rec.definition) });
  const one = deferred<any>(); const two = deferred<any>();
  vi.mocked(api.post).mockImplementation(url => url === '/insights/execute' ? Promise.resolve({ data: widget('A').result }) : url.includes('/A/') ? one.promise : two.promise);
  const { unmount } = render(<RecommendationReview recommendations={recommendations} datasetId="ds" version={2} semanticRevision={3} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve A' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: 'Approve A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reject B' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(4));
  expect(api.get).toHaveBeenCalledWith('/insights/recommendations', expect.objectContaining({ headers: { 'X-Dataset-Id': 'ds', 'X-Dataset-Version': '2', 'X-Semantic-Revision': '3' } }));
  await act(async () => { one.resolve({ data: { status: 'approved', reviewer: 'alice' } }); two.resolve({ data: { status: 'rejected', reviewer: 'alice' } }); });
  expect(screen.getByRole('button', { name: 'Publish Selected Widgets (1)' })).toHaveProperty('disabled', false);
  // Reopening an activity uses the persisted review state rather than its old report snapshot.
  unmount();
  vi.mocked(api.get).mockResolvedValue({ data: [{ ...widget('A').definition, status: 'approved', reviewer: 'alice' }, { ...widget('B').definition, status: 'rejected', reviewer: 'alice' }] });
  render(<RecommendationReview recommendations={recommendations} datasetId="ds" version={2} semanticRevision={3} />);
  const approved = await screen.findByRole('button', { name: 'Publish A' });
  await waitFor(() => expect(approved).toHaveProperty('disabled', false));
  expect(screen.getByRole('button', { name: 'Reject B' })).toHaveProperty('disabled', true);
});
