const fs = require('node:fs');
const path = require('node:path');

// BAS/local startup runs with router as cwd; its bindings live at project root.
// Deployed services always use Cloud Foundry's injected environment.
if (!process.env.VCAP_APPLICATION) {
  const localBindings = path.resolve(__dirname, '../default-env.json');
  if (fs.existsSync(localBindings)) {
    const bindings = JSON.parse(fs.readFileSync(localBindings, 'utf8').replace(/^\uFEFF/, ''));
    for (const key of ['VCAP_SERVICES', 'destinations']) {
      if (!process.env[key] && bindings[key]) {
        process.env[key] = typeof bindings[key] === 'string' ? bindings[key] : JSON.stringify(bindings[key]);
      }
    }
  }
}

const approuter = require('@sap/approuter');

const ar = approuter();
const { startSapSignIn } = require('./auth-navigation');

ar.beforeRequestHandler.use(startSapSignIn);

ar.start({
  port: process.env.PORT || 5000
});
