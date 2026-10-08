'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalModelId } = require('../src/shared/model-names');
const { normalizeConfig, modelRoutes, modelContextWindow, publicState } = require('../src/api/api-router-config');

test('routing names normalize owner namespaces and case while preserving model distinctions', () => {
  for (const [upstream, id] of [
    ['openai/openai/gpt-6-astra', 'gpt-6-astra'], ['OpenAI/GPT-5.6-SOL', 'gpt-5.6-sol'],
    ['moonshotai/Kimi-K3', 'kimi-k3'], ['Kimi-K3:CLOUD', 'kimi-k3'],
    ['zai-org/GLM-5.3', 'glm-5.3'], ['deepseek-ai/DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash'],
    ['anthropic/Claude-Sonnet-4-6-20260101', 'claude-sonnet-4-6-20260101'],
    ['google/Gemini-3.5-Pro-Preview', 'gemini-3.5-pro-preview'], ['xiaomi/MiMo-V2.6-Pro', 'mimo-v2.6-pro'],
  ]) {
    assert.equal(canonicalModelId(upstream), id);
    assert.equal(canonicalModelId(id), id);
  }
  for (const id of ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-chat', 'deepseek-reasoner',
    'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3-latest',
    'vendor/Kimi-K3', 'private/openai/gpt-6-astra', 'openai/claude-sonnet-4-6', 'openclaw/main',
    'Custom-Route', 'models/gemini-3.5-pro', 'claude-sonnet-4.6']) {
    assert.equal(canonicalModelId(id), id);
  }
});

const provider = (id, models) => ({ id, baseUrl: 'https://example.test/v1', models,
  keys: [{ id: 'key-' + id, key: 'fixture-secret' }] });

test('loading old aliases groups routes, capacity and thinking without changing upstream names', () => {
  const cfg = normalizeConfig({ providers: [
    provider('relay', [{ id: 'openai/openai/gpt-6-astra', upstream: 'openai/openai/gpt-6-astra',
      contextWindow: 65536, thinking: { values: ['low', 'high', 'max'], default: 'max' } }]),
    provider('direct', [{ id: 'gpt-6-astra', upstream: 'GPT-6-Astra',
      contextWindow: 32768, thinking: { values: ['high', 'max'], default: 'high' } }]),
    provider('other', [{ id: 'gpt-6-sol', upstream: 'gpt-6-sol', contextWindow: 16384 }]),
  ] });
  assert.deepEqual(publicState(cfg).models, ['gpt-6-astra', 'gpt-6-sol']);
  assert.deepEqual(modelRoutes(cfg, 'OpenAI/GPT-6-Astra', 'openai').map(route => route.model.upstream),
    ['openai/openai/gpt-6-astra', 'GPT-6-Astra']);
  assert.equal(modelContextWindow(cfg, 'openai/gpt-6-astra'), 32768);
  assert.deepEqual(publicState(cfg).modelThinking['gpt-6-astra'], { values: ['high', 'max'] });
  assert.deepEqual(normalizeConfig(publicState(cfg), cfg), cfg);
});

test('alias migration combines usage and cooldowns once and keeps credentials and active routes', () => {
  const model = 'gpt-6-astra', alias = 'openai/openai/gpt-6-astra';
  const stats = { requests: 5, inputTokens: 50,
    byModel: { [alias]: { requests: 2, inputTokens: 20 }, [model]: { requests: 3, inputTokens: 30 } },
    daily: { '2026-10-07': { [alias]: { requests: 2 }, [model]: { requests: 3 } } },
    models: { [alias]: { until: 2000, reason: 'longer' }, [model]: { until: 1000, reason: 'shorter' } } };
  const cfg = normalizeConfig({ providers: [provider('relay', [{ id: alias, upstream: alias }])],
    active: { [alias]: 'key-relay' }, usage: { 'key-relay': stats } });
  const usage = cfg.usage['key-relay'];
  assert.equal(usage.requests, 5);
  assert.equal(usage.byModel[model].requests, 5);
  assert.equal(usage.byModel[model].inputTokens, 50);
  assert.equal(usage.daily['2026-10-07'][model].requests, 5);
  assert.deepEqual(usage.models, { [model]: { until: 2000, reason: 'longer' } });
  assert.deepEqual(cfg.active, { [model]: 'key-relay' });
  assert.deepEqual(normalizeConfig(cfg), cfg);
});

test('distinct upstream routes can share a model on one provider without being lost on reload', () => {
  const cfg = normalizeConfig({ providers: [provider('relay', [
    { id: 'openai/gpt-6-astra', upstream: 'openai/gpt-6-astra', maxContext: 65536 },
    { id: 'gpt-6-astra', upstream: 'gpt-6-astra', maxContext: 32768 },
    { id: 'team-model', upstream: 'private/GPT-Custom' },
  ])] });
  assert.equal(modelRoutes(cfg, 'gpt-6-astra', 'openai').length, 2);
  assert.equal(modelContextWindow(cfg, 'gpt-6-astra'), 32768);
  assert.deepEqual(normalizeConfig(cfg), cfg);
  const duplicate = structuredClone(cfg);
  duplicate.providers[0].models.push({ ...duplicate.providers[0].models[0] });
  assert.throws(() => normalizeConfig(duplicate), /duplicate/);
});
