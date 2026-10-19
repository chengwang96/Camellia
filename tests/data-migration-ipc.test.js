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
    assert.equal(imported.restored, exported.files - 1, 'portable preferences and history metadata share the destination desktop file');
    assert.deepEqual(imported.scope, ['api', 'settings', 'conversations']);
    const config = path.join(target.home, '.dsh', 'ollama-proxy.json');
    assert.equal(fs.existsSync(config), true);
    const routes = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.equal(routes.providers[0].models[0].id, 'test-model');
    assert.equal(routes.port, undefined, 'the source router port is not imported');
  } finally { source.cleanup(); target.cleanup(); }
});

test('an API-only import applies the provider pool without replacing the running router port', async t => {
  const source = createHarness(), target = createHarness();
  try {
    source.configureApi();
    const packageFile = path.join(source.root, 'api-only-port.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: packageFile });
    assert.equal((await source.call('data-export', { scope: ['api'] })).ok, true);

    const { loadConfig, writeConfig, normalizeConfig } = require('../src/api/api-router-config');
    const localPort = 19444;
    writeConfig(path.join(target.home, '.dsh', 'ollama-proxy.json'), normalizeConfig({ port: localPort, providers: [{
      id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:19099/v1', protocol: 'openai',
      models: [{ id: 'local-model', upstream: 'local-model' }], keys: [{ id: 'local-key', key: 'local-secret' }],
    }] }));
    await target.call('api-router-save-config', JSON.parse(fs.readFileSync(path.join(target.home, '.dsh', 'ollama-proxy.json'), 'utf8')));
    assert.equal((await target.call('api-router-get-state')).running, true);

    const imported = await target.call('data-import', { file: packageFile, scope: ['api'] });
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.apiRoutes, true);
    const state = await target.call('api-router-get-state');
    assert.equal(state.running, true);
    assert.equal(state.port, localPort);
    assert.equal(state.providers[0].id, 'test');
    assert.equal(state.providers[0].models[0].id, 'test-model');
    assert.equal(loadConfig(path.join(target.home, '.dsh', 'ollama-proxy.json')).providers[0].keys[0].key, 'isolated-test-key');
  } finally { await source.api.stopRouter(); source.cleanup(); await target.api.stopRouter(); target.cleanup(); }
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

test('import IPC checks installed harnesses again after preview and never starts an installation', async () => {
  let installed = { codex: true };
  const source = createHarness(), target = createHarness(undefined, {
    runtimeLocator: engine => installed[engine] ? { file: 'fixture-runtime', version: '1.0.0' } : null,
  });
  try {
    const native = path.join(source.userData, 'codex/config.toml');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, 'approval_policy = "never"\n');
    const file = path.join(source.root, 'native-settings.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: file });
    assert.equal((await source.call('data-export', { scope: 'settings' })).ok, true);
    const preview = await target.call('data-import', { file });
    assert.equal(preview.ok, true); assert.deepEqual(preview.skippedEngines, []);
    installed = {};
    const result = await target.call('data-import', { file, scope: 'settings' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.skippedEngines, ['codex']); assert.equal(result.restored, 0);
    assert.equal(fs.existsSync(path.join(target.userData, 'codex/config.toml')), false);
    assert.equal(fs.existsSync(path.join(target.userData, 'runtimes')), false);
  } finally { source.cleanup(); target.cleanup(); }
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

test('a pending export dialog leaves new responses and account clients available', async context => {
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
    for (const channel of ['codex-account-state', 'codex-account-refresh']) {
      const result = await harness.call(channel, {});
      assert.doesNotMatch(result.error || '', /Wait for the data transfer/);
      if (channel === 'codex-account-state') assert.equal(result.ok, true, result.error);
    }
    release();
    assert.equal((await pending).ok, true);
    assert.equal((await harness.call('codex-account-state')).ok, true);
  } finally { release?.(); await pending; harness.cleanup(); }
});

test('API and settings exports ignore active responses and unrelated downloads or upgrades', async context => {
  const h = createHarness();
  try {
    h.configureApi();
    const services = h.api.migrationServices();
    context.mock.getter(services.runtimes, 'busy', () => true);
    context.mock.getter(services.libraries, 'busy', () => true);
    context.mock.method(services.updates, 'isUpdating', () => true);
    context.mock.method(h.api.sharedConversations, 'isBusy', () => true);
    let shutdowns = 0;
    context.mock.method(h.api.codex, 'shutdown', async () => { shutdowns++; });
    for (const scope of [['api'], ['settings'], ['api', 'settings']]) {
      const file = path.join(h.root, scope.join('-') + '.zip');
      h.dialogBehavior.save = async () => ({ canceled: false, filePath: file });
      const result = await h.call('data-export', { scope });
      assert.equal(result.ok, true, result.error);
      assert.ok(fs.existsSync(file));
      assert.deepEqual(JSON.parse(JSON.stringify(result.scope)), scope);
    }
    assert.equal(shutdowns, 0);
  } finally { h.cleanup(); }
});

test('conversation exports allow downloads and release engine access after the immutable snapshot', async context => {
  const h = createHarness();
  try {
    h.configureApi();
    const services = h.api.migrationServices();
    context.mock.getter(services.runtimes, 'busy', () => true);
    context.mock.getter(services.libraries, 'busy', () => true);
    context.mock.method(services.updates, 'isUpdating', () => false);
    const access = [];
    h.api.setWindow({ isDestroyed: () => false, webContents: { send(channel, state) {
      if (channel !== 'dsh:data-migration-progress') return;
      if (state.phase === 'snapshot' || state.phase === 'export') {
        access.push(h.call('codex-account-state', {}).then(result => ({ ...state, result })));
      }
    } } });
    const file = path.join(h.root, 'history-downloads.zip');
    h.dialogBehavior.save = async () => ({ canceled: false, filePath: file });
    const result = await h.call('data-export', { scope: ['conversations'] });
    assert.equal(result.ok, true, result.error);
    const checks = await Promise.all(access);
    assert.ok(checks.some(check => check.phase === 'snapshot' && !check.phaseComplete && !check.result.ok));
    assert.ok(checks.some(check => check.phase === 'snapshot' && check.phaseComplete && check.result.ok));
    assert.ok(checks.some(check => check.phase === 'export' && check.result.ok));
    const blocked = checks.filter(check => check.phase === 'snapshot' && !check.phaseComplete);
    for (const check of blocked) assert.match(check.result.error, /Wait for the data transfer/);
  } finally { h.cleanup(); }
});

test('read-only import previews ignore running work, downloads and application updates', async context => {
  const source = createHarness(), target = createHarness();
  try {
    source.configureApi();
    const file = path.join(source.root, 'preview.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: file });
    assert.equal((await source.call('data-export')).ok, true);
    const services = target.api.migrationServices();
    context.mock.getter(services.runtimes, 'busy', () => true);
    context.mock.getter(services.libraries, 'busy', () => true);
    services.benchmarks.pending = { id: 'preview-benchmark' };
    context.mock.method(services.updates, 'isUpdating', () => true);
    context.mock.method(services.appUpdates, 'state', () => ({ installing: true }));
    context.mock.method(target.api.sharedConversations, 'isBusy', () => true);
    const config = path.join(target.userData, 'desktop-config.json');
    fs.writeFileSync(config, '{"theme":"dark"}\n');
    const result = await target.call('data-import', { file });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.needsSelection, true);
    assert.equal(result.categories.api.files > 0, true);
    assert.equal(fs.readFileSync(config, 'utf8'), '{"theme":"dark"}\n');
    assert.equal(fs.existsSync(path.join(target.userData, 'migration-backups')), false);
  } finally { source.cleanup(); target.cleanup(); }
});

test('API imports allow active responses and downloads, but keep benchmark routes stable', async context => {
  const source = createHarness(), target = createHarness();
  try {
    source.configureApi();
    const file = path.join(source.root, 'api-during-work.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: file });
    assert.equal((await source.call('data-export', { scope: ['api'] })).ok, true);
    const services = target.api.migrationServices();
    context.mock.getter(services.runtimes, 'busy', () => true);
    context.mock.getter(services.libraries, 'busy', () => true);
    context.mock.method(services.updates, 'isUpdating', () => true);
    context.mock.method(target.api.sharedConversations, 'isBusy', () => true);
    let shutdowns = 0;
    services.benchmarks.pending = { id: 'active-benchmark' };
    context.mock.method(target.api.codex, 'shutdown', async () => { shutdowns++; });
    const refused = await target.call('data-import', { file, scope: ['api'] });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Stop the benchmark before changing API routes/);
    assert.equal(fs.existsSync(path.join(target.home, '.dsh', 'ollama-proxy.json')), false);
    services.benchmarks.pending = null;
    const imported = await target.call('data-import', { file, scope: ['api'] });
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.apiRoutes, true);
    assert.equal(shutdowns, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, '.dsh', 'ollama-proxy.json'), 'utf8')).providers[0].id, 'test');
  } finally { await target.api.stopRouter(); source.cleanup(); target.cleanup(); }
});

