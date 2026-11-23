import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GeneratedWidgetSections, GeneratedWidget } from '../components/dashboard/GeneratedWidgetSections';
import { Sidebar } from '../components/Sidebar';
import { GraphStudio } from '../screens/GraphStudio';
import api from '../services/api';

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
  dependencies: ['Revenue'], explanation: '', status: 'proposed',
}, result: { success: true, data: [{ Revenue: 42, Region: 'East' }], summary: {},
  records_matched: 1, execution_time_ms: 1, execution_backend: 'dataframe' } });

it('hides the results area until widgets are generated', () => {
  render(<GeneratedWidgetSections widgets={[]} onPublished={vi.fn()} />);
  expect(screen.queryByLabelText('Generated results')).toBeNull();
  expect(screen.queryByRole('button', { name: /Publish Selected/ })).toBeNull();
});
it('groups previews and publishes only selected widgets using their original dataset context', async () => {
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  const published = vi.fn();
  render(<GeneratedWidgetSections widgets={[draft('Revenue KPI', 'kpi'), draft('Readiness', 'gauge'), draft('Regional chart', 'bar', 'sales')]} onPublished={published} />);
  expect(within(screen.getByRole('region', { name: 'KPI Generation' })).getByRole('checkbox', { name: /Revenue KPI/ })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'KPI Generation' })).getByRole('checkbox', { name: /Readiness/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /Regional chart/ }));
  fireEvent.click(screen.getByRole('button', { name: /Publish Selected/ }));
  await waitFor(() => expect(published).toHaveBeenCalledWith(['Regional chart']));
  expect(api.post).toHaveBeenCalledWith('/dashboard/publish-recommended', expect.objectContaining({
    items: [expect.objectContaining({ id: 'Regional chart', kind: 'bar' })],
  }), { headers: { 'X-Dataset-Id': 'sales', 'X-Dataset-Version': '3', 'X-Semantic-Revision': '2' } });
});
it('keeps failed widgets available for retry', async () => {
  vi.mocked(api.post).mockRejectedValue(new Error('Publish failed'));
  const published = vi.fn();
  render(<GeneratedWidgetSections widgets={[draft('Revenue KPI', 'kpi')]} onPublished={published} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Publish Selected/ }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Publish failed');
  expect(published).not.toHaveBeenCalled();
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);
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
it('shows saved widget cards in the Widgets library with creation inputs hidden', async () => {
  setupStudio();
  render(<GraphStudio widgetsOnly onNavigate={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: 'Widgets' })).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Saved KPI' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Preview Live/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Edit Query/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Execute Analysis/ })).toBeNull();
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
