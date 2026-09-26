'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const os = require('node:os');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { locatePythonRuntime, pythonEnvironment } = require('../src/main/python-runtime');
const { antigravitySpawnSpec } = require('../src/engines/antigravity');

// A source tree plus a fake uv so installPythonRuntime can run without network.
function fixture(context, { sharedPython } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-py-install-'));
  context.after(() => removeTree(root));
  const source = path.join(root, 'runtimes/antigravity');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'runtime.json'), JSON.stringify({ sdk: 'fixture', python: '3.13.14', platforms: {
    [process.platform + '-' + process.arch]: { uv: 'uv', python: 'python', archive: 'uv.whl',
      url: 'https://registry.invalid/uv.whl', sha256: '0'.repeat(64) },
  } }));
  fs.writeFileSync(path.join(source, 'requirements.lock'), 'fixture');
  // Camellia ships uv as its installer tool; pre-place it so the install path
  // never reaches the network in tests.
  const installer = path.join(source, 'installer');
  fs.mkdirSync(installer, { recursive: true });
  fs.writeFileSync(path.join(installer, 'uv'), '', { mode: 0o755 });
  const config = path.join(root, 'paths.json');
  const commands = [];
  const customPaths = sharedPython ? { python: sharedPython } : {};
  const manager = createRuntimeManager({ root, installRoot: root, discoverLocal: false,
    customPaths: () => customPaths,
    saveCustomPaths: value => { Object.assign(customPaths, value); fs.writeFileSync(config, JSON.stringify(value)); },
    runCommand: async (exe, args, options) => {
      commands.push({ exe, args, options });
      const dir = path.join(root, 'runtimes/antigravity');
      if (exe === 'tar') fs.writeFileSync(path.join(dir, 'installer/uv'), '');
      else if (args[0] === 'python') { fs.mkdirSync(path.join(dir, 'python'), { recursive: true }); fs.writeFileSync(path.join(dir, 'python/python'), ''); }
      else if (args[0] === 'pip') { fs.mkdirSync(path.join(dir, 'packages/google/antigravity'), { recursive: true }); fs.writeFileSync(path.join(dir, 'packages/google/antigravity/__init__.py'), ''); }
    },
    downloadOptions: () => ({ mode: 'direct', url: '' }) });
  return { root, config, commands, manager, customPaths };
}

function sharedPythonFile(context, version = '3.13.4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-shared-py-'));
  context.after(() => removeTree(root));
  const file = path.join(root, process.platform === 'win32' ? 'python.exe' : 'python3');
  fs.writeFileSync(file, '', { mode: 0o755 });
  return { file, version };
}

test('installing Antigravity reuses the configured Python instead of downloading another one', async context => {
  const shared = sharedPythonFile(context);
  const setup = fixture(context, { sharedPython: { ...shared, antigravitySdk: false } });
  const runtime = await setup.manager.ensure('antigravity');
  assert.equal(runtime.version, 'fixture');
  // No bundled CPython is prepared, and pip targets the shared interpreter.
  assert.equal(setup.commands.filter(command => command.args[0] === 'python').length, 0);
  const pip = setup.commands.find(command => command.args[0] === 'pip' && command.args.includes('--python'));
  assert.equal(pip.args[pip.args.indexOf('--python') + 1], shared.file, 'the SDK installs for the shared interpreter');
  // The manifest pins the shared interpreter so later launches keep using it.
  const installed = JSON.parse(fs.readFileSync(path.join(setup.root, 'runtimes/antigravity/installed.json'), 'utf8'));
  assert.equal(installed.python, 'shared');
  assert.equal(installed.sharedPython, shared.file);
  assert.equal(setup.manager.locate('antigravity', 'api').file, shared.file);
  assert.equal(setup.manager.locate('antigravity', 'api').sharedPython.file, shared.file);
});

test('shared SDK installation is discoverable in a fresh caller without a Python override', async context => {
  const shared = sharedPythonFile(context);
  const setup = fixture(context, { sharedPython: { ...shared, antigravitySdk: true } });
  await setup.manager.ensure('antigravity');
  const dir = path.join(setup.root, 'runtimes/antigravity');
  const runtime = locatePythonRuntime(dir);
  assert.equal(runtime.file, shared.file);
  assert.equal(runtime.sharedPython.version, shared.version);
  const environment = pythonEnvironment(dir, { Path: 'system', PYTHONPATH: 'unrelated', PYTHONHOME: 'unrelated' });
  assert.equal(environment.PATH, path.dirname(shared.file) + path.delimiter + 'system');
  assert.equal(environment.PYTHONPATH, path.join(dir, 'packages'));
  assert.equal(environment.PYTHONHOME, undefined);
  const spec = antigravitySpawnSpec({ runtime, home: setup.root, route: { baseUrl: 'http://localhost' },
    python: { ...shared, antigravitySdk: true }, env: { PATH: 'system' } });
  assert.equal(spec.env.PYTHONPATH, path.join(dir, 'packages'));
  const verification = setup.commands.find(command => command.exe === shared.file);
  assert.equal(verification.options.env.PYTHONPATH, path.join(dir, 'packages'));
  const marker = path.join(dir, 'installed.json');
  const installed = JSON.parse(fs.readFileSync(marker));
  delete installed.sharedPythonVersion;
  fs.writeFileSync(marker, JSON.stringify(installed));
  assert.equal(locatePythonRuntime(dir).file, shared.file, 'old shared manifests remain usable');
});

