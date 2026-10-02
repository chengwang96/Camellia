'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discussionCatalog, apiAccountRef } = require('../src/engines/discussions/catalog');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');

test('API model choices bind the provider once regardless of its key pool', async () => {
  const model = { id: 'same-model', upstream: 'upstream-a', protocol: 'openai', contextWindow: 64000 };
  const provider = { id: 'provider-a', name: 'Provider A', enabled: true, baseUrl: 'https://a.example/v1',
    protocol: 'openai', models: [model], keys: [{ id: 'key-a', name: 'Account A', enabled: true, key: 'private-value-a' },
      { id: 'key-b', name: 'Account B', enabled: true, key: 'private-value-b' }] };
  const config = { enabled: true, providers: [provider, { ...provider, id: 'disabled', enabled: false }] };
  const sources = { router: () => config, codex: { accountState: () => ({ accounts: [] }) },
    antigravity: { handlers: { 'account-state': () => ({ accounts: [] }) } } };
  const rows = await discussionCatalog(sources);
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map(row => bindingFingerprint(row.binding))).size, 6);
  assert.deepEqual([...new Set(rows.map(row => row.binding.engine))], ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']);
  assert.ok(rows.every(row => row.binding.contextWindow === 64000));
  assert.ok(rows.every(row => row.providerId === provider.id && row.providerLabel === provider.name));
  assert.ok(rows.every(row => row.accountLabel === provider.name));
  for (const value of ['private-value', 'keyId', 'Account A', 'Account B']) assert.ok(!JSON.stringify(rows).includes(value));
  const original = apiAccountRef(provider, model);
  assert.notEqual(original, apiAccountRef({ ...provider, baseUrl: 'https://changed.example/v1' }, model));
  assert.notEqual(original, apiAccountRef(provider, { ...model, upstream: 'changed-model' }));
  provider.keys.reverse(); provider.keys[0].enabled = false;
  assert.deepEqual(await discussionCatalog(sources), rows, 'key order or disabling one key cannot change model bindings');
  provider.keys[1].enabled = false;
  assert.deepEqual(await discussionCatalog(sources), [], 'a provider still needs an enabled credential');
  config.enabled = false;
  assert.deepEqual(await discussionCatalog(sources), []);
});

test('three Ollama keys and three models produce three choices per harness', async () => {
  const provider = { id: 'ollama', name: 'Ollama Cloud', enabled: true, baseUrl: 'https://example.test/v1',
    keys: [1, 2, 3].map(n => ({ id: 'key-' + n, name: 'weekly-' + n, enabled: true })),
    models: ['kimi-k3', 'deepseek-v4-pro', 'deepseek-v4.1-flash'].map(id => ({ id, upstream: id })) };
  const rows = await discussionCatalog({ router: () => ({ enabled: true, providers: [provider] }) });
  for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']) {
    const choices = rows.filter(row => row.binding.engine === engine);
    assert.deepEqual(choices.map(row => row.label), provider.models.map(m => m.id));
    assert.ok(choices.every(row => row.accountLabel === 'Ollama Cloud'));
  }
});

test('subscription model choices keep distinct accounts and the model list from each account', async () => {
  const accounts = [{ id: 'one', label: 'First' }, { id: 'two', label: 'Second' }];
  const rows = await discussionCatalog({ router: () => ({ enabled: false, providers: [] }),
    codex: { accountState: id => ({ accounts, account: {}, models: id ? [{ id: 'model-' + id, contextWindow: 100000 }] : [] }) },
    antigravity: { handlers: { 'account-state': () => ({ accounts: [{ id: 'google', label: 'Google' }], models: [{ id: 'gemini-test', contextWindow: 200000 }] }) } } });
  assert.deepEqual(rows.map(row => [row.binding.accountRef, row.binding.model]), [['one', 'model-one'], ['two', 'model-two'], ['google', 'gemini-test']]);
});

test('Codex subscription budget uses the same native catalog as its managed text policy', async () => {
  const rows = await discussionCatalog({ router: () => ({ enabled: false, providers: [] }),
    codex: { accountState: () => ({ accounts: [{ id: 'default' }], account: {}, models: [{ id: 'gpt-6-astra' }, { id: 'unknown-model' }] }) },
    antigravity: { handlers: { 'account-state': () => ({ accounts: [] }) } } });
  assert.equal(rows[0].binding.contextWindow, require('../src/engines/codex-metadata/models.json').models.find(m => m.slug === 'gpt-6-astra').context_window);
  assert.equal(rows[1].binding.contextWindow, require('../src/api/context-capacity').UNKNOWN_CONTEXT_BUDGET,
    'models without capacity metadata use the ordinary chat working budget');
});

test('Google subscription models without capacity metadata can be used for discussion', async () => {
  const rows = await discussionCatalog({ router: () => ({ enabled: false, providers: [] }),
    antigravity: { handlers: { 'account-state': () => ({ accounts: [{ id: 'google' }], models: [{ id: 'gemini-test' }] }) } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].binding.contextWindow, require('../src/api/context-capacity').UNKNOWN_CONTEXT_BUDGET);
});

test('all enabled providers stay distinct even when their public model names match', async () => {
  const names = ['Ollama Cloud', 'nVidia', 'DeepSeek', 'MiMo', 'QClaw'];
  const config = { enabled: true, providers: names.map((name, i) => ({
    id: 'provider-' + i, name, enabled: true, baseUrl: 'http://127.0.0.1/' + i, protocol: 'openai',
    keys: [{ id: 'key-' + i, name: 'Account', enabled: true }], models: [{ id: 'shared-model', upstream: 'native-' + i, contextWindow: 64000 }],
  })) };
  const rows = await discussionCatalog({ router: () => config, codex: { accountState: () => ({ accounts: [] }) },
    antigravity: { handlers: { 'account-state': () => ({ accounts: [] }) } } });
  for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']) {
    const choices = rows.filter(row => row.binding.engine === engine);
    assert.deepEqual(choices.map(row => row.providerLabel), names);
    assert.equal(new Set(choices.map(row => bindingFingerprint(row.binding))).size, names.length);
    for (const row of choices) assert.equal(JSON.parse(row.binding.accountRef).providerId, row.providerId);
  }
});

test('Kimi subscriptions enumerate every account using that account model catalog', async () => {
  const accounts = [{ id: 'default', label: 'First Kimi' }, { id: 'account-2', label: 'Second Kimi' }];
  const rows = await discussionCatalog({ router: () => ({ enabled: false, providers: [] }),
    kimi: { state: id => ({ accounts, account: {}, models: id ? [{ id: 'kimi-' + id, contextWindow: 128000 }] : [] }) } });
  assert.deepEqual(rows.map(row => [row.binding.engine, row.binding.accountRef, row.binding.model]),
    [['kimi', 'default', 'kimi-default'], ['kimi', 'account-2', 'kimi-account-2']]);
  assert.ok(rows.every(row => row.binding.contextWindow === 128000));
});
