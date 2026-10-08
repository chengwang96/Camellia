'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeConfig, publicState } = require('../src/api/api-router-config');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
const provider = () => ({ id: 'provider', type: 'custom', name: 'Local', enabled: true, priority: 0,
  baseUrl: 'http://127.0.0.1:19099/v1', protocol: 'openai',
  models: [{ id: 'model', upstream: 'model' }], keys: [{ id: 'key', key: 'initial-secret', enabled: true, name: '' }] });

function harness({ beforeSave = async () => {}, insights = async () => ({ ok: true, keys: {}, providers: {} }) } = {}) {
  let stored = normalizeConfig({ providers: [provider()] });
  const snapshots = [], elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '', hidden: false,
      classList: { contains: () => false } });
    return elements.get(id);
  };
  const sandbox = { structuredClone, console, module: { exports: {} },
    setTimeout: () => 1, clearTimeout() {},
    document: { getElementById: element, querySelector: () => null },
    window: { CamelliaI18n: { locale: 'en-US' }, CamelliaModelNames: require('../src/shared/model-names'), dshDesktop: {
      apiRouterSaveConfig: async snapshot => {
        snapshots.push(structuredClone(snapshot));
        await beforeSave(snapshot, snapshots.length);
        stored = normalizeConfig(snapshot, stored);
        return { ok: true, state: publicState(stored) };
      }, providerInsights: insights,
    } }, showLive() {}, updateKeyStats() {}, renderRoutes() {}, renderProviders() {}, renderKeys() {}, renderModelChips() {} };
  vm.runInNewContext(source.slice(0, source.indexOf('function setView(')) + `
    module.exports = { initialize(state) { live = structuredClone(state); config = structuredClone(state); rememberSavedModels(); },
      get config() { return config; }, get dirty() { return isDirty(); }, draftComplete, edited, flushSave, assertClean };
  `, sandbox);
  const autosave = sandbox.module.exports;
  autosave.initialize(publicState(stored));
  return { autosave, snapshots, get stored() { return stored; }, get status() { return element('status'); } };
}

test('blank key and model rows do not block provider edits or enter the saved configuration', async () => {
  const state = harness(), draft = state.autosave.config.providers[0];
  draft.name = 'Renamed';
  draft.keys.push({ id: 'blank', key: '', name: '', enabled: true });
  draft.models.push({ id: '', upstream: '', protocol: 'auto' });
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].name, 'Renamed');
  assert.equal(state.stored.providers[0].keys.length, 1);
  assert.equal(state.stored.providers[0].models.length, 1);
  assert.equal(draft.keys.length, 2);
  assert.equal(draft.models.length, 2);
  assert.equal(state.autosave.dirty, false);
});

test('routing switch edits save together with provider drafts and survive an in-flight save', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const state = harness({ beforeSave: async (_snapshot, count) => {
    if (count === 1) { started(); await pending; }
  } });
  state.autosave.config.providers[0].models.push({ id: 'unfinished', upstream: '' });
  state.autosave.config.routing.multiKeyConcurrency = false;
  state.autosave.edited();
  const save = state.autosave.flushSave();
  await began;
  state.autosave.config.routing.multiKeyFailover = false;
  state.autosave.edited();
  release(); await save;
  assert.equal(state.snapshots.length, 2);
  assert.deepEqual(state.stored.routing, { multiKeyConcurrency: false, multiKeyFailover: false });
  assert.equal(state.stored.providers[0].models.length, 1);
  assert.equal(state.autosave.config.providers[0].models.length, 2);
  assert.equal(state.autosave.dirty, false);
});

test('partially typed new models stay in the editor while complete changes save', async () => {
  const state = harness(), draft = state.autosave.config.providers[0];
  draft.models.push({ id: 'new-model', upstream: '' });
  draft.priority = 1;
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].priority, 1);
  assert.equal(state.stored.providers[0].models.length, 1);
  assert.equal(state.autosave.draftComplete(), false);
  assert.match(state.status.textContent, /Complete the API URL/);
  draft.models[1].upstream = 'upstream-new-model';
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].models[1].upstream, 'upstream-new-model');
  assert.equal(state.autosave.draftComplete(), true);
});

test('incomplete saved model edits keep their last saved mapping', async () => {
  const state = harness(), draft = state.autosave.config.providers[0];
  draft.models[0].id = '';
  draft.models[0].upstream = '';
  draft.name = 'Changed';
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].name, 'Changed');
  assert.equal(state.stored.providers[0].models[0].id, 'model');
  assert.equal(state.autosave.draftComplete(), false);
  draft.models[0].id = 'renamed-model';
  draft.models[0].upstream = 'renamed-upstream';
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].models[0].id, 'renamed-model');
});

