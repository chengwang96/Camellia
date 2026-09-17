'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compareVersions, createRuntimeUpdates } = require('../src/main/runtime-updates');
const { createRuntimeManager, ENGINES } = require('../src/main/runtime-manager');
const { BAD_PORTS } = require('./bad-ports.cjs');

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A runtime directory the real runtime-manager can locate: entry file plus a
// node_modules package.json carrying the installed version.
function npmRuntime(root, engine, version) {
  const dir = path.join(root, 'runtimes', engine);
  const pkgDir = path.join(dir, 'node_modules', ENGINES[engine].package);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: ENGINES[engine].package, version }));
  const entry = path.join(pkgDir, ENGINES[engine].entry);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  return dir;
}

function pythonRuntime(root, sdk) {
  const dir = path.join(root, 'runtimes', 'antigravity');
  const key = process.platform + '-' + process.arch;
  const platform = { uv: 'uv-binary', python: 'python-binary', url: 'https://example.invalid/uv.whl', sha256: '0'.repeat(64), archive: 'uv.whl' };
  fs.mkdirSync(path.join(dir, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'installer', platform.uv), '');
  fs.mkdirSync(path.join(dir, 'python'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'python', platform.python), '');
  fs.mkdirSync(path.join(dir, 'packages', 'google', 'antigravity'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'google', 'antigravity', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ sdk, python: '3.13.14', platforms: { [key]: platform } }));
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ sdk, python: '3.13.14' }));
  return dir;
}

// Loopback registry serving both the npm "latest" document and the PyPI JSON
// API from path-based routes.
async function registryFixture(t, versions) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/npm/')) {
      const version = versions[decodeURIComponent(req.url.slice(5))];
      if (version === undefined) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version }));
      return;
    }
    if (req.url.startsWith('/pypi/')) {
      const version = versions[decodeURIComponent(req.url.slice(6))];
      if (version === undefined) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ info: { version } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  for (;;) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    if (!BAD_PORTS.has(server.address().port)) break;
    await new Promise(resolve => server.close(resolve));
  }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    npm: pkg => `${base}/npm/${encodeURIComponent(pkg)}`,
    pypi: pkg => `${base}/pypi/${encodeURIComponent(pkg)}`,
  };
}

const direct = () => ({ mode: 'direct', url: '' });

test('compareVersions orders numeric cores and releases before prereleases', () => {
  assert.equal(compareVersions('0.43.1', '0.43.1'), 0);
  assert.equal(compareVersions('0.43.2', '0.43.1'), 1);
  assert.equal(compareVersions('0.43.1', '0.43.2'), -1);
  assert.equal(compareVersions('2.1.273', '2.1.99'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('0.9', '0.9.0'), 0);
});

test('check reports latest versions, update flags, and registry errors per engine', async t => {
  const root = fixtureRoot(t);
  npmRuntime(root, 'claude', '2.1.0');
  npmRuntime(root, 'kimi', '0.43.1');
  const registries = await registryFixture(t, {
    '@anthropic-ai/claude-code': '2.2.0',
    '@moonshot-ai/kimi-code': '0.43.1',
    '@openai/codex': '0.154.0',
    '@deepseek-ai/dsh': '1.2.3',
    'google-antigravity': '0.2.0',
  });
  const manager = createRuntimeManager({ root, installRoot: path.join(root, 'elsewhere') });
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, node: null, npm: null, run: async () => {}, downloadSettings: direct, registries });
  const rows = Object.fromEntries((await updates.check()).map(row => [row.id, row]));
  assert.equal(rows.claude.installed, '2.1.0');
  assert.equal(rows.claude.latest, '2.2.0');
  assert.equal(rows.claude.updateAvailable, true);
  assert.equal(rows.kimi.updateAvailable, false, 'Same version is not an update');
  assert.equal(rows.codex.installed, null, 'Missing engines report no installed version');
  assert.equal(rows.codex.latest, '0.154.0');
  assert.equal(rows.codex.updateAvailable, false, 'Nothing to update before the engine is downloaded');
  assert.equal(rows.antigravity.checkable, true);
  assert.equal(rows.antigravity.latest, '0.2.0');
  assert.equal(rows.antigravity.installed, null);
  assert.equal(rows.dsh.error, null);
});

test('check flags the subscription CLI as app-managed and update refuses it', async t => {
  const manager = {
    state: () => [{ id: 'antigravity', name: 'Antigravity', mode: 'subscription', version: '1.2.3', status: 'ready' }],
    locate: () => ({ file: 'x', dir: 'x', version: '1.2.3', mode: 'subscription' }),
  };
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, node: null, npm: null, run: async () => {}, downloadSettings: direct });
  const [row] = await updates.check();
  assert.equal(row.checkable, false);
  assert.equal(row.updateAvailable, false);
  await assert.rejects(() => updates.update('antigravity'), /ships with the app/);
});

