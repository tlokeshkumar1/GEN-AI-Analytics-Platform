'use strict';

// Run after AppRouter authentication checks. SAP's own /logout middleware ends
// the session and sends the browser through XSUAA/IdP logout before a new login.
function startSapSignIn(req, res, next) {
  if (req.url !== '/auth/start' || req.method !== 'GET') return next();
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.writeHead(303, { Location: '/logout?relogin=true' });
  res.end();
}

module.exports = { startSapSignIn };
