'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');

test('plugin cache IPC schedules one offline restart and exposes the saved result in preferences', async () => {
  const h = createHarness();
  let relaunches = 0, quits = 0;
  h.app.relaunch = () => relaunches++; h.app.quit = () => quits++;
  try {
    assert.equal((await h.call('plugin-cache-maintain')).ok, true);
    assert.equal(relaunches, 1); assert.equal(quits, 1);
    const { completePluginCacheMaintenance } = require('../src/main/plugin-cache-startup');
    const result = completePluginCacheMaintenance({ dataDir: h.userData, assertOffline() {} });
    assert.equal(result.error, undefined);
    const preferences = await h.call('workbench-settings');
    assert.equal(preferences.pluginCacheMaintenance.pending, false);
    assert.equal(preferences.pluginCacheMaintenance.result.finishedAt, result.finishedAt);
  } finally { h.cleanup(); }
});

test('a failed relaunch clears the cache request rather than triggering unexpected later maintenance', async () => {
  const h = createHarness();
  h.app.relaunch = () => { throw new Error('relaunch failed'); };
  try {
    const result = await h.call('plugin-cache-maintain');
    assert.equal(result.ok, false); assert.equal(result.error, 'relaunch failed');
    assert.equal((await h.call('workbench-settings')).pluginCacheMaintenance.pending, false);
  } finally { h.cleanup(); }
});