test('unfinished custom provider URLs do not block saving other providers', async () => {
  const state = harness();
  state.autosave.config.providers[0].name = 'Changed';
  state.autosave.config.providers.push({ ...provider(), id: 'new-provider', baseUrl: '', keys: [], models: [] });
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers.length, 1);
  assert.equal(state.stored.providers[0].name, 'Changed');
  assert.equal(state.autosave.draftComplete(), false);
});

test('edits during an in-flight save survive and the newest secret is saved then masked', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const state = harness({ beforeSave: async (_snapshot, count) => {
    if (count === 1) { started(); await pending; }
  } });
  const draft = state.autosave.config.providers[0];
  draft.keys[0].key = 'first-new-secret';
  state.autosave.edited();
  const save = state.autosave.flushSave();
  await began;
  draft.keys[0].key = 'latest-new-secret';
  draft.name = 'Latest name';
  state.autosave.edited();
  release();
  await save;
  assert.equal(state.snapshots.length, 2);
  assert.equal(state.stored.providers[0].keys[0].key, 'latest-new-secret');
  assert.equal(state.stored.providers[0].name, 'Latest name');
  assert.equal(draft.keys[0].key, '');
  assert.equal(state.autosave.dirty, false);
});

test('an edit during an insights refresh is saved before the flush completes', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const state = harness({ insights: async () => {
    if (++calls === 1) { started(); await pending; }
    return { ok: true, keys: {}, providers: {} };
  } });
  const draft = state.autosave.config.providers[0];
  draft.keys[0].key = 'first-new-secret';
  state.autosave.edited();
  const save = state.autosave.flushSave();
  await began;
  draft.keys[0].key = 'secret-entered-during-refresh';
  state.autosave.edited();
  release();
  await save;
  assert.equal(draft.keys[0].key, '');
  assert.equal(state.autosave.dirty, false);
  assert.equal(state.stored.providers[0].keys[0].key, 'secret-entered-during-refresh');
});

test('an incomplete edit during a save keeps the just-saved model rather than reverting an older mapping', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const state = harness({ beforeSave: async (_snapshot, count) => {
    if (count === 1) { started(); await pending; }
  } });
  const draft = state.autosave.config.providers[0];
  draft.models[0].id = 'renamed';
  draft.models[0].upstream = 'renamed-upstream';
  state.autosave.edited();
  const save = state.autosave.flushSave();
  await began;
  draft.models[0].id = '';
  state.autosave.edited();
  release();
  await save;
  assert.equal(state.stored.providers[0].models[0].id, 'renamed');
  assert.equal(state.stored.providers[0].models[0].upstream, 'renamed-upstream');
});

test('automatic save failures stay visible and dirty, and a later correction retries successfully', async () => {
  let failing = true;
  const state = harness({ beforeSave: async () => { if (failing) throw new Error('Disk is unavailable'); } });
  state.autosave.config.providers[0].name = 'Changed';
  state.autosave.edited();
  await state.autosave.flushSave(false);
  assert.equal(state.autosave.dirty, true);
  assert.equal(state.status.className, 'error');
  assert.equal(state.status.textContent, 'Disk is unavailable');
  await assert.rejects(state.autosave.assertClean(), /Disk is unavailable/);
  failing = false;
  await state.autosave.flushSave();
  assert.equal(state.autosave.dirty, false);
  assert.equal(state.stored.providers[0].name, 'Changed');
});

test('saved models retain their normalized mapping when a later edit is incomplete', async () => {
  const state = harness(), draft = state.autosave.config.providers[0];
  draft.models[0].id = ' renamed:cloud ';
  draft.models[0].upstream = ' renamed-upstream ';
  state.autosave.edited();
  await state.autosave.flushSave();
  draft.models[0].upstream = '';
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].models[0].id, 'renamed');
  assert.equal(state.stored.providers[0].models[0].upstream, 'renamed-upstream');
});

test('an insights error does not turn a completed API save into a persistence failure', async () => {
  const state = harness({ insights: async () => { throw new Error('Account status unavailable'); } });
  state.autosave.config.providers[0].name = 'Persisted';
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].name, 'Persisted');
  assert.equal(state.autosave.dirty, false);
  await state.autosave.assertClean();
  assert.equal(state.status.textContent, 'Account status unavailable');
});

test('owner-prefixed model drafts retain their saved mapping through incomplete edits', async () => {
  const state = harness(), draft = state.autosave.config.providers[0];
  draft.models[0].id = 'openai/openai/GPT-6-Astra';
  draft.models[0].upstream = 'provider-specific-gpt';
  state.autosave.edited();
  await state.autosave.flushSave();
  draft.models[0].upstream = '';
  state.autosave.edited();
  await state.autosave.flushSave();
  assert.equal(state.stored.providers[0].models[0].id, 'gpt-6-astra');
  assert.equal(state.stored.providers[0].models[0].upstream, 'provider-specific-gpt');
});
