'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { createRuntimeManager, ENGINES } = require('../src/main/runtime-manager');
const { createLocalRuntimeDiscovery } = require('../src/main/local-runtimes');
const { validateRuntimePath } = require('../src/main/custom-runtimes');
const { subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { createGoogleAccount } = require('../src/engines/antigravity/subscription');

const help = 'Usage of agy:\n --input-format stream-json\n --output-format stream-json\n models List available models\n';
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-agy-path-'));
  t.after(() => removeTree(root));
  let paths = {};
  const manager = createRuntimeManager({ root, installRoot: root, node: process.execPath, discoverLocal: false,
    customPaths: () => paths, saveCustomPaths: value => { paths = value; },
    probe: async (_exe, args, config) => {
      assert.equal(config.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
      return args[0] === '--help' ? { stderr: help } : { stdout: '1.2.14\n' };
    }, ...options });
  function put(relative, content = 'MZfixture') {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'object' ? JSON.stringify(content) : content, { mode: 0o755 });
    return file;
  }
  return { root, manager, put, paths: () => paths };
}

test('a copied quoted CLI path is normalized and its help can be on stderr', async t => {
  const f = fixture(t), cli = f.put('tools with spaces/agy.exe');
  await f.manager.setPath('antigravity', ` "${cli}" `, 'subscription');
  assert.equal(f.paths().antigravity.file, cli);
  const runtime = await f.manager.ensure('antigravity', 'subscription');
  const spec = subscriptionSpawnSpec({ runtime, home: f.root, env: {} });
  assert.equal(JSON.parse(spec.env.CAMELLIA_ANTIGRAVITY_CLI).exe, cli);
  assert.equal(spec.env.PYTHONPATH, undefined);
});

test('Python and IDE version numbers cannot validate an Antigravity CLI or replace a saved path', async t => {
  const f = fixture(t, { probe: async (exe, args) => args[0] === '--version'
    ? { stdout: path.basename(exe).startsWith('python') ? 'Python 3.12.4' : '1.2.14' }
    : { stdout: path.basename(exe).startsWith('agy') ? help : 'Usage: application [options]' } });
  const cli = f.put('agy.exe');
  await f.manager.setPath('antigravity', cli, 'subscription');
  for (const file of [f.put('python.exe'), f.put('Antigravity.exe')]) {
    await assert.rejects(f.manager.setPath('antigravity', file, 'subscription'), /Choose the Antigravity CLI/);
    assert.equal(f.paths().antigravity.file, cli);
  }
});

test('a real unrelated executable with a valid version is rejected', async () => {
  await assert.rejects(validateRuntimePath({ engine: 'antigravity', mode: 'subscription', file: process.execPath }),
    /Choose the Antigravity CLI/);
});

test('an invalid CLI path saved by an older release becomes a readable error without breaking account settings', t => {
  const f = fixture(t, { customPaths: () => ({ antigravity: { file: process.execPath, version: '1.2.14' } }) });
  const row = f.manager.state().find(item => item.id === 'antigravity');
  assert.equal(row.subscriptionRuntime.status, 'error');
  assert.match(row.subscriptionRuntime.message, /Choose the Antigravity CLI/);
  assert.throws(() => f.manager.ensure('antigravity', 'subscription'), /Choose the Antigravity CLI/);
  const account = createGoogleAccount({ home: f.root, runtime: () => f.manager,
    environment: () => ({}), settings: () => ({}), cliSettingsFile: path.join(f.root, 'cli.json') });
  assert.equal(account.state().installed, false);
  assert.match(account.state().error, /Choose the Antigravity CLI/);
});

test('changing a previously validated executable invalidates the CLI readiness cache', async t => {
  const f = fixture(t), cli = f.put('agy.exe');
  await f.manager.setPath('antigravity', cli, 'subscription');
  fs.writeFileSync(cli, 'MZthis executable has changed');
  const row = f.manager.state().find(item => item.id === 'antigravity');
  assert.equal(row.subscriptionRuntime.status, 'error');
  assert.equal(fs.readFileSync(cli, 'utf8'), 'MZthis executable has changed');
});

