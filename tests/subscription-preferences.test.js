'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');
const { writeJson } = require('../src/shared/json-store');
const { createGoogleAccount } = require('../src/engines/antigravity/subscription');

test('quota switching persists independently for each subscription', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  assert.equal((await h.call('subscription-preferences-get', { engine: 'codex' })).preferences.autoSwitchQuota, true);
  assert.equal((await h.call('subscription-preferences-save', { engine: 'codex', preferences: { autoSwitchQuota: false } })).ok, true);
  assert.equal((await h.call('subscription-preferences-get', { engine: 'codex' })).preferences.autoSwitchQuota, false);
  assert.equal((await h.call('subscription-preferences-get', { engine: 'kimi' })).preferences.autoSwitchQuota, true);
  assert.equal((await h.call('subscription-preferences-save', { engine: 'kimi', preferences: { autoSwitchQuota: 'yes' } })).ok, false);
});

for (const engine of ['kimi', 'codex', 'antigravity']) test(`${engine} login preferences never save native configuration or change connection`, async context => {
  const harness = createHarness(); context.after(() => harness.cleanup());
  await harness.call(engine + '-save-settings', { connection: 'api' });
  const before = await harness.call('engine-settings-get', { engine });
  const preferences = engine === 'kimi' ? { region: 'global' } : { proxyUrl: 'http://localhost:12345' };
  const result = await harness.call('subscription-preferences-save', { engine, preferences: { ...preferences, permissionMode: 'bypassPermissions' } });
  assert.equal(result.ok, true, result.error);
  const after = await harness.call('engine-settings-get', { engine });
  assert.equal(after.desktop.connection, 'api');
  assert.equal(after.desktop.permissionMode, before.desktop.permissionMode);
  assert.deepEqual(after.files, before.files);
  assert.equal((await harness.call('subscription-preferences-get', { engine })).preferences[engine === 'kimi' ? 'region' : 'proxyUrl'], engine === 'kimi' ? 'global' : 'http://localhost:12345/');
  const invalid = await harness.call('subscription-preferences-save', { engine, preferences: engine === 'kimi' ? { region: 'invalid' } : { proxyUrl: 'not a URL' } });
  assert.equal(invalid.ok, false);
});

// A session pins its own connection when it starts; the starting connection for
// the next new session follows the composer's model pick, not a page selector.
for (const engine of ['kimi', 'codex', 'antigravity']) test(`${engine} starting connection changes without overwriting engine settings`, async context => {
  const harness = createHarness(); context.after(() => harness.cleanup());
  await harness.call(engine + '-save-settings', { connection: 'api', model: 'api-model' });
  const before = await harness.call('engine-settings-get', { engine });
  const switched = await harness.call('subscription-preferences-save', { engine, preferences: { connection: 'subscription' } });
  assert.equal(switched.ok, true, switched.error);
  assert.equal(switched.preferences.connection, 'subscription');
  const settings = await harness.call(engine + '-get-settings');
  assert.equal(settings.permissionMode, before.desktop.permissionMode);
  assert.equal(settings.apiModel, 'api-model');
  const invalid = await harness.call('subscription-preferences-save', { engine, preferences: { connection: 'invalid' } });
  assert.equal(invalid.ok, false);
  if (engine === 'antigravity') {
    const stale = await harness.call('engine-settings-save', { engine, files: before.files, common: {}, desktop: {}, expectedConnection: 'api' });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /connection changed/);
  } else {
    const saved = await harness.call('engine-settings-save', { engine, files: before.files, common: {}, desktop: {} });
    assert.equal(saved.ok, true, saved.error);
    assert.equal((await harness.call(engine + '-get-settings')).connection, 'subscription');
  }
});

test('Google credit billing is configured in subscriptions and preserved by engine edits', async context => {
  const harness = createHarness(); context.after(() => harness.cleanup());
  const file = path.join(harness.home, '.gemini/antigravity-cli/settings.json');
  const original = { modelProvider: 'gemini', agentMode: 'default', permissions: { deny: ['command(rm *)'] } };
  writeJson(file, original);
  const result = await harness.call('subscription-preferences-save', { engine: 'antigravity', preferences: { useG1Credits: true, connection: 'subscription' } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...original, useG1Credits: true });
  const state = await harness.call('engine-settings-get', { engine: 'antigravity' });
  assert.ok(state.fields.every(field => field.key !== 'useG1Credits'));
  assert.equal(JSON.parse(state.files[0].text).useG1Credits, undefined);
  const saved = await harness.call('engine-settings-save', { engine: 'antigravity', files: state.files, common: { agentMode: 'plan' }, desktop: {} });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(JSON.parse(fs.readFileSync(file)).useG1Credits, true);
});

test('Google distinguishes unverified, pending, verified, stale and failed validation', async context => {
  const harness = createHarness(); context.after(() => harness.cleanup());
  const home = harness.folder('google-account'), cliSettingsFile = path.join(home, 'cli.json');
  writeJson(cliSettingsFile, {});
  let time = 1000, fail = false;
  const account = createGoogleAccount({ home, cliSettingsFile, settings: () => ({}), environment: () => ({}),
    runtime: () => ({ locate: () => ({ file: 'agy' }), ensure: async () => ({ file: 'agy' }) }),
    openLogin: async () => {}, now: () => time,
    run: async () => { if (fail) throw new Error('offline'); return 'gemini-test\tGemini Test'; } });
  assert.equal(account.state().verification, 'unverified');
  await account.signIn();
  assert.equal(account.state().verification, 'pending');
  await account.refresh();
  assert.equal(account.state().verification, 'verified');
  time += 24 * 60 * 60 * 1000;
  assert.equal(account.state().verification, 'stale');
  fail = true;
  await assert.rejects(account.refresh(), /offline/);
  assert.equal(account.state().verification, 'error');
  assert.equal(account.state().verifiedAt, null);
  assert.deepEqual(account.state().models, []);
  writeJson(path.join(home, 'google-account.json'), { models: [{ id: 'test' }], verifiedAt: time });
  writeJson(cliSettingsFile, { modelProvider: 'gemini' });
  await assert.rejects(account.refresh(), /API provider/);
  assert.equal(account.state().verification, 'error');
  assert.equal(account.state().verifiedAt, null);
  assert.ok(fs.existsSync(cliSettingsFile));
});
