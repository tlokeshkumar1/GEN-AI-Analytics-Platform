export const SIGNED_OUT_KEY = 'neovatic_signed_out';

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
  for (const key of ['auth_token', 'auth_user', 'sap_ias_sso_token']) localStorage.removeItem(key);
  if (signedOut) localStorage.setItem(SIGNED_OUT_KEY, 'true');
  else localStorage.removeItem(SIGNED_OUT_KEY);
}

export function sapSignInTarget(): string {
  const target = sapRouterRoute('/auth/start');
  if (!target) throw new Error('SAP sign-in needs the application router. Open your Cloud Foundry AppRouter URL, or set VITE_SAP_APP_ROUTER_URL in frontend/.env and restart Vite.');
  return target;
}
