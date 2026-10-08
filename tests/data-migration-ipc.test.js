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

test('the settings handlers export and re-import a profile package', async t => {
  const source = createHarness();
  const target = createHarness();
  try {
    source.configureApi();
    const packageFile = path.join(source.root, 'camellia-data-package.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: packageFile });
    const exported = await source.call('data-export');
    assert.equal(exported.ok, true);
    assert.equal(exported.canceled, undefined);
    assert.equal(fs.existsSync(packageFile), true);
    assert.equal(exported.files > 0, true);

    // The first call only reads the package and reports its categories; no
    // dialog is shown, so the settings page can offer a real multi-select.
    const preview = await target.call('data-import', { file: packageFile });
    assert.equal(preview.ok, true);
    assert.equal(preview.needsSelection, true);
    assert.deepEqual(preview.categories, exported.categories);
    assert.equal(preview.categories.api.files > 0, true);
    assert.equal(preview.categories.settings.files > 0, true);
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

test('choosing settings only restores settings and skips API keys and conversations', async t => {
  const source = createHarness();
  const target = createHarness();
  try {
    source.configureApi();
    const packageFile = path.join(source.root, 'camellia-data-package.zip');
    source.dialogBehavior.save = async () => ({ canceled: false, filePath: packageFile });
    await source.call('data-export');
    const imported = await target.call('data-import', { file: packageFile, scope: ['settings'] });
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.scope, ['settings']);
    // API keys are not part of the settings category.
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
