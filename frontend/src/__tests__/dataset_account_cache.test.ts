import { beforeEach, expect, it, vi } from 'vitest';
import api from '../services/api';
import { getDatasets, invalidateDatasetsCache } from '../services/datasetService';

vi.mock('../services/api', () => ({ default: { get: vi.fn() } }));
vi.mock('../services/authService', () => ({ hasAdminRole: () => false }));

function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('auth_user', JSON.stringify({ user_id: 'alice' }));
  invalidateDatasetsCache();
});

it('shares a dataset request only within the same account', async () => {
  const alice = deferred(); const bob = deferred();
  vi.mocked(api.get).mockReturnValueOnce(alice.promise).mockReturnValueOnce(bob.promise);
  const first = getDatasets(); const sameUser = getDatasets();
  expect(api.get).toHaveBeenCalledTimes(1);
  localStorage.setItem('auth_user', JSON.stringify({ user_id: 'bob' }));
  const otherUser = getDatasets();
  expect(api.get).toHaveBeenCalledTimes(2);
  bob.resolve({ data: [{ id: 'bob-data' }] });
  expect((await otherUser)[0].id).toBe('bob-data');
  alice.resolve({ data: [{ id: 'alice-data' }] });
  expect((await first)[0].id).toBe('alice-data');
  expect((await sameUser)[0].id).toBe('alice-data');
});

it('invalidating after a mutation does not reuse the earlier pending list', async () => {
  const old = deferred();
  vi.mocked(api.get).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ data: [{ id: 'new' }] });
  const first = getDatasets();
  invalidateDatasetsCache();
  expect((await getDatasets())[0].id).toBe('new');
  old.resolve({ data: [{ id: 'old' }] });
  await first;
  expect(api.get).toHaveBeenCalledTimes(2);
});