test('changing the shared interpreter does not reuse incompatible installed packages', async context => {
  const shared = sharedPythonFile(context), replacement = sharedPythonFile(context, '3.12.1');
  const setup = fixture(context, { sharedPython: shared });
  await setup.manager.ensure('antigravity');
  const dir = path.join(setup.root, 'runtimes/antigravity');
  assert.equal(locatePythonRuntime(dir, replacement), null);
  const { upgradePythonRuntime } = require('../src/main/python-runtime');
  await assert.rejects(upgradePythonRuntime({ dir, sdk: '0.2.0', python: replacement,
    connection: { env: {} }, run: async () => assert.fail('Mismatched Python must not install packages') }), /shared Python changed or is missing/);
  fs.unlinkSync(shared.file);
  assert.equal(locatePythonRuntime(dir), null);
  assert.equal(locatePythonRuntime(dir, replacement), null);
  await assert.rejects(upgradePythonRuntime({ dir, sdk: '0.2.0', connection: { env: {} },
    run: async () => assert.fail('Missing Python must not install packages') }), /shared Python changed or is missing/);
});

test('a shared Python too old for the SDK falls back to the bundled interpreter', async context => {
  const shared = sharedPythonFile(context, '3.9.18');
  const setup = fixture(context, { sharedPython: { ...shared, antigravitySdk: false } });
  assert.equal((await setup.manager.ensure('antigravity')).version, 'fixture');
  assert.equal(setup.commands.filter(command => command.args[0] === 'python').length, 1, 'a CPython is downloaded');
  const pip = setup.commands.find(command => command.args[0] === 'pip');
  assert.ok(pip.args[pip.args.indexOf('--python') + 1].endsWith('python'), 'pip uses the bundled interpreter');
  assert.notEqual(pip.args[pip.args.indexOf('--python') + 1], shared.file);
  const installed = JSON.parse(fs.readFileSync(path.join(setup.root, 'runtimes/antigravity/installed.json'), 'utf8'));
  assert.equal(installed.python, '3.13.14');
});

test('without a shared Python the bundled interpreter is still used', async context => {
  const setup = fixture(context);
  await setup.manager.ensure('antigravity');
  assert.equal(setup.commands.filter(command => command.args[0] === 'python').length, 1);
  const installed = JSON.parse(fs.readFileSync(path.join(setup.root, 'runtimes/antigravity/installed.json'), 'utf8'));
  assert.equal(installed.python, '3.13.14');
  assert.equal(installed.sharedPython, undefined);
});

test('a removed shared interpreter invalidates the installation instead of silently drifting', async context => {
  const shared = sharedPythonFile(context);
  const setup = fixture(context, { sharedPython: { ...shared, antigravitySdk: false } });
  await setup.manager.ensure('antigravity');
  assert.ok(setup.manager.locate('antigravity', 'api'));
  fs.unlinkSync(shared.file);
  assert.equal(setup.manager.locate('antigravity', 'api'), null, 'a missing interpreter must not report Ready');
});

test('the Antigravity SDK upgrade keeps using the recorded shared interpreter', async context => {
  const shared = sharedPythonFile(context);
  const setup = fixture(context, { sharedPython: { ...shared, antigravitySdk: false } });
  await setup.manager.ensure('antigravity');
  setup.commands.length = 0;
  const { upgradePythonRuntime } = require('../src/main/python-runtime');
  const dir = path.join(setup.root, 'runtimes/antigravity');
  await upgradePythonRuntime({ dir, run: async (exe, args, options) => { setup.commands.push({ exe, args, options });
      if (args[0] === 'pip') { fs.mkdirSync(path.join(dir, 'packages/google/antigravity'), { recursive: true }); fs.writeFileSync(path.join(dir, 'packages/google/antigravity/__init__.py'), ''); } },
    connection: { env: {} }, sdk: '0.2.0' });
  // uv first resolves the lockfile, then installs; only the install targets an interpreter.
  const pip = setup.commands.find(command => command.args[0] === 'pip' && command.args[1] === 'install');
  assert.ok(pip, 'the SDK is installed with uv pip install');
  assert.equal(pip.args[pip.args.indexOf('--python') + 1], shared.file);
  const installed = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
  assert.equal(installed.python, 'shared');
  assert.equal(installed.sdk, '0.2.0');
});
