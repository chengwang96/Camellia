'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRuntimeManager, ENGINES } = require('../src/main/runtime-manager');
const { createRuntimeUpdates } = require('../src/main/runtime-updates');
const { createHarness } = require('./claude-harness.cjs');
const { removeTree } = require('./test-fs.cjs');

function put(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
function kimi(dir) {
  const pkg = path.join(dir, 'node_modules', ENGINES.kimi.package);
  put(path.join(pkg, 'package.json'), { name: ENGINES.kimi.package, version: '1.0.0' });
  return put(path.join(pkg, ENGINES.kimi.entry), '// fixture');
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-uninstall-'));
  t.after(() => removeTree(root));
  const distribution = path.join(root, 'distribution'), installed = path.join(root, 'installed');
  const paths = {}, calls = [];
  const manager = createRuntimeManager({ root: distribution, installRoot: installed, node: process.execPath, npm: 'fixture-npm',
    discoverLocal: false, customPaths: () => paths, saveCustomPaths: next => { for (const key of Object.keys(paths)) delete paths[key]; Object.assign(paths, next); },
    runCommand: async (...args) => calls.push(args), ...extra });
  return { root, distribution, installed, paths, calls, manager };
}

test('managed uninstall preserves runtime manifests, other engines, conversations and account configuration; reinstall remains possible', async t => {
  const f = fixture(t), dir = path.join(f.installed, 'runtimes/kimi');
  const entry = kimi(dir), other = put(path.join(f.installed, 'runtimes/pi/keep'), 'other engine');
  const account = put(path.join(f.installed, 'accounts.json'), 'account settings');
  const conversation = put(path.join(f.installed, 'conversations/keep.json'), 'conversation');
  const manifest = put(path.join(dir, 'package.json'), '{}');
  const original = JSON.stringify(f.paths);
  const plan = f.manager.uninstallPlan('kimi');
  assert.equal(fs.existsSync(entry), true, 'Preview is read only');
  assert.equal(f.calls.length, 0);
  await f.manager.uninstall('kimi', plan);
  assert.equal(f.manager.locate('kimi'), null);
  assert.equal(f.manager.state().find(row => row.id === 'kimi').status, 'missing');
  assert.equal(fs.existsSync(entry), false);
  for (const file of [other, account, conversation, manifest]) assert.equal(fs.existsSync(file), true);
  assert.equal(JSON.stringify(f.paths), original);
  for (const name of ['package.json', 'package-lock.json']) put(path.join(f.distribution, 'runtimes/kimi', name), '{}');
  const reinstaller = createRuntimeManager({ root: f.distribution, installRoot: f.installed, node: process.execPath, npm: 'fixture', discoverLocal: false,
    runCommand: async (_exe, args) => kimi(args[args.indexOf('--prefix') + 1]) });
  assert.equal((await reinstaller.ensure('kimi')).source, 'Installed by Camellia');
});

test('external npm uninstall removes only the selected package and clears only its runtime override', async t => {
  const f = fixture(t), prefix = path.join(f.root, 'external');
  const entry = kimi(prefix), sibling = put(path.join(prefix, 'node_modules/other/package.json'), '{}');
  put(path.join(prefix, 'package.json'), { dependencies: { [ENGINES.kimi.package]: '1.0.0' } });
  f.paths.kimi = { file: entry, version: '1.0.0' }; f.paths.python = { file: 'keep-python' };
  const manager = createRuntimeManager({ root: f.distribution, installRoot: f.installed, node: process.execPath, npm: 'fixture-npm', discoverLocal: false,
    customPaths: () => f.paths, saveCustomPaths: next => { delete f.paths.kimi; Object.assign(f.paths, next); },
    runCommand: async (_exe, args) => {
      assert.equal(args[1], 'uninstall'); assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--global=false'));
      assert.equal(args[args.indexOf('--prefix') + 1], fs.realpathSync.native(prefix));
      fs.rmSync(path.join(prefix, 'node_modules', ENGINES.kimi.package), { recursive: true });
    } });
  await manager.uninstall('kimi', manager.uninstallPlan('kimi'));
  assert.equal(fs.existsSync(entry), false); assert.equal(fs.existsSync(sibling), true);
  assert.deepEqual(f.paths, { python: { file: 'keep-python' } });
});

test('stale confirmation and redirected runtime directories cannot delete files', async t => {
  const f = fixture(t), dir = path.join(f.installed, 'runtimes/kimi'), entry = kimi(dir);
  const plan = f.manager.uninstallPlan('kimi');
  fs.appendFileSync(entry, 'changed');
  await assert.rejects(async () => f.manager.uninstall('kimi', plan), /runtime path changed/);
  const outside = path.join(f.root, 'outside');
  fs.renameSync(path.join(dir, 'node_modules'), outside);
  fs.symlinkSync(outside, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.manager.uninstallPlan('kimi'), /outside its installation/);
  assert.equal(fs.existsSync(path.join(outside, ENGINES.kimi.package, ENGINES.kimi.entry)), true);
});

test('a saved path inside a managed installation is removed without touching the shared Python path', async t => {
  const f = fixture(t), entry = kimi(path.join(f.installed, 'runtimes/kimi'));
  f.paths.kimi = { file: entry, version: '1.0.0' }; f.paths.python = { file: process.execPath };
  await f.manager.uninstall('kimi', f.manager.uninstallPlan('kimi'));
  assert.equal(f.paths.kimi, undefined); assert.equal(f.paths.python.file, process.execPath);
});

test('Antigravity SDK and subscription CLI uninstall independently and retain the shared interpreter', async t => {
  const f = fixture(t), dir = path.join(f.installed, 'runtimes/antigravity');
  const python = put(path.join(f.root, 'shared-python'), 'shared interpreter');
  f.paths.python = { file: python };
  put(path.join(dir, 'runtime.json'), { sdk: '1.0.0', python: '3.13.0', platforms: { [process.platform + '-' + process.arch]: { python: 'python' } } });
  const marker = { sdk: '1.0.0', python: 'shared', sharedPython: python };
  put(path.join(dir, 'installed.json'), marker);
  const sdk = put(path.join(dir, 'packages/google/antigravity/__init__.py'));
  const cli = put(path.join(dir, 'cli', process.platform === 'win32' ? 'agy.exe' : 'agy'), 'fixture');
  put(path.join(dir, 'cli/installed.json'), { version: '1.0.0' });
  await f.manager.uninstall('antigravity', f.manager.uninstallPlan('antigravity', 'subscription'));
  assert.equal(fs.existsSync(cli), false); assert.equal(fs.existsSync(sdk), true); assert.equal(fs.existsSync(python), true);
  await f.manager.uninstall('antigravity', f.manager.uninstallPlan('antigravity', 'api'));
  assert.equal(fs.existsSync(sdk), false); assert.equal(fs.existsSync(python), true);
  assert.equal(f.manager.locate('antigravity', 'api'), null);
});

test('uninstall failure releases locks, keeps the selected override, and restores the idle harness', async t => {
  const f = fixture(t), entry = kimi(path.join(f.root, 'external'));
  put(path.join(f.root, 'external/package.json'), {});
  f.paths.kimi = { file: entry, version: '1.0.0' };
  let restore = 0;
  const manager = createRuntimeManager({ root: f.distribution, installRoot: f.installed, node: process.execPath, npm: 'fixture',
    discoverLocal: false, customPaths: () => f.paths, saveCustomPaths: () => assert.fail('Cannot clear a failed uninstall'),
    runCommand: async () => { throw new Error('locked package'); } });
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, beforeInstall: async () => async () => { restore++; } });
  await assert.rejects(updates.uninstall('kimi', manager.uninstallPlan('kimi')), /locked package/);
  assert.equal(restore, 1); assert.equal(updates.isUpdating('kimi'), false); assert.equal(manager.busy, false);
  assert.equal(manager.locate('kimi').file, entry);
});

