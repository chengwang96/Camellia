'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchModels } = require('../src/api/provider-accounts');
const { PRESETS, normalizeConfig, publicState } = require('../src/api/api-router-config');
const { createModelDiscovery } = require('../src/api/model-discovery');
const { levelsFor, labelFor } = require('../src/shared/model-levels');
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const preset = type => structuredClone(PRESETS.find(provider => provider.type === type));
const named = ['low', 'high', 'max'];

test('Command Code reads the official client catalog, preserves distinct models and exposes their exact efforts', async () => {
  const calls = [];
  // Schema and representative values from Command Code v1.88.2's same-host
  // /provider/v1/models?view=client catalog (2026-10-31).
  const entries = [
    { id: 'deepseek/deepseek-v4.1-flash', reasoningEfforts: ['off', ...named] },
    { id: 'deepseek/deepseek-v4-pro', reasoningEfforts: ['off', 'high', 'max'] },
    { id: 'moonshotai/Kimi-K3', reasoningEfforts: named },
    { id: 'zai-org/GLM-5.3', reasoningEfforts: named },
    { id: 'zai-org/GLM-5.2', reasoningEfforts: ['high', 'max'] },
    { id: 'claude-sonnet-4-6', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'moonshotai/Kimi-K2.7-Code', reasoningEfforts: null },
  ];
  const models = await fetchModels(preset('commandcode'), 'fixture-key', { fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.equal(options.redirect, 'error');
    return response({ data: entries });
  } });
  assert.deepEqual(calls, ['https://api.commandcode.ai/provider/v1/models?view=client']);
  assert.deepEqual(models.map(model => levelsFor(model.id, model)), [
    ['none', ...named], ['none', 'high', 'max'], named, named, ['high', 'max'],
    ['low', 'medium', 'high', 'xhigh', 'max'], [],
  ]);
  assert.equal(models[5].protocol, 'anthropic');
  assert.equal(models[0].upstream, entries[0].id);
  assert.equal(labelFor('none', models[0].id, models[0]), 'Off');
});

test('Command Code falls back to the standard catalog when the client view is unavailable or malformed', async () => {
  for (const client of [response({}, 404), response({ error: 'missing catalog' })]) {
    const calls = [];
    const models = await fetchModels(preset('commandcode'), 'fixture-key', { fetchImpl: async url => {
      calls.push(url);
      if (url.includes('?')) return client;
      if (url.endsWith('/models')) return response({ data: [{ id: 'moonshotai/Kimi-K3' }] });
      return response({}, 404);
    } });
    assert.equal(models.length, 1);
    assert.deepEqual(calls.slice(0, 2), ['https://api.commandcode.ai/provider/v1/models?view=client', 'https://api.commandcode.ai/provider/v1/models']);
    assert.equal(models[0].thinking, undefined);
  }
  const calls = [];
  await fetchModels({ ...preset('commandcode'), baseUrl: 'https://relay.example/v1' }, 'relay-only', { fetchImpl: async url => {
    calls.push(url); return response({ data: [] });
  } });
  assert.deepEqual(calls, ['https://relay.example/v1/models']);
});

test('the richer Command Code catalog does not add hidden models but can update an existing hidden route', async () => {
  const p = preset('commandcode');
  const entries = [{ id: 'moonshotai/Kimi-K3', reasoningEfforts: named },
    { id: 'legacy-model', hidden: true, reasoningEfforts: ['high'] }];
  const fetchImpl = async () => response({ data: entries });
  assert.deepEqual((await fetchModels(p, 'fixture-key', { fetchImpl })).map(model => model.upstream), ['moonshotai/Kimi-K3']);
  p.models = [{ id: 'legacy', upstream: 'legacy-model' }];
  const models = await fetchModels(p, 'fixture-key', { configuredOnly: true, fetchImpl });
  assert.deepEqual(models.map(model => model.upstream), ['legacy-model']);
  assert.deepEqual(models[0].thinking.values, ['high']);
});

test('OpenCode Zen and Go parse nested efforts, toggles and defaults without inventing named levels', async () => {
  for (const type of ['opencode', 'opencode-go']) {
    const entries = [
      { id: 'glm-5.3', capabilities: { reasoning: { supported: true, effort: named } } },
      { id: 'deepseek-v4.1-flash', capabilities: { reasoning: { supported: true, toggle: true, effort: named } } },
      { id: 'kimi-k2.6', capabilities: { reasoning: { supported: true, toggle: true } } },
      { id: 'kimi-k3.1-pro', capabilities: { reasoning: { supported: true, effort: named, default: { type: 'effort', value: 'max' } } } },
      { id: 'no-thinking', capabilities: { reasoning: { supported: false } } },
      { id: 'fixed-thinking', capabilities: { reasoning: { supported: true } } },
      { id: 'malformed', capabilities: { reasoning: { effort: ['high', 10] } } },
    ];
    const p = preset(type);
    const models = await fetchModels(p, 'fixture-key', { fetchImpl: async url =>
      url.endsWith('/models') ? response({ data: entries }) : response({}, 404) });
    assert.deepEqual(models.map(model => levelsFor(model.id, model)), [named, ['none', ...named], ['none', 'high'], named, [], [], []]);
    assert.equal(models[3].thinking.default, 'max');
    assert.equal(labelFor('high', models[2].id, models[2]), 'On');
    assert.equal(models[5].thinking, undefined);
    assert.equal(models[6].thinking, undefined);
  }
});

