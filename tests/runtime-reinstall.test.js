'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createRuntimeManager, ENGINES, run } = require('../src/main/runtime-manager');
const { createRuntimeUpdates } = require('../src/main/runtime-updates');
const { runtimeRemovalPlan, removeRuntime } = require('../src/main/runtime-removal');
const { npmCandidates } = require('../src/main/runtime-paths');
const { createHarness } = require('./claude-harness.cjs');
const { readJson, writeJson } = require('../src/shared/json-store');
const { removeTree } = require('./test-fs.cjs');
const { BAD_PORTS } = require('./bad-ports.cjs');

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function npmTree(dir, engine, version, modules = path.join(dir, 'node_modules')) {
  const pkg = path.join(modules, ENGINES[engine].package);
  let file;
  if (engine === 'codex') {
    const cpu = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    const suffix = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-musl' }[process.platform];
    const companion = path.join(modules, '@openai', `codex-${process.platform}-${process.arch}`);
    put(path.join(companion, 'package.json'), { name: `@openai/codex-${process.platform}-${process.arch}`, version });
    file = put(path.join(companion, 'vendor', `${cpu}-${suffix}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'), 'binary fixture');
  } else file = put(path.join(pkg, ENGINES[engine].entry), `console.log('${engine} ${version}');\n`);
  fs.chmodSync(file, 0o755);
  put(path.join(pkg, 'package.json'), { name: ENGINES[engine].package, version, bin: { [engine]: ENGINES[engine].entry || 'bin/codex.js' } });
  return file;
}

function fixture(t, { automatic = false, engine = 'kimi', ...extra } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reinstall-'));
  t.after(() => removeTree(root));
  const distribution = path.join(root, 'distribution'), managed = path.join(root, 'managed');
  const prefix = path.join(root, 'npm-cache', '_npx', 'cached-cli');
  const original = npmTree(prefix, engine, '1.0.0');
  put(path.join(prefix, 'package.json'), { name: 'external-cli', version: '1.0.0', dependencies: { [ENGINES[engine].package]: '1.0.0', unrelated: '9.0.0' } });
  const unrelated = put(path.join(prefix, 'node_modules', 'unrelated', 'package.json'), { name: 'unrelated', version: '9.0.0' });
  put(path.join(distribution, 'runtimes', engine, 'package.json'), {});
  put(path.join(distribution, 'runtimes', engine, 'package-lock.json'), {});
  const config = path.join(root, 'paths.json'), calls = [];
  if (!automatic) writeJson(config, { [engine]: { file: original, version: '1.0.0' }, python: { file: 'preserved-python' } });
  const settings = { root: distribution, installRoot: managed, node: process.execPath, npm: 'fixture-npm',
    env: { ...process.env, npm_config_prefix: prefix, npm_config_cache: path.join(root, 'npm-cache'), npm_config_offline: 'true' }, home: root,
    discoverLocal: automatic, customPaths: () => readJson(config, {}), saveCustomPaths: paths => writeJson(config, paths),
    downloadOptions: () => ({ mode: 'direct' }),
    runCommand: async (exe, args) => {
      calls.push(args);
      if (args[1] === 'ci') npmTree(args[args.indexOf('--prefix') + 1], engine, '2.0.0');
      else if (args[1] === 'uninstall') fs.rmSync(path.join(prefix, 'node_modules', ENGINES[engine].package), { recursive: true, force: true });
    }, ...extra };
  const manager = createRuntimeManager(settings);
  return { root, distribution, managed, prefix, original, unrelated, config, calls, settings, manager, engine };
}

test('reinstall removes an npx package with real npm, clears its override and persists the managed selection', async t => {
  const npm = npmCandidates(process.execPath).find(file => fs.existsSync(file));
  assert.ok(npm, 'The Node installation includes npm');
  const f = fixture(t, { npm });
  const baseRun = f.settings.runCommand;
  f.settings.runCommand = async (exe, args, options) => {
    if (args[1] === 'ci') return baseRun(exe, args, options);
    f.calls.push(args);
    assert.equal(fs.existsSync(f.original), true, 'The old entry is kept until the new tree is prepared');
    const prefix = args[args.indexOf('--prefix') + 1];
    assert.equal(prefix, fs.realpathSync.native(f.prefix));
    assert.ok(!args.includes('--global'), 'npx is a local npm project');
    await run(exe, args, { ...options, env: { ...options.env, npm_config_offline: 'true' } });
  };
  const manager = createRuntimeManager(f.settings);
  const planned = manager.reinstallPlan('kimi');
  assert.equal(planned.removal.kind, 'npm');
  const ready = await manager.reinstall('kimi', planned);
  assert.equal(ready.source, 'Installed by Camellia');
  assert.equal(ready.version, '2.0.0');
  assert.ok(!ready.external);
  assert.equal(fs.existsSync(f.original), false);
  assert.equal(fs.existsSync(f.unrelated), true, 'Other packages sharing the prefix are retained');
  assert.equal(readJson(f.config).kimi, undefined);
  assert.equal(readJson(f.config).python.file, 'preserved-python');
  assert.equal(readJson(path.join(f.prefix, 'package.json')).dependencies[ENGINES.kimi.package], undefined);
  const reopened = createRuntimeManager(f.settings);
  assert.equal(reopened.locate('kimi').file, ready.file);
  assert.equal((await reopened.ensure('kimi')).file, ready.file);
  assert.equal(f.calls.length, 2, 'Reusing the managed CLI starts no further install');
  assert.deepEqual(fs.readdirSync(path.join(f.managed, 'runtimes')), ['kimi']);
});

test('automatically discovered npm CLIs also migrate without a custom override', async t => {
  const f = fixture(t, { automatic: true });
  assert.equal(f.manager.locate('kimi').file, f.original);
  assert.equal(f.manager.locate('kimi').external, true);
  const ready = await f.manager.reinstall('kimi');
  assert.equal(ready.source, 'Installed by Camellia');
  assert.equal(fs.existsSync(f.original), false);
  assert.equal(fs.existsSync(f.unrelated), true);
});

test('future version checks and updates install into the migrated managed prefix', async t => {
  const f = fixture(t);
  const registry = http.createServer((_req, response) => {
    response.setHeader('content-type', 'application/json'); response.end('{"version":"2.1.0"}');
  });
  for (;;) {
    await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
    if (!BAD_PORTS.has(registry.address().port)) break;
    await new Promise(resolve => registry.close(resolve));
  }
  t.after(async () => { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)); });
  await f.manager.reinstall('kimi');
  const updates = createRuntimeUpdates({ manager: f.manager, engines: ENGINES, node: process.execPath, npm: 'npm-cli',
    downloadSettings: () => ({ mode: 'direct' }), registries: { npm: () => `http://127.0.0.1:${registry.address().port}` },
    run: async (_exe, args) => {
      const prefix = args[args.indexOf('--prefix') + 1];
      assert.equal(prefix, fs.realpathSync.native(path.join(f.managed, 'runtimes', 'kimi')));
      assert.ok(args.includes('@moonshot-ai/kimi-code@2.1.0'));
      npmTree(prefix, 'kimi', '2.1.0');
    } });
  const row = (await updates.check()).find(row => row.id === 'kimi');
  assert.equal(row.checkable, true);
  assert.equal(row.external, false);
  assert.equal(row.updateAvailable, true);
  const result = await updates.update('kimi');
  assert.equal(result.to, '2.1.0');
  assert.equal(createRuntimeManager(f.settings).locate('kimi').version, '2.1.0');
});

