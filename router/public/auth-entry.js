'use strict';

(() => {
  const marker = 'neovatic_signed_out';
  const page = document.body.dataset.authPage;
  const relogin = page === 'logged-out' && new URLSearchParams(window.location.search).get('relogin') === 'true';
  const clearLocalIdentity = () => {
    try {
      for (const key of ['auth_token', 'auth_user', 'sap_ias_sso_token']) localStorage.removeItem(key);
      if (relogin) localStorage.removeItem(marker);
      else if (page === 'logged-out') localStorage.setItem(marker, 'true');
    } catch { /* SAP router cookies remain the source of authentication. */ }
  };
  clearLocalIdentity();
  document.getElementById('sap-sign-in')?.addEventListener('click', () => {
    try { localStorage.removeItem(marker); } catch {}
  });
  if (relogin) {
    document.getElementById('auth-message').textContent = 'Opening SAP sign-in...';
    document.getElementById('sap-sign-in').href = '/app';
    window.location.replace('/app');
  }
  // Returning to a public page with Back must not re-run its old relogin redirect.
  if (relogin) window.history.replaceState(null, '', '/logged-out.html');
})();
