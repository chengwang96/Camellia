'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settingsView, configure } = require('../src/main/remote/settings');

// Stands in for SharedConversations: one account model on the subscription
// connection, the shared API routes on the other, and a stateful selection so
// configure() can read back what it wrote.
function manager({ engine = 'codex', connection = 'subscription', model = 'account-a' } = {}) {
  const state = { connection, model, permissionMode: 'default', thinkingBudget: '', contextWindow: 0 };
  return { state,
    settings: () => ({ ...state }),
    busy: () => false,
    conversationModels: (name, selected) => selected.connection === 'subscription'
      ? (name === 'codex' ? [{ id: 'account-a', name: 'GPT account A', thinking: ['high'] }, { id: 'shared-id', name: 'Shared on account', thinking: [] }] : [])
      : [{ id: 'route-a', name: 'route-a', thinking: ['low'], contextWindow: 64000 },
        { id: 'shared-id', name: 'Shared on routes', thinking: ['low'], contextWindow: 32000 }],
    saveSettings: (name, patch) => {
      if (patch.connection !== undefined) state.connection = patch.connection;
      if (patch.model !== undefined) state.model = patch.model;
      if (patch.permissionMode !== undefined) state.permissionMode = patch.permissionMode;
      if (patch.thinkingBudget !== undefined) state.thinkingBudget = patch.thinkingBudget;
      if (patch.contextWindow !== undefined) state.contextWindow = patch.contextWindow;
    },
    onEvent: () => {} };
}

const view = (target, engine = 'codex') => settingsView(target, { id: 'c1', currentEngine: engine });
const choose = (target, changes, engine = 'codex') => configure(target, { id: 'c1', currentEngine: engine },
  { expectedSettings: view(target, engine).version, settings: changes });

test('a subscription conversation also offers the shared API routes', () => {
  const models = view(manager()).models;
  assert.equal(view(manager()).connection, 'subscription');
  // The active connection's list comes first and owns any duplicated id, so a
  // model can never be reported twice with conflicting labels or levels.
  assert.deepEqual(models.map(model => [model.id, model.connection]),
    [['account-a', 'subscription'], ['shared-id', 'subscription'], ['route-a', 'api']]);
  assert.deepEqual(models.find(model => model.id === 'route-a').thinking, ['low']);
});

test('an API conversation also offers the signed-in account models', () => {
  const models = view(manager({ connection: 'api', model: 'route-a' })).models;
  assert.deepEqual(models.map(model => [model.id, model.connection]),
    [['route-a', 'api'], ['shared-id', 'api'], ['account-a', 'subscription']]);
  assert.deepEqual(models.find(model => model.id === 'account-a').thinking, ['high']);
});

test('an account that is not signed in contributes no selectable models', () => {
  const signedOut = manager({ connection: 'api', model: 'route-a' });
  signedOut.conversationModels = (name, selected) => selected.connection === 'subscription' ? [] : [{ id: 'route-a', name: 'route-a', thinking: [] }];
  assert.deepEqual(view(signedOut).models.map(model => model.connection), ['api']);
});

test('engines with a single model source never merge the other connection', () => {
  assert.deepEqual(view(manager({ engine: 'claude', connection: 'api', model: 'route-a' }), 'claude').models
    .map(model => model.connection), ['api', 'api']);
});

test('picking a route model switches the conversation connection and clears stale levels', () => {
  const target = manager();
  choose(target, { model: 'account-a' });
  target.state.thinkingBudget = 'high';
  const result = choose(target, { model: 'route-a' });
  assert.equal(result.ok, true);
  assert.equal(target.state.connection, 'api');
  assert.equal(target.state.model, 'route-a');
  assert.equal(target.state.thinkingBudget, '');
  assert.equal(target.state.contextWindow, 64000);
  assert.equal(result.settings.connection, 'api');
  assert.deepEqual(result.settings.models.map(model => model.connection), ['api', 'api', 'subscription']);
});

test('picking an account model from an API conversation switches back to the subscription', () => {
  const target = manager({ connection: 'api', model: 'route-a' });
  const result = choose(target, { model: 'account-a' });
  assert.equal(target.state.connection, 'subscription');
  assert.equal(target.state.model, 'account-a');
  assert.equal(target.state.contextWindow, 0);
  assert.equal(result.settings.connection, 'subscription');
  assert.deepEqual(result.settings.models.map(model => model.id), ['account-a', 'shared-id', 'route-a']);
});

test('a duplicated id keeps the current connection instead of flapping', () => {
  const target = manager();
  const result = choose(target, { model: 'shared-id' });
  assert.equal(target.state.connection, 'subscription');
  assert.equal(target.state.model, 'shared-id');
  assert.equal(result.settings.connection, 'subscription');
});

test('an unknown model or unsupported connection still fails', async () => {
  const target = manager();
  assert.throws(() => choose(target, { model: 'missing' }), /unavailable/);
  assert.throws(() => choose(target, { thinking: 'low' }), /Unsupported thinking level/);
  assert.throws(() => choose(target, { connection: 'api' }), /Invalid settings/);
});