test('uninstall publishes busy state, blocks launches and path edits, and does not restart the removed engine', async t => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = fixture(t), entry = kimi(path.join(f.root, 'external'));
  put(path.join(f.root, 'external/package.json'), {});
  f.paths.kimi = { file: entry, version: '1.0.0' };
  let restored = false;
  const manager = createRuntimeManager({ root: f.distribution, installRoot: f.installed, node: process.execPath, npm: 'fixture', discoverLocal: false,
    customPaths: () => f.paths, saveCustomPaths: () => { delete f.paths.kimi; },
    runCommand: async () => { started.resolve(); await finish.promise; fs.rmSync(path.dirname(path.dirname(entry)), { recursive: true }); } });
  const updates = createRuntimeUpdates({ manager, engines: ENGINES, beforeInstall: async () => async () => { restored = true; } });
  const plan = manager.uninstallPlan('kimi'), task = updates.uninstall('kimi', plan);
  await started.promise;
  assert.equal(updates.state().find(row => row.id === 'kimi').uninstalling, true);
  await assert.rejects(manager.ensure('kimi'), /uninstall to finish/);
  await assert.rejects(manager.setPath('kimi', ''), /download to finish/);
  await assert.rejects(updates.update('kimi'), /update to finish/);
  finish.resolve(); await task;
  assert.equal(restored, false); assert.equal(manager.busy, false); assert.equal(updates.isUpdating('kimi'), false);
});

test('desktop uninstall requires a fresh preview token, blocks active sessions, and preserves settings', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const dir = path.join(h.userData, 'runtimes/kimi'), entry = kimi(dir);
  const account = put(path.join(h.userData, 'account-fixture.json'), 'keep account');
  const driver = h.api.sharedConversations.drivers.kimi;
  const session = { running: true, shutdown: async () => {} }; driver.sessions.set({}, session);
  assert.equal((await h.call('runtime-uninstall-preview', { engine: 'kimi' })).ok, false);
  session.running = false;
  const preview = await h.call('runtime-uninstall-preview', { engine: 'kimi' });
  assert.equal(preview.ok, true, preview.error); assert.equal(fs.existsSync(entry), true);
  assert.equal((await h.call('runtime-uninstall', { engine: 'kimi', token: 'wrong' })).ok, false);
  const result = await h.call('runtime-uninstall', { engine: 'kimi', token: preview.token });
  assert.equal(result.ok, true, result.error); assert.equal(fs.existsSync(entry), false); assert.equal(fs.existsSync(account), true);
  assert.equal((await h.call('runtime-uninstall', { engine: 'kimi', token: preview.token })).ok, false);
  assert.ok(h.events.some(event => event.channel === 'dsh:runtime-state' && event.data.some(row => row.id === 'kimi' && row.file !== entry && !row.uninstalling)));
});
