const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startSapSignIn } = require('../auth-navigation');

test('patched SAP App Router retains the startup and middleware APIs', () => {
  const ar = require('@sap/approuter')();
  assert.equal(typeof ar.start, 'function');
  assert.equal(typeof ar.beforeRequestHandler.use, 'function');
});

test('routing configuration validates against the installed SAP schema', () => {
  const directory = path.resolve(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'xs-app.json'), 'utf8'));
  const validators = require('@sap/approuter/lib/configuration/validators');
  validators.validateXsApp(config, { 'backend-api': { url: 'https://backend.example.test' } }, directory);
  const api = config.routes.find(route => route.destination === 'backend-api');
  assert.equal(api.authenticationType, 'xsuaa');
  assert.equal(api.csrfProtection, true);
  assert.deepEqual(api.scope, ['$XSAPPNAME.Member', '$XSAPPNAME.Admin']);
  assert.equal(config.logout.logoutEndpoint, '/logout');
});

test('sign-in navigation preserves SAP logout and does not create a local session', () => {
  let status, headers, ended = false;
  const response = {
    setHeader(name, value) { assert.equal(name, 'Cache-Control'); assert.match(value, /no-store/); },
    writeHead(code, values) { status = code; headers = values; },
    end() { ended = true; },
  };
  startSapSignIn({ url: '/auth/start', method: 'GET' }, response, () => assert.fail('unexpected next'));
  assert.equal(status, 303);
  assert.equal(headers.Location, '/logout?relogin=true');
  assert.equal(ended, true);
  let passed = false;
  startSapSignIn({ url: '/api/datasets', method: 'GET' }, {}, () => { passed = true; });
  assert.equal(passed, true);
});