for (const failure of ['download', 'version', 'uninstall', 'save']) {
  test(`${failure} failure preserves the original CLI, custom path and previous managed installation`, async t => {
    const f = fixture(t);
    const previous = npmTree(path.join(f.managed, 'runtimes', 'kimi'), 'kimi', '1.5.0');
    const baseRun = f.settings.runCommand;
    const actualProbe = promisify(execFile);
    const manager = createRuntimeManager({ ...f.settings,
      runCommand: async (exe, args, options) => {
        if (failure === 'download' && args[1] === 'ci') throw new Error('download failed');
        if (failure === 'uninstall' && args[1] === 'uninstall') throw new Error('uninstall failed');
        return baseRun(exe, args, options);
      },
      probe: async (exe, args, options) => {
        if (failure === 'version' && args[0] !== f.original) throw new Error('version failed');
        return actualProbe(exe, args, options);
      },
      saveCustomPaths: paths => {
        if (failure === 'save') throw new Error('save failed');
        writeJson(f.config, paths);
      } });
    await assert.rejects(manager.reinstall('kimi'), new RegExp(failure));
    assert.equal(fs.existsSync(f.original), true);
    assert.equal(readJson(f.config).kimi.file, f.original);
    assert.match(fs.readFileSync(previous, 'utf8'), /1\.5\.0/);
    assert.equal(manager.locate('kimi').file, f.original);
    assert.deepEqual(fs.readdirSync(path.join(f.managed, 'runtimes')), ['kimi']);
    assert.equal(manager.busy, false);
  });
}

