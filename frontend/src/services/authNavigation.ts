export const SIGNED_OUT_KEY = 'neovatic_signed_out';
export const TOKEN_EXPIRY_KEY = 'auth_token_expires_at';

interface RouterOptions { configuredUrl?: string; isDevelopment?: boolean; }

export function sapRouterRoute(path: '/auth/start' | '/logout', options: RouterOptions = {}): string | null {
  const configuredUrl = options.configuredUrl ?? import.meta.env.VITE_SAP_APP_ROUTER_URL ?? '';
  const isDevelopment = options.isDevelopment ?? import.meta.env.DEV;
  if (configuredUrl) {
    let url: URL;
    try { url = new URL(configuredUrl); }
    catch { throw new Error('VITE_SAP_APP_ROUTER_URL must be the SAP AppRouter origin, such as https://your-router.cfapps.region.hana.ondemand.com.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('VITE_SAP_APP_ROUTER_URL must be an HTTP or HTTPS AppRouter URL without credentials or query parameters.');
    }
    return url.origin + path;
  }
  return isDevelopment ? null : path;
}

export function clearLocalIdentity(signedOut: boolean): void {
  for (const key of ['auth_token', 'auth_user', 'sap_ias_sso_token', TOKEN_EXPIRY_KEY]) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
  if (signedOut) localStorage.setItem(SIGNED_OUT_KEY, 'true');
  else localStorage.removeItem(SIGNED_OUT_KEY);
}

export function storeTokenExpiry(expiresInSeconds?: number | null): void {
  if (typeof window === 'undefined') return;
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    const expiresAt = String(Date.now() + expiresInSeconds * 1000);
    sessionStorage.setItem(TOKEN_EXPIRY_KEY, expiresAt);
    localStorage.setItem(TOKEN_EXPIRY_KEY, expiresAt);
  } else {
    sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  }
}

export function getTokenExpiry(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem(TOKEN_EXPIRY_KEY) || localStorage.getItem(TOKEN_EXPIRY_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface RefreshSessionResult {
  token: string;
  expires_in?: number;
  user?: {
    user_id: string;
    email: string;
    name: string;
    roles: string[];
    role?: string;
  };
}

let inFlightRefresh: Promise<RefreshSessionResult | null> | null = null;

export async function refreshAuthSession(csrfToken?: string | null): Promise<RefreshSessionResult | null> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async (): Promise<RefreshSessionResult | null> => {
    const postRefresh = (tokenHeader?: string | null) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenHeader) headers['x-csrf-token'] = tokenHeader;
      return fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({}),
      });
    };

    try {
      let res = await postRefresh(csrfToken);
      if (res.status === 403 && res.headers.get('x-csrf-token') === 'Required') {
        const probe = await fetch('/api/health', {
          headers: { 'x-csrf-token': 'Fetch' },
          credentials: 'same-origin',
        });
        const freshCsrf = probe.headers.get('x-csrf-token');
        if (freshCsrf && freshCsrf !== 'Required') {
          res = await postRefresh(freshCsrf);
        }
      }
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.token) return null;
      sessionStorage.setItem('auth_token', data.token);
      localStorage.setItem('auth_token', data.token);
      storeTokenExpiry(data.expires_in);
      if (data.user) {
        localStorage.setItem('auth_user', JSON.stringify(data.user));
      }
      window.dispatchEvent(new CustomEvent('auth-token-refreshed', { detail: data }));
      return data as RefreshSessionResult;
    } catch {
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

export function sapSignInTarget(): string {
  const target = sapRouterRoute('/auth/start');
  if (!target) throw new Error('SAP sign-in needs the application router. Open your Cloud Foundry AppRouter URL, or set VITE_SAP_APP_ROUTER_URL in frontend/.env and restart Vite.');
  return target;
}
