import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import api from '../services/api';
import { ExecutiveDashboard } from '../screens/ExecutiveDashboard';
import { cachedExecutiveDashboard, invalidateExecutiveDashboard, loadExecutiveDashboard } from '../services/executiveDashboardService';

const state = vi.hoisted(() => ({ context: { datasetId: 'sales', version: 1, semanticRevision: 1 } as any }));
vi.mock('../services/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getApiErrorMessage: (error: Error) => error.message }));
vi.mock('../services/executionContext', () => ({
  selectedContext: () => state.context,
  ensureDefaultContext: async () => {
    state.context = { datasetId: 'sales', version: 1, semanticRevision: 1 };
    window.dispatchEvent(new Event('dataset-context-changed'));
    return state.context;
  },
}));
vi.mock('../services/datasetService', () => ({ getDatasets: async () => [] }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const data = (title: string) => ({ title, widgets: [], status: 'published' });
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('auth_user', JSON.stringify({ user_id: 'alice', tenant_id: 't', workspace_id: 'w' }));
  state.context = { datasetId: 'sales', version: 1, semanticRevision: 1 };
  invalidateExecutiveDashboard();
});
afterEach(cleanup);

it('coalesces simultaneous dashboard requests', async () => {
  const request = deferred<any>();
  vi.mocked(api.get).mockReturnValue(request.promise);
  const first = loadExecutiveDashboard();
  const second = loadExecutiveDashboard();
  expect(api.get).toHaveBeenCalledTimes(1);
  request.resolve({ data: data('Sales') });
  expect((await first).data.title).toBe('Sales');
  expect((await second).data.title).toBe('Sales');
});

it('does not share cached responses between users or dataset versions', async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ data: data('Alice') }).mockResolvedValueOnce({ data: data('Bob') }).mockResolvedValueOnce({ data: data('Bob v2') });
  await loadExecutiveDashboard();
  localStorage.setItem('auth_user', JSON.stringify({ user_id: 'bob', tenant_id: 't', workspace_id: 'w' }));
  expect(cachedExecutiveDashboard()).toBeNull();
  expect((await loadExecutiveDashboard()).data.title).toBe('Bob');
  state.context = { ...state.context, version: 2 };
  expect(cachedExecutiveDashboard()).toBeNull();
  expect((await loadExecutiveDashboard()).data.title).toBe('Bob v2');
  expect(api.get).toHaveBeenCalledTimes(3);
});

it('does not cache a response that finishes after logout or invalidation', async () => {
  const request = deferred<any>();
  vi.mocked(api.get).mockReturnValue(request.promise);
  const active = loadExecutiveDashboard();
  window.dispatchEvent(new Event('neovatic_signed_out_event'));
  request.resolve({ data: data('Old') });
  await active;
  expect(cachedExecutiveDashboard()).toBeNull();
});

it('releases failed requests so retry can succeed', async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error('Backend unavailable')).mockResolvedValueOnce({ data: data('Recovered') });
  await expect(loadExecutiveDashboard()).rejects.toThrow('Backend unavailable');
  expect((await loadExecutiveDashboard()).data.title).toBe('Recovered');
  expect(api.get).toHaveBeenCalledTimes(2);
});

it('initial context hydration does not trigger duplicate dashboard requests', async () => {
  state.context = null;
  vi.mocked(api.get).mockResolvedValue({ data: data('Hydrated') });
  render(<ExecutiveDashboard onNavigate={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: 'Hydrated' })).toBeTruthy();
  expect(api.get).toHaveBeenCalledTimes(1);
});

it('an older response cannot replace a newer dashboard refresh', async () => {
  const old = deferred<any>(); const fresh = deferred<any>();
  vi.mocked(api.get).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  render(<ExecutiveDashboard onNavigate={vi.fn()} />);
  act(() => { window.dispatchEvent(new Event('dashboard_updated')); });
  await act(async () => { fresh.resolve({ data: data('Fresh') }); });
  expect(await screen.findByRole('heading', { name: 'Fresh' })).toBeTruthy();
  await act(async () => { old.resolve({ data: data('Stale') }); });
  expect(screen.getByRole('heading', { name: 'Fresh' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Stale' })).toBeNull();
});