test('an uninstall that removes files before failing retains a usable managed CLI', async t => {
  const f = fixture(t), baseRun = f.settings.runCommand;
  const manager = createRuntimeManager({ ...f.settings, runCommand: async (exe, args, options) => {
    await baseRun(exe, args, options);
    if (args[1] === 'uninstall') throw new Error('partial uninstall');
  } });
  await assert.rejects(manager.reinstall('kimi'), /Reinstalled with Camellia, but.*partial uninstall/);
  const ready = manager.locate('kimi');
  assert.equal(ready.version, '2.0.0');
  assert.ok(!ready.external);
  assert.equal(manager.state().find(row => row.id === 'kimi').status, 'ready');
  assert.equal(readJson(f.config).kimi, undefined);
  assert.equal(fs.existsSync(f.unrelated), true);
});

test('managed installations take priority over bundled copies after migrating an override', async t => {
  const f = fixture(t);
  npmTree(path.join(f.distribution, 'runtimes', 'kimi'), 'kimi', '1.8.0');
  const ready = await f.manager.reinstall('kimi');
  assert.equal(ready.version, '2.0.0');
  assert.equal(createRuntimeManager(f.settings).locate('kimi').file, ready.file);
});

test('a custom path to a managed tree replaces that tree and clears the override without uninstalling its prefix', async t => {
  const f = fixture(t);
  const original = npmTree(path.join(f.managed, 'runtimes', 'kimi'), 'kimi', '1.5.0');
  writeJson(f.config, { kimi: { file: original, version: '1.5.0' } });
  assert.equal(f.manager.reinstallPlan('kimi').removal.kind, 'replacement');
  const ready = await f.manager.reinstall('kimi');
  assert.equal(ready.version, '2.0.0');
  assert.equal(f.calls.length, 1);
  assert.equal(readJson(f.config).kimi, undefined);
});

test('standalone native migration removes only the selected executable and keeps adjacent files', async t => {
  const f = fixture(t, { engine: 'codex', probe: async () => ({ stdout: 'codex 2.0.0' }) });
  const executable = put(path.join(f.root, 'tools', 'codex.exe'), 'standalone native CLI');
  const adjacent = put(path.join(f.root, 'tools', 'keep.exe'), 'another program');
  writeJson(f.config, { codex: { file: executable, version: '1.0.0' } });
  assert.equal(f.manager.reinstallPlan('codex').removal.kind, 'native');
  const ready = await f.manager.reinstall('codex');
  assert.equal(fs.existsSync(executable), false);
  assert.equal(fs.existsSync(adjacent), true);
  assert.ok(!ready.external);
});

test('global Unix npm prefixes and Codex companion binaries identify the owning package', async t => {
  const f = fixture(t);
  const prefix = path.join(f.root, 'global'), modules = path.join(prefix, 'lib', 'node_modules');
  const file = npmTree(prefix, 'codex', '1.0.0', modules);
  const plan = runtimeRemovalPlan({ engine: 'codex', definition: ENGINES.codex, file, destination: path.join(f.managed, 'runtimes', 'codex'), platform: 'darwin' });
  assert.equal(plan.prefix, prefix);
  assert.equal(plan.global, true);
  let args;
  await removeRuntime(plan, { node: 'node', npm: 'npm-cli', run: async (_exe, value) => {
    args = value;
    fs.rmSync(modules, { recursive: true });
  } });
  assert.ok(args.includes('--global'));
  assert.ok(args.includes('@openai/codex'));
  assert.equal(args[args.indexOf('--prefix') + 1], prefix);
});