test('API runtime status reports the subscription executable independently and preserves the connection', async t => {
  const f = fixture(t), python = f.put('conda/python.exe'), cli = f.put('tools/agy.exe');
  f.put('runtimes/antigravity/runtime.json', { sdk: '0.1.20', python: '3.13.14', platforms: {
    [process.platform + '-' + process.arch]: { python: 'python.exe' } } });
  f.put('runtimes/antigravity/installed.json', { sdk: '0.1.20', python: 'shared', sharedPython: python, sharedPythonVersion: '3.12.4' });
  f.put('runtimes/antigravity/packages/google/antigravity/__init__.py', '');
  assert.equal(f.manager.state().find(row => row.id === 'antigravity').subscriptionRuntime.status, 'missing');
  await f.manager.setPath('antigravity', cli, 'subscription');
  const row = f.manager.state().find(row => row.id === 'antigravity');
  assert.equal(row.mode, 'api');
  assert.equal(row.file, python);
  assert.equal(row.subscriptionRuntime.mode, 'subscription');
  assert.equal(row.subscriptionRuntime.status, 'ready');
  assert.equal(row.subscriptionRuntime.file, cli);
  assert.equal((await f.manager.ensure('antigravity', 'subscription')).file, cli);
  assert.equal((await f.manager.ensure('antigravity')).file, python);
  const plan = f.manager.reinstallPlan('antigravity', 'subscription');
  assert.equal(plan.file, cli);
  assert.equal(plan.mode, 'subscription');
  await f.manager.setPath('antigravity', '', 'subscription');
  const reset = f.manager.state().find(row => row.id === 'antigravity');
  assert.equal(reset.subscriptionRuntime.status, 'missing');
  assert.equal(reset.file, python);
});

test('Windows discovers the official installer and WinGet links even with an old PATH', t => {
  for (const directory of ['agy/bin', 'Microsoft/WinGet/Links',
    'Packages/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe/LocalState/links']) {
    const f = fixture(t), cli = f.put(`local/${directory}/agy.exe`), calls = [];
    const locate = createLocalRuntimeDiscovery({ engines: ENGINES, platform: 'win32', home: f.root,
      env: { PATH: '', LOCALAPPDATA: path.join(f.root, 'local'), ProgramFiles: path.join(f.root, 'programs') },
      probe: (exe, args, options) => {
        calls.push({ exe, args });
        assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
        return args[0] === '--help' ? help : '1.2.14\n';
      } });
    assert.equal(locate('antigravity', 'subscription').file, fs.realpathSync(cli));
    assert.equal(locate('antigravity', 'api'), null);
    locate('antigravity', 'subscription');
    assert.equal(calls.length, 2, 'CLI probes are cached');
  }
});

test('automatic discovery skips an unrelated native executable and continues to the official CLI', t => {
  const f = fixture(t), bad = f.put('path/agy.exe'), good = f.put('local/agy/bin/agy.exe');
  const locate = createLocalRuntimeDiscovery({ engines: ENGINES, platform: 'win32', home: f.root,
    env: { PATH: path.dirname(bad), LOCALAPPDATA: path.join(f.root, 'local') },
    probe: (exe, args) => args[0] === '--version' ? '3.12.4' : exe === fs.realpathSync(bad) ? 'Usage: python' : help });
  assert.equal(locate('antigravity', 'subscription').file, fs.realpathSync(good));
});

test('a failed help probe cannot leave a detected CLI marked ready', t => {
  const f = fixture(t), cli = f.put('local/agy/bin/agy.exe');
  const locate = createLocalRuntimeDiscovery({ engines: ENGINES, platform: 'win32', home: f.root,
    env: { PATH: '', LOCALAPPDATA: path.join(f.root, 'local') },
    probe: (_exe, args) => { if (args[0] === '--help') throw new Error('probe failed'); return '1.2.14'; } });
  assert.equal(locate('antigravity', 'subscription'), null);
  assert.equal(fs.existsSync(cli), true);
});
