import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GeneratedWidgetSections, GeneratedWidget } from '../components/dashboard/GeneratedWidgetSections';
import { Sidebar } from '../components/Sidebar';
import { GraphStudio } from '../screens/GraphStudio';
import api from '../services/api';
import { PublishToFiles, publishable } from '../components/PublishToFiles';

vi.mock('../services/api', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (e: Error) => e.message }));
beforeEach(() => {
  window.dispatchEvent(new Event('neovatic_signed_out_event'));
  localStorage.clear(); sessionStorage.clear(); vi.resetAllMocks();
});
afterEach(cleanup);
const draft = (id: string, kind: string, dataset = 'projects'): GeneratedWidget => ({ definition: {
  id, title: id, kind, revision: 1, semantic_revision: 2, dataset_id: dataset, version: 3,
  query_plan: { metric: 'Revenue', aggregation: 'SUM', ...(kind === 'kpi' ? {} : { dimension: 'Region' }) },
  dependencies: ['Revenue'], explanation: '', status: 'approved', reviewer: 'alice',
}, result: { success: true, data: [{ Revenue: 42, Region: 'East' }], summary: {},
  records_matched: 1, execution_time_ms: 1, execution_backend: 'dataframe' } });

it('hides the results area until widgets are generated', () => {
  render(<GeneratedWidgetSections widgets={[]} onPublished={vi.fn()} />);
  expect(screen.queryByLabelText('Generated results')).toBeNull();
  expect(screen.queryByRole('button', { name: /Publish Selected/ })).toBeNull();
});
it('saves and approves a generated preview, then publishes the returned saved revision with its source headers', async () => {
  setupDestination();
  vi.mocked(api.post).mockImplementation(async (url, body: any) => ({ data:
    url === '/insights/definitions' ? { ...body, revision: 7, status: 'proposed' } :
    url.endsWith('/review') ? { revision: 7, status: 'approved', reviewer: 'alice' } : { placements_written: 1 } }));
  const widget = draft('Generated chart', 'bar');
  widget.definition = { ...widget.definition, status: 'proposed', reviewer: undefined };
  render(<GeneratedWidgetSections widgets={[widget]} onPublished={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Publish Generated chart' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Approve Generated chart' }));
  await screen.findByRole('button', { name: 'Approved Generated chart' });
  expect(api.post).toHaveBeenCalledWith('/insights/definitions', expect.objectContaining({ id: 'Generated chart' }), expect.objectContaining({ headers: {
    'X-Dataset-Id': 'projects', 'X-Dataset-Version': '3', 'X-Semantic-Revision': '2',
  } }));
  expect(api.post).toHaveBeenCalledWith('/insights/definitions/Generated chart/7/review', { decision: 'approved' }, expect.objectContaining({ headers: {
    'X-Dataset-Id': 'projects', 'X-Dataset-Version': '3', 'X-Semantic-Revision': '2',
  } }));
  fireEvent.click(screen.getByRole('button', { name: 'Publish Generated chart' }));
  await screen.findByRole('option', { name: 'My Files / Reports' });
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
  fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: target.id } });
  await screen.findByRole('option', { name: 'Overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Publish selected (1)' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/content/files/' + target.id + '/publish', expect.objectContaining({ sources: [
    { id: 'Generated chart', revision: 7, dataset_id: 'projects', version: 3, semantic_revision: 2 },
  ] })));
});
it('rejects an already saved preview without saving another revision and blocks publishing', async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { status: 'rejected', reviewer: 'alice' } });
  const widget = { ...draft('Generated KPI', 'kpi'), saved: true };
  widget.definition = { ...widget.definition, status: 'proposed', reviewer: undefined };
  render(<GeneratedWidgetSections widgets={[widget]} onPublished={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reject Generated KPI' }));
  await screen.findByText('Rejected');
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/insights/definitions/Generated KPI/1/review', { decision: 'rejected' }, expect.anything());
  expect(screen.getByRole('button', { name: 'Publish Generated KPI' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true);
});
it('keeps a saved revision after review fails so retry does not create another revision', async () => {
  vi.mocked(api.post).mockImplementation(async (url, body: any) => {
    if (url === '/insights/definitions') return { data: { ...body, revision: 4, status: 'proposed' } };
    throw new Error('Review unavailable');
  });
  const widget = draft('Retry KPI', 'kpi');
  widget.definition = { ...widget.definition, status: 'proposed', reviewer: undefined };
  render(<GeneratedWidgetSections widgets={[widget]} onPublished={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve Retry KPI' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Approve Retry KPI' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/insights/definitions')).toHaveLength(1);
  expect(api.post).toHaveBeenLastCalledWith('/insights/definitions/Retry KPI/4/review', { decision: 'approved' }, expect.anything());
});
const folder = { id: 'f'.repeat(32), kind: 'folder', name: 'Reports', permission: 'owner' };
const target = { id: 'a'.repeat(32), kind: 'dashboard', name: 'Sales', parent_id: folder.id, revision: 4, permission: 'owner', pages: [{ id: 'b'.repeat(32), name: 'Overview', widgets: [] }] };
function setupDestination() {
  vi.mocked(api.get).mockImplementation(async url => ({ data: url === '/content/tree' ? [folder, target] : target }));
}
it('accepts system-approved source references while keeping unreviewed widgets blocked', () => {
  const approved = { ...draft('Published KPI', 'kpi').definition, reviewer: 'system' };
  expect(publishable(approved)).toBe(true);
  expect(publishable({ ...approved, status: 'proposed' })).toBe(false);
  expect(publishable({ ...approved, reviewer: undefined })).toBe(false);
  expect(publishable({ ...approved, version: undefined })).toBe(false);
});
it('clearly lists included destinations after the picker resets and disables publishing when removed', async () => {
  setupDestination();
  render(<PublishToFiles items={[draft('KPI', 'kpi').definition]} close={vi.fn()} navigate={vi.fn()} />);
  const publish = screen.getByRole('button', { name: 'Publish selected (1)' });
  expect(publish).toHaveProperty('disabled', true);
  await screen.findByRole('option', { name: 'My Files / Reports' });
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
  fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: target.id } });
  await screen.findByRole('option', { name: 'Overview' });
  expect(screen.getByRole('region', { name: 'Selected destinations' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Include this destination and choose another' }));
  expect(screen.getByLabelText('Dashboard')).toHaveProperty('value', '');
  expect(publish).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Remove My Files / Reports / Sales' }));
  expect(publish).toHaveProperty('disabled', true);
  expect(api.post).not.toHaveBeenCalled();
});
it('explains approval requirements before submission instead of allowing a rejected publish attempt', async () => {
  setupDestination();
  render(<PublishToFiles items={[{ ...draft('Draft KPI', 'kpi').definition, status: 'proposed' }]} close={vi.fn()} navigate={vi.fn()} />);
  await screen.findByRole('option', { name: 'My Files / Reports' });
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
  fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: target.id } });
  await screen.findByRole('option', { name: 'Overview' });
  expect(screen.getByText(/need approval or a saved source version/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Publish selected (1)' })).toHaveProperty('disabled', true);
  expect(api.post).not.toHaveBeenCalled();
});
it('groups previews and requires a confirmed destination with the original dataset reference', async () => {
  setupDestination();
  vi.mocked(api.post).mockResolvedValue({ data: { placements_written: 1 } });
  const published = vi.fn();
  render(<GeneratedWidgetSections widgets={[draft('Revenue KPI', 'kpi'), draft('Readiness', 'gauge'), draft('Regional chart', 'bar', 'sales')]} onPublished={published} />);
  expect(within(screen.getByRole('region', { name: 'KPI Generation' })).getByRole('checkbox', { name: /Revenue KPI/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /Regional chart/ }));
  fireEvent.click(screen.getByRole('button', { name: /Publish Selected/ }));
  await screen.findByRole('dialog', { name: 'Publish to dashboard' });
  expect(api.post).not.toHaveBeenCalled();
  await screen.findByRole('option', { name: 'My Files / Reports' });
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
  fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: target.id } });
  await screen.findByRole('option', { name: 'Overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Publish selected (1)' }));
  await waitFor(() => expect(published).toHaveBeenCalledWith(['Regional chart']));
  expect(api.post).toHaveBeenCalledWith('/content/files/' + target.id + '/publish', expect.objectContaining({
    duplicates: 'skip', revision: 4, page_id: target.pages[0].id,
    sources: [{ id: 'Regional chart', revision: 1, dataset_id: 'sales', version: 3, semantic_revision: 2 }],
  }));
});
it('keeps failed destination publications available for retry', async () => {
  setupDestination();
  vi.mocked(api.post).mockRejectedValue(new Error('Publish failed'));
  const published = vi.fn();
  render(<GeneratedWidgetSections widgets={[draft('Revenue KPI', 'kpi')]} onPublished={published} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Publish Selected/ }));
  await screen.findByRole('option', { name: 'My Files / Reports' });
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
  fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: target.id } });
  await screen.findByRole('option', { name: 'Overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Publish selected (1)' }));
  expect(await screen.findByText(/Publish failed/)).toBeTruthy();
  expect(published).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Retry failed destinations' })).toBeTruthy();
});
it('places Widgets immediately before Data Explorer in the sidebar', () => {
  const navigate = vi.fn();
  render(<Sidebar activePath="widgets" onNavigate={navigate} isOpen onClose={vi.fn()} user={{ role: 'Admin' }} />);
  const buttons = screen.getAllByRole('button');
  const widgets = screen.getByRole('button', { name: /Widgets/ });
  const explorer = screen.getByRole('button', { name: /Data Explorer/ });
  expect(buttons.indexOf(explorer)).toBe(buttons.indexOf(widgets) + 1);
  fireEvent.click(widgets);
  expect(navigate).toHaveBeenCalledWith('widgets');
});

