import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import api from '../services/api';
import { HanaMetadataViews } from '../components/HanaMetadataViews';
vi.mock('../services/api', () => ({ default: { get: vi.fn() }, getApiErrorMessage: (e: Error) => e.message }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
it('displays categories, counts and read-only JSON records without delete controls', async () => {
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url === '/hanaadmin/views' ? { views: [
    { name: 'PM_ANALYTICS_V', label: 'KPIs & Charts', description: 'Widget definitions', rowCount: 26, available: true },
    { name: 'PM_DASHBOARDS_V', label: 'Dashboards', description: 'Published references', rowCount: 2, available: true },
  ] } : { publicationCounts: { all: 26, published: 10, unpublished: 16 }, totalRows: 26, rows: [{ namespace: 'default:analytics:1:ds:v1', documentId: 'widget:1', revision: 1, published: true, payload: '{"title":"Revenue"}', truncated: false }] } }));
  render(<HanaMetadataViews />);
  expect(await screen.findByRole('button', { name: /KPIs & Charts/ })).toBeTruthy();
  expect(await screen.findByText('widget:1')).toBeTruthy();
  fireEvent.click(screen.getByText('View JSON'));
  expect(screen.getByText(/"title": "Revenue"/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/hanaadmin/views/PM_ANALYTICS_V/data', { params: { page: 2, pageSize: 25, publication: 'all' } }));
  await screen.findByText('widget:1');
  fireEvent.click(screen.getByRole('button', { name: 'Not Published (16)' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/hanaadmin/views/PM_ANALYTICS_V/data', { params: { page: 1, pageSize: 25, publication: 'unpublished' } }));
  await screen.findByText('widget:1');
  fireEvent.click(screen.getByRole('button', { name: /^Dashboards / }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/hanaadmin/views/PM_DASHBOARDS_V/data', { params: { page: 1, pageSize: 25 } }));
});
it('shows connection failures without stale records', async () => {
  vi.mocked(api.get).mockRejectedValue(new Error('HANA offline'));
  render(<HanaMetadataViews />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'HANA offline');
});