test('an older DSH bin.js entry in the npx cache is recognized without assuming the current entry layout', t => {
  const f = fixture(t);
  const prefix = path.join(f.root, 'cache', '_npx', 'old-dsh');
  const pkg = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
  put(path.join(pkg, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', bin: { dsh: 'bin.js' } });
  const file = put(path.join(pkg, 'bin.js'), 'old DSH entry');
  const plan = runtimeRemovalPlan({ engine: 'dsh', definition: ENGINES.dsh, file, destination: path.join(f.managed, 'runtimes', 'dsh') });
  assert.equal(plan.kind, 'npm');
  assert.equal(plan.prefix, prefix);
  assert.equal(plan.global, false);
  assert.equal(plan.package, '@deepseek-ai/dsh');
});

test('Antigravity CLI migration preserves its managed API SDK and packages', async t => {
  const f = fixture(t), bytes = Buffer.from('official CLI fixture');
  const server = http.createServer((_req, response) => { response.end(bytes); });
  for (;;) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    if (!BAD_PORTS.has(server.address().port)) break;
    await new Promise(resolve => server.close(resolve));
  }
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  put(path.join(f.distribution, 'runtimes', 'antigravity', 'runtime.json'), { cli: {
    version: '1.2.3', platforms: { [process.platform + '-' + process.arch]: {
      url: `http://127.0.0.1:${server.address().port}/cli`, sha512: createHash('sha512').update(bytes).digest('hex'),
    } },
  } });
  const sdk = put(path.join(f.managed, 'runtimes', 'antigravity', 'packages', 'sdk.txt'), 'keep API packages');
  const marker = put(path.join(f.managed, 'runtimes', 'antigravity', 'installed.json'), { sdk: '0.1.17' });
  const original = put(path.join(f.root, 'tools', process.platform === 'win32' ? 'agy.exe' : 'agy'), 'external CLI');
  fs.chmodSync(original, 0o755);
  writeJson(f.config, { antigravity: { file: original, version: '1.0.0' } });
  const manager = createRuntimeManager({ ...f.settings, runtimeMode: engine => engine === 'antigravity' ? 'subscription' : 'api',
    probe: async (_exe, _args, options) => { assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true'); return { stdout: 'agy 1.2.3' }; },
    runCommand: async (_exe, args) => { if (args[0] === '-xzf') put(path.join(args[args.indexOf('-C') + 1], 'antigravity'), 'extracted CLI'); } });
  const ready = await manager.reinstall('antigravity');
  assert.equal(ready.version, '1.2.3');
  assert.equal(fs.readFileSync(sdk, 'utf8'), 'keep API packages');
  assert.equal(readJson(marker).sdk, '0.1.17');
  assert.equal(fs.existsSync(original), false);
  assert.equal(readJson(f.config).antigravity, undefined);
});

test('unknown installations and a stale confirmation cannot remove arbitrary files', async t => {
  const f = fixture(t);
  const script = put(path.join(f.root, 'source', 'cli.mjs'), "console.log('1.0.0')");
  writeJson(f.config, { kimi: { file: script, version: '1.0.0' } });
  assert.throws(() => f.manager.reinstallPlan('kimi'), /Could not identify/);
  assert.equal(fs.existsSync(script), true);
  writeJson(f.config, { kimi: { file: f.original, version: '1.0.0' } });
  const plan = f.manager.reinstallPlan('kimi');
  fs.appendFileSync(f.original, '// changed');
  await assert.rejects(f.manager.reinstall('kimi', plan), /runtime path changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.original), true);
});

test('native removal checks every launcher link before deleting the original executable', async t => {
  const f = fixture(t), directory = path.join(f.root, 'bin');
  const original = put(path.join(f.root, 'versions', 'claude.exe'), 'native CLI');
  const unrelated = put(path.join(f.root, 'versions', 'other.exe'), 'another binary');
  fs.mkdirSync(directory);
  const link = path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude');
  // Windows commonly disallows file symlinks without Developer Mode. Exercise
  // link replacement on hosts that support them; other migration cases run everywhere.
  try { fs.symlinkSync(original, link); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks unavailable'); return; } throw error; }
  const plan = runtimeRemovalPlan({ engine: 'claude', definition: ENGINES.claude, file: original,
    destination: path.join(f.managed, 'runtimes', 'claude'), env: { PATH: `"${directory}"` }, home: f.root });
  assert.ok(plan.files.includes(link));
  fs.unlinkSync(link); fs.symlinkSync(unrelated, link);
  await assert.rejects(removeRuntime(plan, {}), /runtime path changed/);
  assert.equal(fs.existsSync(original), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.realpathSync.native(link), unrelated);
});

test('a reinstall locks path changes and stays unavailable until its harness is restored', async t => {
  const f = fixture(t), baseRun = f.settings.runCommand;
  const started = Promise.withResolvers(), finishInstall = Promise.withResolvers(), restoring = Promise.withResolvers(), finishRestore = Promise.withResolvers();
  const manager = createRuntimeManager({ ...f.settings, runCommand: async (exe, args, options) => {
    if (args[1] === 'ci') { started.resolve(); await finishInstall.promise; }
    return baseRun(exe, args, options);
  } });
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, beforeInstall: async () => async () => {
    restoring.resolve(); await finishRestore.promise;
  } });
  const task = updates.reinstall('kimi');
  assert.strictEqual(updates.reinstall('kimi'), task);
  await started.promise;
  assert.equal(updates.state().find(row => row.id === 'kimi').reinstalling, true);
  await assert.rejects(manager.setPath('kimi', ''), /download to finish/);
  await assert.rejects(updates.update('kimi'), /update to finish/);
  assert.strictEqual(manager.ensure('kimi'), manager.ensure('kimi'));
  finishInstall.resolve(); await restoring.promise;
  assert.equal(updates.isUpdating('kimi'), true);
  finishRestore.resolve();
  const result = await task;
  assert.equal(result.runtime.version, '2.0.0');
  assert.equal(result.restartRequired, false);
  assert.equal(updates.isUpdating('kimi'), false);
  assert.equal(updates.state().find(row => row.id === 'kimi').reinstalling, false);
});

