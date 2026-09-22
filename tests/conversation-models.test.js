'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationModels } = require('../src/engines/conversation-models');
const { levelsFor } = require('../src/shared/model-levels');
const { modelContextWindow } = require('../src/api/api-router-config');

test('context limits use catalog metadata, honor overrides and exclude inactive routes', () => {
  const config = { enabled: true, providers: [
    { enabled: false, keys: [{ enabled: true }], models: [{ id: 'model', contextWindow: 8192 }] },
    { enabled: true, keys: [{ enabled: false }], models: [{ id: 'model', contextWindow: 16384 }] },
    { enabled: true, keys: [{ enabled: true }], models: [{ id: 'model', maxContext: 1000000 }] },
  ] };
  assert.equal(modelContextWindow(config, 'model'), 1000000);
  assert.equal(conversationModels('codex', {}, { router: () => config })[0].contextWindow, 1000000);
  config.providers[2].models[0].contextWindow = 128000;
  assert.equal(modelContextWindow(config, 'model'), 128000);
  config.providers.push({ enabled: true, keys: [{ enabled: true }], models: [{ id: 'model', maxContext: 64000 }] });
  assert.equal(modelContextWindow(config, 'model'), 64000);
  assert.equal(modelContextWindow(config, 'unknown'), undefined);
  config.enabled = false;
  assert.equal(modelContextWindow(config, 'model'), undefined);
});

test('conversation API catalog follows enabled routes and UI efforts without disclosing credentials', () => {
  const config = { enabled: true, providers: [
    { enabled: true, keys: [{ enabled: true, key: 'secret' }], models: [{ id: 'configured', contextWindow: 64000 }] },
    { enabled: false, keys: [{ enabled: true, key: 'hidden' }], models: [{ id: 'disabled' }] },
    { enabled: true, keys: [{ enabled: false }], models: [{ id: 'no-key' }] },
  ] };
  const sources = { router: () => config };
  assert.deepEqual(conversationModels('claude', {}, sources), [{ id: 'configured', name: 'configured', thinking: levelsFor('configured'), contextWindow: 64000 }]);
  assert.ok(!JSON.stringify(conversationModels('codex', {}, sources)).includes('secret'));
  config.enabled = false;
  assert.deepEqual(conversationModels('codex', {}, sources), []);
});

test('subscription catalog uses account metadata, never API guesses or account secrets', () => {
  const sources = { codex: () => ({ account: { token: 'secret' }, models: [{ id: 'account-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }),
    kimi: () => ({ account: {}, models: [{ id: 'kimi-model', contextWindow: 100000 }] }) };
  assert.deepEqual(conversationModels('codex', { connection: 'subscription' }, sources), [{ id: 'account-model', name: 'account-model', thinking: ['high'] }]);
  assert.deepEqual(conversationModels('kimi', { connection: 'subscription' }, sources), [{ id: 'kimi-model', name: 'kimi-model', thinking: [], contextWindow: 100000 }]);
  sources.codex = () => ({ account: null, models: [{ id: 'stale' }] });
  assert.deepEqual(conversationModels('codex', { connection: 'subscription' }, sources), []);
});