function setupStudio() {
  const item = draft('Saved KPI', 'kpi').definition;
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data:
    url === '/datasets' ? [{ id: 'projects', name: 'Projects', currentVersion: 3, isActive: true, columns: [] }] :
    url.includes('semantics') ? [{ revision: 2, status: 'approved', fields: [{ name: 'Revenue', semantic_name: 'Revenue', role: 'measure', type: 'decimal' }], relationships: [], derived_metrics: [] }] :
    url.includes('/recommendations') ? [item] : url.includes('/insights/dashboard') ? { items: [] } : [] }));
  vi.mocked(api.post).mockImplementation(async (url, body) => ({ data: url === '/insights/execute' ? draft('x', 'kpi').result : body || {} }));
}
it.each(['existing', 'new'])('publishes only four explicitly selected widgets to a %s dashboard when fifteen are already live', async destination => {
  const live = Array.from({ length: 15 }, (_, index) => draft(`Live ${index}`, 'kpi').definition);
  const additions = Array.from({ length: 4 }, (_, index) => ({
    ...draft('shared-widget-id', 'kpi', `source-${index}`).definition,
    title: `New widget ${index}`, version: index + 2,
  }));
  let created = destination === 'existing';
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data:
    url === '/datasets' ? [{ id: 'projects', name: 'Projects', currentVersion: 3, isActive: true, columns: [] }] :
    url.includes('semantics') ? [{ revision: 2, status: 'approved', fields: [], relationships: [], derived_metrics: [] }] :
    url.includes('/recommendations') ? [...live, ...additions] :
    url.includes('/insights/dashboard') ? { items: live.map(({ id, revision }) => ({ id, revision })) } :
    url === '/content/tree' ? (created ? [folder, target] : [folder]) :
    url.includes('/content/files/') ? target : [] }));
  vi.mocked(api.post).mockImplementation(async url => {
    if (url === '/content/files') { created = true; return { data: target }; }
    return { data: { placements_written: 4 } };
  });
  render(<GraphStudio widgetsOnly onNavigate={vi.fn()} />);
  await screen.findByRole('heading', { name: 'New widget 3' });
  expect(screen.getByRole('button', { name: /Publish to Dashboard/ })).toHaveProperty('disabled', true);
  expect(screen.getByText('15 on Dashboard')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Not on Dashboard (4)' }));
  additions.forEach(item => fireEvent.click(screen.getByRole('checkbox', { name: `Select ${item.title}` })));
  expect(screen.getByText('4 widgets selected to publish')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Publish 4 Widgets/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Publish to dashboard' });
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(4);
  expect(within(dialog).queryByText('Live 0')).toBeNull();
  await screen.findByRole('option', { name: 'My Files / Reports' });
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder.id } });
  if (destination === 'new') {
    fireEvent.click(screen.getByRole('button', { name: '+ New Dashboard' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
  } else fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: target.id } });
  await screen.findByRole('option', { name: 'Overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Publish selected (4)' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/content/files/' + target.id + '/publish', expect.objectContaining({
    sources: additions.map(({ id, revision, dataset_id, version, semantic_revision }) => ({ id, revision, dataset_id, version, semantic_revision })),
  })));
});
it('shows saved widget cards in the Widgets library with creation inputs hidden', async () => {
  setupStudio();
  render(<GraphStudio widgetsOnly onNavigate={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: 'Widgets' })).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Saved KPI' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Preview Live/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Edit Query/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approved Saved KPI' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: /Execute Analysis/ })).toBeNull();
});
it('offers Approve on each system-recommended library card and confirms through the review endpoint', async () => {
  const item = { ...draft('Suggested KPI', 'kpi').definition, reviewer: 'system' };
  vi.mocked(api.get).mockImplementation(async url => ({ data:
    url === '/datasets' ? [{ id: 'projects', name: 'Projects', currentVersion: 3, isActive: true, columns: [] }] :
    url.includes('semantics') ? [{ revision: 2, status: 'approved', fields: [], relationships: [], derived_metrics: [] }] :
    url.includes('/recommendations') ? [item] : url.includes('/insights/dashboard') ? { items: [] } : [] }));
  vi.mocked(api.post).mockResolvedValue({ data: { ...item, reviewer: 'alice' } });
  render(<GraphStudio widgetsOnly onNavigate={vi.fn()} />);
  const approve = await screen.findByRole('button', { name: 'Approve Suggested KPI' });
  expect(approve).toHaveProperty('disabled', false);
  fireEvent.click(approve);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/insights/definitions/Suggested KPI/1/review', { decision: 'approved' }, expect.objectContaining({ headers: {
    'X-Dataset-Id': 'projects', 'X-Dataset-Version': '3', 'X-Semantic-Revision': '2',
  } })));
  await waitFor(() => expect(approve).toHaveProperty('disabled', true));
  expect(screen.getByRole('button', { name: 'Approved Suggested KPI' })).toBe(approve);
});
it('places a manually created widget in KPI Generation without opening the library', async () => {
  setupStudio();
  render(<GraphStudio initialMode="visual" onNavigate={vi.fn()} />);
  const title = await screen.findByPlaceholderText(/e.g. Net Revenue by Region/i);
  fireEvent.change(title, { target: { value: 'My generated KPI' } });
  fireEvent.click(screen.getByRole('button', { name: /Generate Widget/ }));
  const section = await screen.findByRole('region', { name: 'KPI Generation' });
  expect(await within(section).findByRole('checkbox', { name: /My generated KPI/ })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Chart Generation' })).toBeNull();
  expect(screen.queryByText(/Configured Definitions/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /1. Generative AI Dashboards/ }));
  expect(screen.queryByRole('region', { name: 'KPI Generation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Build Your Dashboards/ }));
  expect(screen.getByRole('region', { name: 'KPI Generation' })).toBeTruthy();
});
