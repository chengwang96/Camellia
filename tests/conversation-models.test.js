'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationModels } = require('../src/engines/conversation-models');
const { levelsFor } = require('../src/shared/model-levels');

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
