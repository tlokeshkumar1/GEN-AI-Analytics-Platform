// Build deployment assets without replacing dependencies used by a running Vite server.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const frontend = fs.realpathSync(path.resolve(__dirname, '../frontend'));
const temporaryRoot = fs.realpathSync(os.tmpdir());
const work = fs.mkdtempSync(path.join(temporaryRoot, 'genai-ui-mta-'));
const output = path.join(frontend, '.mta-dist');
const excluded = new Set(['node_modules', 'dist', '.mta-dist', '.git', '.vite']);

function npm(args) {
  // Arguments are fixed below; cwd is passed separately, including on Windows.
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'cmd.exe' : 'npm', windows
    ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args,
  { cwd: work, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Frontend MTA ${args[0]} failed (exit ${result.status}).`);
}

try {
  console.log(`Building frontend in isolated workspace: ${work}`);
  fs.cpSync(frontend, work, {
    recursive: true,
    filter: source => !excluded.has(path.relative(frontend, source).split(path.sep)[0]),
  });
  npm(['ci', '--include=dev', '--no-audit', '--no-fund']);
  npm(['run', 'build']);
  const assets = path.join(work, 'dist');
  if (!fs.existsSync(path.join(assets, 'index.html'))) throw new Error('Frontend build produced no index.html.');

  // Only the dedicated deployment output may be replaced, never frontend/node_modules.
  if (path.dirname(path.resolve(output)) !== frontend || path.basename(output) !== '.mta-dist') {
    throw new Error('Invalid frontend deployment output path.');
  }
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw new Error('Frontend deployment output must not be a symbolic link.');
  }
  fs.rmSync(output, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  fs.cpSync(assets, output, { recursive: true });
  console.log(`Deployment assets ready: ${output}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // Verify the exact mkdtemp directory before recursively removing temporary files.
  if (path.dirname(path.resolve(work)) !== temporaryRoot || !path.basename(work).startsWith('genai-ui-mta-')) {
    throw new Error('Invalid temporary build workspace path.');
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