test('the settings handlers export and re-import the selected profile categories', async t => {
  const source = createHarness();
  const target = createHarness();
  try {
    source.configureApi();
    fs.mkdirSync(path.join(source.userData, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(source.userData, 'conversations', 'transfer.jsonl'), '{"role":"user"}\n');
    const packageFile = path.join(source.root, 'camellia-data-package.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: packageFile });
    const exported = await source.call('data-export');
    assert.equal(exported.ok, true);
    assert.equal(exported.canceled, undefined);
    assert.equal(fs.existsSync(packageFile), true);
    assert.equal(exported.files > 0, true);

    // The first call only reads the package and reports its categories; no
    // dialog is shown until the settings page selects the categories.
    const preview = await target.call('data-import', { file: packageFile });
    assert.equal(preview.ok, true);
    assert.equal(preview.needsSelection, true);
    assert.deepEqual(JSON.parse(JSON.stringify(preview.categories)), exported.categories);
    assert.equal(preview.categories.api.files > 0, true);
    assert.equal(preview.categories.settings.files > 0, true);
    assert.equal(preview.categories.conversations.files > 0, true);
    assert.equal(preview.file, packageFile);
    // The second call imports the selected categories.
    const imported = await target.call('data-import', { file: packageFile, scope: ['api', 'settings', 'conversations'] });
    assert.equal(imported.ok, true);
    assert.equal(imported.canceled, undefined);
    assert.equal(imported.restored, exported.files);
    assert.deepEqual(imported.scope, ['api', 'settings', 'conversations']);
    const config = path.join(target.home, '.dsh', 'ollama-proxy.json');
    assert.equal(fs.existsSync(config), true);
    const routes = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.equal(routes.providers[0].models[0].id, 'test-model');
  } finally { source.cleanup(); target.cleanup(); }
});

test('a dismissed dialog changes nothing', async t => {
  const h = createHarness();
  try {
    h.configureApi();
    const missing = path.join(h.root, 'camellia-data-package.zip');
    h.dialogBehavior.save = async () => ({ canceled: true });
    h.dialogBehavior.open = async () => ({ canceled: true, filePaths: [] });
    const exported = await h.call('data-export');
    assert.equal(exported.ok, true); assert.equal(exported.canceled, true);
    const imported = await h.call('data-import');
    assert.equal(imported.ok, true); assert.equal(imported.canceled, true);
    assert.equal(fs.existsSync(missing), false);
  } finally { h.cleanup(); }
});

test('API export leaves subscription clients and their native files untouched', async () => {
  const harness = createHarness();
  try {
    harness.configureApi();
    const wal = path.join(harness.userData, 'codex', 'subscription', 'state_5.sqlite-wal');
    fs.mkdirSync(path.dirname(wal), { recursive: true });
    fs.writeFileSync(wal, 'temporary WAL');
    fs.writeFileSync(path.join(harness.userData, 'desktop-config.json'), '{}');
    const proc = new (require('node:events').EventEmitter)();
    proc.exitCode = null; proc.signalCode = null;
    let stopped = false;
    harness.api.codex.sessions.set({ conversationId: 'idle-export' }, {
      client: { proc }, running: false,
      shutdown() {
        setTimeout(() => { fs.unlinkSync(wal); stopped = true; proc.exitCode = 0; proc.emit('exit', 0); }, 50);
      },
    });
    const destination = path.join(harness.root, 'export.zip');
    harness.dialogBehavior.save = async () => ({ canceled: false, filePath: destination });
    const result = await harness.call('data-export', { scope: ['api'] });
    assert.equal(stopped, false);
    assert.equal(result.ok, true, result.error);
    const zip = await require('jszip').loadAsync(fs.readFileSync(destination));
    assert.equal(zip.file('app/desktop-config.json'), null);
    assert.ok(zip.file('home/.dsh/ollama-proxy.json'));
    assert.equal(zip.file('app/codex/subscription/state_5.sqlite-wal'), null);
    assert.equal(fs.readFileSync(wal, 'utf8'), 'temporary WAL');
  } finally { harness.cleanup(); }
});

test('conversation exports wait for native API writers to exit before collecting files', async () => {
  const harness = createHarness();
  try {
    harness.configureApi();
    const wal = path.join(harness.userData, 'codex/api/state_5.sqlite-wal');
    fs.mkdirSync(path.dirname(wal), { recursive: true });
    fs.writeFileSync(wal, 'temporary WAL');
    const proc = new (require('node:events').EventEmitter)();
    proc.exitCode = null; proc.signalCode = null;
    let stopped = false;
    harness.api.codex.sessions.set({ conversationId: 'idle-history-export' }, {
      client: { proc }, running: false,
      shutdown() {
        setTimeout(() => { fs.unlinkSync(wal); stopped = true; proc.exitCode = 0; proc.emit('exit', 0); }, 50);
      },
    });
    const destination = path.join(harness.root, 'history-export.zip');
    harness.dialogBehavior.save = async () => ({ canceled: false, filePath: destination });
    const result = await harness.call('data-export');
    assert.equal(result.ok, true, result.error);
    assert.equal(stopped, true);
    assert.equal(fs.existsSync(wal), false);
    const zip = await require('jszip').loadAsync(fs.readFileSync(destination));
    assert.equal(zip.file('app/codex/api/state_5.sqlite-wal'), null);
    assert.ok(zip.file('app/desktop-config.json'));
  } finally { harness.cleanup(); }
});

test('canceling or refusing a busy export leaves engine processes running', async context => {
  const harness = createHarness();
  try {
    let shutdowns = 0;
    context.mock.method(harness.api.codex, 'shutdown', async () => { shutdowns++; });
    assert.equal((await harness.call('data-export')).canceled, true);
    context.mock.method(harness.api.sharedConversations, 'isBusy', () => true);
    const result = await harness.call('data-export');
    assert.equal(result.ok, false);
    assert.match(result.error, /Stop the current response/);
    assert.equal(shutdowns, 0);
  } finally { harness.cleanup(); }
});

test('a pending export blocks new goals and account clients until it finishes', async context => {
  const harness = createHarness();
  let release, pending;
  try {
    harness.configureApi();
    const closing = new Promise(resolve => { release = resolve; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    harness.dialogBehavior.save = async () => { started(); await closing; return { canceled: false, filePath: path.join(harness.root, 'export.zip') }; };
    pending = harness.call('data-export');
    await entered;
    for (const channel of ['claude-goal-start', 'codex-account-refresh']) {
      const result = await harness.call(channel, {});
      assert.equal(result.ok, false);
      assert.match(result.error, /Wait for the data transfer/);
    }
    release();
    assert.equal((await pending).ok, true);
    assert.equal((await harness.call('codex-account-state')).ok, true);
  } finally { release?.(); await pending; harness.cleanup(); }
});

test('a damaged package returns an error before category selection or restoration', async () => {
  const harness = createHarness();
  try {
    const packageFile = path.join(harness.root, 'damaged.zip');
    fs.writeFileSync(packageFile, 'not a ZIP archive');
    let dialogs = 0;
    harness.dialogBehavior.message = async () => { dialogs++; return { response: 0 }; };
    const imported = await harness.call('data-import', { file: packageFile });
    assert.equal(imported.ok, false);
    assert.match(imported.error, /not a Camellia data package/);
    assert.equal(dialogs, 0);
  } finally { harness.cleanup(); }
});

test('opening the scope preview writes nothing', async t => {
  const source = createHarness();
  const target = createHarness();
  try {
    source.configureApi();
    const packageFile = path.join(source.root, 'camellia-data-package.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: packageFile });
    await source.call('data-export');
    // Dismissing the settings-page dialog imports nothing, because no second
    // call with a scope is ever made.
    const preview = await target.call('data-import', { file: packageFile });
    assert.equal(preview.needsSelection, true);
    const emptySelection = await target.call('data-import', { file: preview.file, scope: [] });
    assert.equal(emptySelection.ok, false);
    assert.match(emptySelection.error, /Choose at least one category/);
    assert.equal(emptySelection.restored, undefined);
    assert.equal(fs.existsSync(path.join(target.home, '.dsh', 'ollama-proxy.json')), false);
  } finally { source.cleanup(); target.cleanup(); }
});

test('settings-only import restores preferences and leaves APIs and conversations alone', async t => {
  const source = createHarness();
  const target = createHarness();
  try {
    source.configureApi();
    const packageFile = path.join(source.root, 'camellia-data-package.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: packageFile });
    await source.call('data-export');
    const imported = await target.call('data-import', { file: packageFile, scope: ['settings'] });
    assert.equal(imported.ok, true, imported.error);
    assert.deepEqual(imported.scope, ['settings']);
    assert.equal(fs.existsSync(path.join(target.home, '.dsh', 'ollama-proxy.json')), false);
    const conversations = path.join(target.userData, 'conversations');
    const restored = fs.existsSync(conversations) ? fs.readdirSync(conversations) : [];
    assert.deepEqual(restored.filter(name => name.endsWith('.jsonl')), []);
  } finally { source.cleanup(); target.cleanup(); }
});

test('export IPC accepts a selection and import preview offers only included categories', async () => {
  const source = createHarness(), target = createHarness();
  try {
    source.configureApi();
    const packageFile = path.join(source.root, 'api-only.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: packageFile });
    const exported = await source.call('data-export', { scope: ['api'] });
    assert.equal(exported.ok, true);
    assert.deepEqual(exported.scope, ['api']);
    const preview = await target.call('data-import', { file: packageFile });
    assert.deepEqual(Object.keys(preview.categories), ['api']);
    const unavailable = await target.call('data-import', { file: packageFile, scope: ['settings'] });
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error, /no data for the selected/);
    assert.equal(fs.existsSync(path.join(target.home, '.dsh/ollama-proxy.json')), false);
    const imported = await target.call('data-import', { file: packageFile, scope: ['api'] });
    assert.equal(imported.ok, true);
  } finally { source.cleanup(); target.cleanup(); }
});

test('empty export selection is rejected without a save dialog', async () => {
  const harness = createHarness();
  try {
    let dialogs = 0;
    harness.dialogBehavior.save = async () => { dialogs++; return { canceled: true }; };
    const exported = await harness.call('data-export', { scope: [] });
    assert.equal(exported.ok, false);
    assert.match(exported.error, /Choose at least one category/);
    assert.equal(dialogs, 0);
  } finally { harness.cleanup(); }
});

test('subscription data cannot be selected as a fourth export category', async () => {
  const harness = createHarness();
  try {
    let dialogs = 0;
    harness.dialogBehavior.save = async () => { dialogs++; return { canceled: true }; };
    for (const scope of [['subscriptions'], ['api', 'subscriptions']]) {
      const exported = await harness.call('data-export', { scope });
      assert.equal(exported.ok, false);
      assert.match(exported.error, /Choose at least one category/);
    }
    assert.equal(dialogs, 0);
  } finally { harness.cleanup(); }
});

test('legacy complete-profile packages restore all categories while preserving local subscription accounts', async () => {
  const harness = createHarness();
  try {
    const JSZip = require('jszip'), zip = new JSZip();
    const route = '{"providers":[{"id":"transferred","keys":[{"key":"api-secret"}]}]}';
    const entries = { 'home/.dsh/ollama-proxy.json': route,
      'app/desktop-config.json': '{"language":"zh-CN","subscriptionAccounts":{"codex":[{"id":"source"}]}}',
      'app/subscription-accounts/codex/account-1/auth.json': '{"tokens":"source subscription"}',
      'app/conversations/history.jsonl': '{"role":"user"}\n' };
    zip.file('camellia-migration.json', JSON.stringify({ format: 'camellia-data', version: 1,
      source: { appDataDir: path.join(harness.root, 'old-data'), home: path.join(harness.root, 'old-home') },
      counts: { files: Object.keys(entries).length, bytes: Object.values(entries).reduce((sum, text) => sum + Buffer.byteLength(text), 0) } }));
    for (const [name, text] of Object.entries(entries)) zip.file(name, text, { createFolders: false });
    const file = path.join(harness.root, 'legacy.zip');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const configFile = path.join(harness.userData, 'desktop-config.json');
    const currentConfig = '{"language":"en","subscriptionAccounts":{"codex":[{"id":"target"}]}}';
    fs.writeFileSync(configFile, currentConfig);
    const authFile = path.join(harness.userData, 'subscription-accounts/codex/account-1/auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"tokens":"target subscription"}');
    const preview = await harness.call('data-import', { file });
    assert.equal(preview.ok, true);
    assert.deepEqual(Object.keys(preview.categories).sort(), ['api', 'conversations', 'settings']);
    assert.equal(preview.categories.api.files, 1);
    const imported = await harness.call('data-import', { file, scope: 'all' });
    assert.equal(imported.ok, true, imported.error);
    assert.deepEqual(imported.scope, ['api', 'settings', 'conversations']);
    assert.equal(imported.restored, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(harness.home, '.dsh/ollama-proxy.json'), 'utf8')), JSON.parse(route));
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { language: 'zh-CN', subscriptionAccounts: { codex: [{ id: 'target' }] } });
    assert.equal(fs.readFileSync(authFile, 'utf8'), '{"tokens":"target subscription"}');
    assert.equal(fs.readFileSync(path.join(harness.userData, 'conversations/history.jsonl'), 'utf8'), entries['app/conversations/history.jsonl']);
  } finally { harness.cleanup(); }
});

test('a subscription-only legacy package is refused before import confirmation', async () => {
  const harness = createHarness();
  try {
    const zip = new (require('jszip'))(), text = '{"tokens":"subscription"}';
    zip.file('camellia-migration.json', JSON.stringify({ format: 'camellia-data', version: 1,
      source: { appDataDir: harness.userData, home: harness.home }, counts: { files: 1, bytes: Buffer.byteLength(text) } }));
    zip.file('app/codex/subscription/auth.json', text, { createFolders: false });
    const file = path.join(harness.root, 'subscription-only.zip');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const preview = await harness.call('data-import', { file });
    assert.equal(preview.ok, false);
    assert.match(preview.error, /no Camellia data/);
    assert.equal(preview.needsSelection, undefined);
    assert.equal(fs.existsSync(path.join(harness.userData, 'codex/subscription/auth.json')), false);
  } finally { harness.cleanup(); }
});

test('directory migration does not relaunch a custom test profile', async () => {
  const harness = createHarness();
  try {
    const settings = await harness.call('workbench-settings');
    assert.equal(settings.dataDirectory.legacy, false);
    const result = await harness.call('data-directory-migrate');
    assert.equal(result.ok, false);
    assert.match(result.error, /Custom data directories/);
  } finally { harness.cleanup(); }
});