test('every built-in API preset has a verified thinking discovery path; QClaw stays runtime-managed', async () => {
  const cases = [
    ['ollama', 'glm-5.3:cloud', { thinking: { values: named } }, named],
    ['commandcode', 'moonshotai/Kimi-K3', { reasoningEfforts: named }, named],
    ['opencode', 'glm-5.3', { capabilities: { reasoning: { effort: named } } }, named],
    ['opencode-go', 'glm-5.3', { capabilities: { reasoning: { effort: ['high', 'max'] } } }, ['high', 'max']],
    ['kimi', 'kimi-k3.1-pro', {}, named],
    ['deepseek', 'deepseek-flash', {}, ['none', ...named]],
    ['kimi-code', 'k3.1-pro', {}, named],
    ...['mimo', 'mimo-token-plan-cn', 'mimo-token-plan-sgp', 'mimo-token-plan-ams'].map(type => [type, 'mimo-v2.6-pro', {}, ['none', 'high']]),
    ['gemini', 'gemini-3.8-flash', {}, ['low', 'medium', 'high']],
  ];
  assert.deepEqual([...cases.map(([type]) => type), 'qclaw'].sort(), PRESETS.filter(p => p.type !== 'custom').map(p => p.type).sort());
  for (const [type, upstream, metadata, expected] of cases) {
    const p = preset(type);
    p.models = [{ id: 'test-model', upstream }];
    const models = await fetchModels(p, 'fixture-key', { configuredOnly: true, fetchImpl: async (url, options) => {
      if (url.endsWith('/api/show')) { assert.equal(options.method, 'POST'); return response(metadata); }
      if (/\/models(?:\?|$)/.test(url)) return response({ data: [{ id: upstream, ...metadata }] });
      return response({}, 404);
    } });
    assert.deepEqual(levelsFor(models[0].id, models[0]), expected, type);
  }
  const discovery = createModelDiscovery({ getConfig: () => ({ providers: [{ ...preset('qclaw'), enabled: true, keys: [{ enabled: true }] }] }),
    fetchImpl: async () => assert.fail('QClaw is not a model metadata service'), apply: () => assert.fail('QClaw controls must stay runtime-managed') });
  try { await discovery.refresh(); } finally { discovery.close(); }
});

test('documented Kimi and Gemini controls are model-specific, respect live metadata and never transfer to relays', async () => {
  const cases = [
    ['https://api.moonshot.cn/v1', 'kimi-k2.6', ['none', 'high']],
    ['https://api.moonshot.ai/v1', 'kimi-k3', named],
    ['https://api.kimi.ai/coding/v1', 'k3.1-pro-highspeed', named],
    ['https://api.kimi.com/coding/v1', 'kimi-for-coding', named],
    ['https://api.kimi.com/coding/v1', 'kimi-for-coding-highspeed', []],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-pro', ['low', 'medium', 'high']],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash', ['none', 'low', 'medium', 'high']],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-flash-preview', ['minimal', 'low', 'medium', 'high']],
  ];
  for (const [baseUrl, upstream, expected] of cases) {
    for (const live of [undefined, { values: ['high'] }, { values: [] }]) {
      const models = await fetchModels({ baseUrl }, 'fixture-key', { fetchImpl: async url => url.endsWith('/models')
        ? response({ data: [{ id: upstream, ...(live ? { thinking: live } : {}) }, { id: 'future-unknown' }] }) : response({}, 404) });
      assert.deepEqual(levelsFor(upstream, models[0]), live?.values || expected);
      assert.equal(models[1].thinking, undefined);
    }
    const models = await fetchModels({ baseUrl: 'https://relay.example/v1', type: 'kimi' }, 'relay-only', { fetchImpl: async () => response({ data: [{ id: upstream }] }) });
    assert.equal(models[0].thinking, undefined);
  }
});

test('Kimi live support_efforts and capability flags take precedence over documentation', async () => {
  const models = await fetchModels(preset('kimi-code'), 'fixture-key', { fetchImpl: async () => response({ data: [
    { id: 'k3.1-pro', capabilities: ['always_thinking'], support_efforts: ['low', 'max'], default_effort: 'low' },
    { id: 'toggle', capabilities: ['thinking'], support_efforts: ['high', 'max'] },
  ] }) });
  assert.deepEqual(models[0].thinking, { values: ['low', 'max'], default: 'low' });
  assert.deepEqual(models[1].thinking, { values: ['none', 'high', 'max'] });
});

test('background Command Code discovery publishes levels for existing aliases without requiring a model refresh', async () => {
  const cfg = normalizeConfig({ providers: [{ ...preset('commandcode'), id: 'cc', keys: [{ key: 'fixture-key' }] }] });
  const discovery = createModelDiscovery({ getConfig: () => cfg, fetchImpl: async url => {
    assert.equal(url, 'https://api.commandcode.ai/provider/v1/models?view=client');
    return response({ data: cfg.providers[0].models.map(model => ({ id: model.upstream, reasoningEfforts: named })) });
  }, apply: (provider, models) => {
    for (const model of provider.models) model.thinking = models.find(found => found.upstream === model.upstream).thinking;
  } });
  try {
    await discovery.refresh();
    assert.deepEqual(levelsFor('glm-5.3', publicState(cfg)), named);
    assert.deepEqual(levelsFor('kimi-k3', publicState(cfg)), named);
    assert.equal(cfg.providers[0].models.length, preset('commandcode').models.length);
  } finally { discovery.close(); }
});