test('settings and conversation imports reject conflicting writers, but allow unrelated downloads', async context => {
  const source = createHarness(), target = createHarness();
  try {
    source.configureApi();
    const file = path.join(source.root, 'profile-during-work.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: file });
    assert.equal((await source.call('data-export')).ok, true);
    const services = target.api.migrationServices();
    context.mock.getter(services.runtimes, 'busy', () => true);
    context.mock.getter(services.libraries, 'busy', () => true);
    let active = true, updating = false;
    context.mock.method(target.api.sharedConversations, 'isBusy', () => active);
    context.mock.method(services.updates, 'isUpdating', () => updating);
    for (const scope of [['settings'], ['conversations']]) {
      active = true; updating = false;
      const busy = await target.call('data-import', { file, scope });
      assert.equal(busy.ok, false);
      assert.match(busy.error, /Stop the current response/);
      active = false; updating = true;
      const upgrade = await target.call('data-import', { file, scope });
      assert.equal(upgrade.ok, false);
      assert.match(upgrade.error, /Wait for runtime updates/);
      assert.equal(fs.existsSync(path.join(target.userData, 'migration-backups')), false);
      updating = false;
      const imported = await target.call('data-import', { file, scope });
      assert.equal(imported.ok, true, imported.error);
    }
    assert.equal((await target.call('codex-account-state')).ok, true, 'failed imports release their engine barrier');
    const maintenance = await target.call('plugin-cache-maintain');
    assert.equal(maintenance.ok, false);
    assert.match(maintenance.error, /Wait for downloads and updates/);
    assert.equal((await target.call('codex-account-state')).ok, true, 'failed directory maintenance releases its engine barrier');
  } finally { source.cleanup(); target.cleanup(); }
});

test('imports validate a selected package before stopping idle native processes', async context => {
  const h = createHarness();
  try {
    let shutdowns = 0;
    context.mock.method(h.api.codex, 'shutdown', async () => { shutdowns++; });
    const file = path.join(h.root, 'damaged-selected.zip');
    fs.writeFileSync(file, 'not a ZIP archive');
    const result = await h.call('data-import', { file, scope: ['conversations'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /not a Camellia data package/);
    assert.equal(shutdowns, 0);
    assert.equal((await h.call('codex-account-state')).ok, true);
  } finally { h.cleanup(); }
});

test('new responses during import staging are rechecked without overwriting data or stopping them', async context => {
  const source = createHarness(), target = createHarness();
  try {
    source.configureApi();
    const file = path.join(source.root, 'staging-race.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: file });
    assert.equal((await source.call('data-export')).ok, true);
    const config = path.join(target.userData, 'desktop-config.json');
    fs.writeFileSync(config, '{"theme":"dark"}\n');
    let active = false, shutdowns = 0;
    const access = [];
    context.mock.method(target.api.sharedConversations, 'isBusy', () => active);
    context.mock.method(target.api.codex, 'shutdown', async () => { shutdowns++; });
    target.api.setWindow({ isDestroyed: () => false, webContents: { send(channel, state) {
      if (channel === 'dsh:data-migration-progress' && state.phase === 'import') {
        access.push(target.call('codex-account-state'));
        active = true;
      }
    } } });
    const result = await target.call('data-import', { file, scope: ['settings'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /Stop the current response/);
    assert.ok(access.length);
    for (const check of await Promise.all(access)) assert.equal(check.ok, true, check.error);
    assert.equal(shutdowns, 0);
    assert.equal(fs.readFileSync(config, 'utf8'), '{"theme":"dark"}\n');
    assert.equal(fs.existsSync(path.join(target.userData, 'migration-backups')), false);
    assert.equal((await target.call('codex-account-state')).ok, true);
  } finally { source.cleanup(); target.cleanup(); }
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(harness.home, '.dsh/ollama-proxy.json'), 'utf8')), { version: 2, ...JSON.parse(route) });
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
