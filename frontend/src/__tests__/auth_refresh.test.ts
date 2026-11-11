import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAuthSession, clearLocalIdentity, getTokenExpiry } from '../services/authNavigation';
import api, { setAuthToken, clearAuthStorage } from '../services/api';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearAuthStorage();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Silent token refresh and session continuity', () => {
  it('deduplicates concurrent refreshAuthSession calls and stores refreshed token + expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          token: 'fresh-jwt-token',
          expires_in: 900,
          user: { user_id: 'u1', email: 'u1@example.com', name: 'User One', roles: ['Admin'] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const [r1, r2] = await Promise.all([refreshAuthSession(), refreshAuthSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1?.token).toBe('fresh-jwt-token');
    expect(r2?.token).toBe('fresh-jwt-token');
    expect(localStorage.getItem('auth_token')).toBe('fresh-jwt-token');
    expect(getTokenExpiry()).toBeGreaterThan(Date.now());
  });

  it('silently refreshes on 401 and replays the original Axios request without logging out', async () => {
    setAuthToken('expired-jwt-token', 900);
    const sessionExpiredSpy = vi.fn();
    window.addEventListener('session-expired', sessionExpiredSpy);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          token: 'refreshed-jwt-token',
          expires_in: 900,
          user: { user_id: 'u1', email: 'u1@example.com', name: 'User One', roles: ['Admin'] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapterSpy = vi
      .fn()
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 401,
          headers: {},
          data: { detail: 'Invalid or expired SAP XSUAA token. Sign in again.' },
        },
        config: { url: '/datasets', method: 'get', headers: {} },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: [{ id: 'ds-1' }],
        config: {},
      });

    api.defaults.adapter = adapterSpy as any;
    const res = await api.get('/datasets');

    expect(res.data).toEqual([{ id: 'ds-1' }]);
    expect(adapterSpy).toHaveBeenCalledTimes(2);
    expect(sessionExpiredSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem('auth_token')).toBe('refreshed-jwt-token');

    window.removeEventListener('session-expired', sessionExpiredSpy);
    clearLocalIdentity(false);
  });
});

