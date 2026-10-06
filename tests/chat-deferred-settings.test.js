'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function fixture(overrides = {}) {
  const saved = [];
  const state = {
    sharedChat: true, context: { sessionId: 'conversation-a' }, harnessId: 'codex', sessionOpenSeq: 1,
    running: true, conversationActivity: null, pendingConversationSend: () => null, sending: false,
    loadingSession: false, switchingEngine: false, goalUI: { isActive: () => false },
    conversationBusy: () => state.running || Boolean(state.conversationActivity) || Boolean(state.pendingConversationSend()) || state.goalUI.isActive(),
    chatApi: { saveSettings: async patch => { saved.push(patch); return { ok: true, settings: { model: patch.model, thinkingBudget: patch.thinkingBudget, permissionMode: 'default' } }; } },
    levelLabel: level => level,
    applySessionSettings() {}, updateCtxRing() {}, applyApiLevels() {},
    visibleAccountModels: () => state.accountModels || [],
    setStatus(text) { state.status = text; },
    $: () => ({ value: '' }),
    LEVELS: [{}], routeModelCatalog: {},
    ...overrides,
  };
  vm.createContext(state);
  vm.runInContext(extract('  async function persistSettings(', '  function persistModel('), state);
  return { state, saved };
}

test('a model change is saved while the turn runs and applies to the next message', async () => {
  const { state, saved } = fixture();
  await state.persistSettings({ model: 'model-two' }, 'Model changed: model-two (applies to the next message)');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, 'model-two');
  assert.match(state.status, /applies to the next message/);
});

test('a reasoning level change is saved while the turn runs', async () => {
  const { state, saved } = fixture({ harnessId: 'claude' });
  await state.persistSettings({ thinkingBudget: 'high' }, 'Reasoning level changed: high (applies to the next message)');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].thinkingBudget, 'high');
});

test('process-level settings still wait for the turn to finish', async () => {
  const { state, saved } = fixture();
  await state.persistSettings({ permissionMode: 'plan' }, 'Permission mode saved. Applies to the next turn.');
  assert.deepEqual(saved, []);
  assert.equal(state.status, undefined);
});

test('a Fast mode change is saved while the current response is running', async () => {
  const { state, saved } = fixture();
  await state.persistSettings({ fastMode: true }, 'Fast mode enabled (applies to the next message)');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].fastMode, true);
  assert.equal(saved[0].sessionId, 'conversation-a');
});

test('deferred settings still save when the conversation is idle', async () => {
  const { state, saved } = fixture({ running: false });
  await state.persistSettings({ model: 'model-two' }, 'Model changed: model-two (applies to the next message)');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, 'model-two');
});

test('a settings response cannot overwrite the view after switching harnesses', async () => {
  let finish;
  const applied = [];
  const { state } = fixture({ chatApi: { saveSettings: () => new Promise(resolve => { finish = resolve; }) },
    applySessionSettings: settings => applied.push(settings) });
  const pending = state.persistSettings({ model: 'model-two' }, 'Saved');
  state.harnessId = 'kimi';
  finish({ ok: true, settings: { model: 'model-two' } });
  await pending;
  assert.deepEqual(applied, []);
  assert.equal(state.status, undefined);
});

test('quick switch never applies its reasoning level to a conversation opened during the model save', async () => {
  let finish;
  const levels = [];
  const { state } = fixture({ currentModel: 'model-one', currentLevel: 'low', LEVELS: [{ id: 'high' }],
    window: { dshDesktop: { workbenchSettings: async () => ({ ok: true, quickSwitchModels: { codex: 'model-two' }, quickSwitchLevels: { codex: 'high' } }) } },
    googleSubscription: () => false, modelSections: () => [{ options: [{ id: 'model-two' }] }],
    persistModel: () => new Promise(resolve => { finish = resolve; }), persistLevel: level => levels.push(level) });
  vm.runInContext(extract('  async function switchToDefaultModel()', '  async function persistSettings('), state);
  const pending = state.switchToDefaultModel();
  await new Promise(resolve => setImmediate(resolve));
  state.context.sessionId = 'conversation-b'; state.sessionOpenSeq++; state.currentModel = 'model-two';
  finish();
  await pending;
  assert.deepEqual(levels, []);
});