test('npm update installs the latest version in place and asks for a restart', async t => {
  const root = fixtureRoot(t);
  const dir = npmRuntime(root, 'kimi', '0.43.0');
  const registries = await registryFixture(t, { '@moonshot-ai/kimi-code': '0.43.1' });
  const manager = createRuntimeManager({ root, installRoot: path.join(root, 'elsewhere') });
  const calls = [];
  const run = async (exe, args) => {
    calls.push(args);
    const spec = args.find(arg => arg.startsWith('@moonshot-ai/kimi-code@'));
    const version = spec.slice('@moonshot-ai/kimi-code@'.length);
    fs.writeFileSync(path.join(dir, 'node_modules', '@moonshot-ai', 'kimi-code', 'package.json'),
      JSON.stringify({ name: '@moonshot-ai/kimi-code', version }));
  };
  let prompt = null;
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, node: '/node', npm: '/npm-cli.js', run,
    downloadSettings: direct, registries, promptRestart: async (name, from, to) => { prompt = { name, from, to }; return false; } });
  const result = await updates.update('kimi');
  assert.deepEqual({ ...result }, { ok: true, engine: 'kimi', from: '0.43.0', to: '0.43.1', changed: true, restartRequired: true, restarting: false });
  assert.deepEqual(prompt, { name: 'Kimi Code', from: '0.43.0', to: '0.43.1' });
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.ok(args.includes('install') && args.includes('--save-exact'), `npm install args: ${args.join(' ')}`);
  assert.ok(args.includes('@moonshot-ai/kimi-code@0.43.1'));
  assert.ok(args.includes('--omit=optional') && args.includes('--ignore-scripts'), 'Kimi keeps its install flags on update');
  assert.equal(manager.locate('kimi').version, '0.43.1');
});

test('update with no newer version changes nothing and skips the restart prompt', async t => {
  const root = fixtureRoot(t);
  npmRuntime(root, 'claude', '2.1.0');
  const registries = await registryFixture(t, { '@anthropic-ai/claude-code': '2.1.0' });
  const manager = createRuntimeManager({ root, installRoot: path.join(root, 'elsewhere') });
  let prompted = false, ran = false;
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, node: '/node', npm: '/npm-cli.js',
    run: async () => { ran = true; }, downloadSettings: direct, registries, promptRestart: async () => { prompted = true; return false; } });
  const result = await updates.update('claude');
  assert.deepEqual({ ...result }, { ok: true, engine: 'claude', from: '2.1.0', to: '2.1.0', changed: false, restartRequired: false, restarting: false });
  assert.equal(ran, false, 'No installer runs when already up to date');
  assert.equal(prompted, false);
});

test('concurrent updates of one engine share a single task', async t => {
  const root = fixtureRoot(t);
  npmRuntime(root, 'claude', '2.1.0');
  const registries = await registryFixture(t, { '@anthropic-ai/claude-code': '2.2.0' });
  const manager = createRuntimeManager({ root, installRoot: path.join(root, 'elsewhere') });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, node: '/node', npm: '/npm-cli.js',
    run: async () => { await gate; }, downloadSettings: direct, registries });
  const first = updates.update('claude');
  const second = updates.update('claude');
  assert.equal(first, second);
  release();
  await first.catch(() => {});
});

test('antigravity API runtime upgrades its SDK through the bundled installer', async t => {
  const root = fixtureRoot(t);
  const dir = pythonRuntime(root, '0.1.17');
  const registries = await registryFixture(t, { 'google-antigravity': '0.2.0' });
  const manager = createRuntimeManager({ root, installRoot: path.join(root, 'elsewhere') });
  const calls = [];
  const run = async (exe, args) => {
    calls.push({ exe, args });
    if (args[0] === 'pip' && args[1] === 'compile') fs.writeFileSync(args[args.indexOf('--output-file') + 1], '# lock\n');
  };
  let prompt = null;
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, node: null, npm: null, run,
    downloadSettings: direct, registries, promptRestart: async (name, from, to) => { prompt = { name, from, to }; return true; } });
  const result = await updates.update('antigravity');
  assert.deepEqual({ ...result }, { ok: true, engine: 'antigravity', from: '0.1.17', to: '0.2.0', changed: true, restartRequired: true, restarting: true });
  assert.deepEqual(prompt, { name: 'Antigravity', from: '0.1.17', to: '0.2.0' });
  const compile = calls.find(call => call.args[0] === 'pip' && call.args[1] === 'compile');
  assert.ok(compile, 'uv pip compile regenerates the lockfile');
  assert.ok(compile.args.includes('--generate-hashes') && compile.args.includes('--universal'));
  assert.equal(fs.readFileSync(path.join(dir, 'requirements.in'), 'utf8'), 'google-antigravity==0.2.0\n');
  const install = calls.find(call => call.args[0] === 'pip' && call.args[1] === 'install');
  assert.ok(install.args.includes('--require-hashes'), 'Installs stay hash-locked');
  const smoke = calls.find(call => call.args[0] === '-c');
  assert.ok(smoke, 'The upgraded SDK is import-checked');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8')).sdk, '0.2.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8')).sdk, '0.2.0');
  assert.equal(manager.locate('antigravity').version, '0.2.0');
});

test('update rejects engines that are not installed and surfaces registry failures', async t => {
  const root = fixtureRoot(t);
  const registries = await registryFixture(t, {});
  const manager = createRuntimeManager({ root, installRoot: path.join(root, 'elsewhere') });
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, node: '/node', npm: '/npm-cli.js', run: async () => {},
    downloadSettings: direct, registries });
  await assert.rejects(() => updates.update('kimi'), /Download this engine before updating it/);
  const dir = npmRuntime(root, 'claude', '2.1.0');
  void dir;
  const rows = Object.fromEntries((await updates.check()).map(row => [row.id, row]));
  assert.match(rows.claude.error, /Registry request failed|fetch failed/, 'A failing registry reports an error, not a crash');
});