test('desktop reinstall preview is read-only, requires its token and rejects a changed installation', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const prefix = path.join(h.root, 'original'), file = npmTree(prefix, 'kimi', '1.0.0');
  put(path.join(prefix, 'package.json'), { dependencies: { [ENGINES.kimi.package]: '1.0.0' } });
  const config = path.join(h.userData, 'desktop-config.json');
  writeJson(config, { ...readJson(config), runtimePaths: { kimi: { file, version: '1.0.0' } } });
  h.dialogBehavior.message = async () => { throw new Error('Reinstall uses the themed renderer dialog'); };
  const before = fs.readFileSync(config, 'utf8');
  const preview = await h.call('runtime-reinstall-preview', { engine: 'kimi' });
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.file, file);
  assert.equal(preview.destination, path.join(h.userData, 'runtimes', 'kimi'));
  assert.equal(preview.name, 'Kimi Code');
  assert.ok(preview.token);
  for (const token of [undefined, 'invalid-preview']) {
    const result = await h.call('runtime-reinstall', { engine: 'kimi', token });
    assert.equal(result.ok, false);
    assert.match(result.error, /Review the installation paths/);
  }
  const next = await h.call('runtime-reinstall-preview', { engine: 'kimi' });
  assert.notEqual(next.token, preview.token);
  assert.equal((await h.call('runtime-reinstall', { engine: 'kimi', token: preview.token })).ok, false);
  fs.appendFileSync(file, '// Installation changed while confirmation was open');
  const changed = await h.call('runtime-reinstall', { engine: 'kimi', token: next.token });
  assert.equal(changed.ok, false);
  assert.match(changed.error, /runtime path changed/);
  const repeated = await h.call('runtime-reinstall', { engine: 'kimi', token: next.token });
  assert.equal(repeated.ok, false, 'Confirmation tokens are consumed once');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(h.userData, 'runtimes', 'kimi')), false);
});