test('quick switch saves a supported model and reasoning level in one update', async () => {
  const { state, saved } = fixture({ currentConnection: 'api', routeModels: ['route-model'],
    accountModels: [{ id: 'account-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
    supportsAccounts: () => true, accountSubscription: () => false, googleSubscription: () => false,
    modelLabel: id => id, loadSettings: async () => {},
    window: { CamelliaModelLevels: { levelsFor: () => ['low', 'medium', 'high'] } } });
  vm.runInContext(extract('  function persistModel(', '  function persistLevel('), state);
  await state.persistModel('account-model', 'high');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, 'account-model');
  assert.equal(saved[0].connection, 'subscription');
  assert.equal(saved[0].thinkingBudget, 'high');
  await state.persistModel('route-model', 'ultra');
  assert.equal(saved.length, 2);
  assert.equal(saved[1].thinkingBudget, '', 'an unsupported level is not sent to the new model');
});

test('quick switch uses fetched routed levels and clears an unsupported effort for every API harness', async () => {
  for (const harnessId of ['codex', 'claude']) {
    const modelLevels = require('../src/shared/model-levels');
    const { state, saved } = fixture({ harnessId, currentConnection: 'api', routeModels: ['glm-5.3'], accountModels: [],
      routeModelCatalog: { modelThinking: { 'glm-5.3': { values: ['low', 'high', 'max'], default: 'max' } } },
      supportsAccounts: () => false, accountSubscription: () => false, googleSubscription: () => false,
      modelLabel: id => id, window: { CamelliaModelLevels: modelLevels } });
    vm.runInContext(extract('  function persistModel(', '  function persistLevel('), state);
    await state.persistModel('glm-5.3', 'max');
    assert.equal(saved[0].thinkingBudget, 'max');
    await state.persistModel('glm-5.3', 'medium');
    assert.equal(saved[1].thinkingBudget, '');
  }
});

function modelMenu(subscription, google = false) {
  const state = {
    supportsAccounts: () => true, sharedChat: true, context: { sessionId: 'conversation-a' },
    accountName: google ? 'Google' : 'Kimi', MODELS: [],
    accountModels: [{ id: 'shared-model', name: 'Shared model' }, { id: 'account-only', name: 'Account model' }],
    visibleAccountModels: () => state.accountModels,
    routeModels: ['shared-model', 'api-only'], routeModelCatalog: {},
    accountSubscription: () => subscription, googleSubscription: () => google,
  };
  vm.createContext(state);
  vm.runInContext(extract('  function modelSections()', '  function openModelMenu()'), state);
  return JSON.parse(JSON.stringify(state.modelSections()));
}

test('the Google subscription model menu opens with only its account models', () => {
  const sections = modelMenu(true, true);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, 'Model · Google account');
  assert.deepEqual(sections[0].options.map(model => model.id), ['shared-model', 'account-only']);
});

test('shared model IDs retain both connections with the active subscription first', () => {
  const sections = modelMenu(true);
  assert.deepEqual(sections.map(section => section.connection), ['subscription', 'api']);
  assert.deepEqual(sections.map(section => section.options.map(model => model.id)), [['shared-model', 'account-only'], ['shared-model', 'api-only']]);
});

test('shared model IDs retain both connections with the active API connection first', () => {
  const sections = modelMenu(false);
  assert.deepEqual(sections.map(section => section.connection), ['api', 'subscription']);
  assert.deepEqual(sections.map(section => section.options.map(model => model.id)), [['shared-model', 'api-only'], ['shared-model', 'account-only']]);
});
