'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { removeTree } = require('./test-fs.cjs');
const pricing = require('../src/api/subscription-pricing');
const bundled = require('../src/api/subscription-prices.json');
const { createPriceRefresh, transformCatalog } = require('../src/api/subscription-price-catalog');
const { createSubscriptionUsage } = require('../src/api/subscription-usage');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-price-refresh-'));
  t.after(() => { pricing.installCatalog(bundled, 'bundled'); delete pricing.catalogInfo.error; removeTree(root); });
  const upstream = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['gpt-5-fixture-' + i, {
    litellm_provider: 'openai', input_cost_per_token: 0.000002, output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.0000001,
  }]));
  return { root, upstream, file: path.join(root, 'prices.json') };
}
test('catalog refresh coalesces requests, saves a validated cache and survives restart offline', async t => {
  const f = fixture(t); let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createPriceRefresh({ file: f.file, fetcher: async () => { calls++; await gate; return new Response(JSON.stringify(f.upstream)); } });
  const first = service.refresh({ force: true }), second = service.refresh({ force: true });
  release(); assert.equal((await first).ok, true); assert.equal((await second).ok, true); assert.equal(calls, 1);
  assert.equal(pricing.priceFor('gpt-5-fixture-0').input, 2);
  const saved = fs.readFileSync(f.file, 'utf8');
  const restarted = createPriceRefresh({ file: f.file, fetcher: async () => { throw new Error('Offline'); } });
  assert.equal((await restarted.refresh({ force: true })).ok, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved); assert.equal(pricing.priceFor('gpt-5-fixture-0').input, 2);
});
test('invalid catalogs never replace the last good rates and context tiers remain request specific', async t => {
  const f = fixture(t), original = pricing.priceFor('gpt-6.1-sol');
  const service = createPriceRefresh({ file: f.file, fetcher: async () => new Response('{"not-a-catalog":true}') });
  assert.equal((await service.refresh({ force: true })).ok, false); assert.equal(pricing.priceFor('gpt-6.1-sol'), original);
  assert.equal(fs.existsSync(f.file), false);
  f.upstream['gpt-5-fixture-0'].input_cost_per_token_above_200k_tokens = 0.000004;
  f.upstream['gpt-5-fixture-0'].output_cost_per_token_above_200k_tokens = 0.00002;
  const catalog = transformCatalog(f.upstream); pricing.installCatalog(catalog);
  assert.equal(pricing.estimateTokens('gpt-5-fixture-0', { input: 200001, output: 1 }), (200001 * 4 + 20) / 1e6);
  assert.equal(pricing.estimateTokens('gpt-5-fixture-0', { input: 200001, output: 1, aggregate: true }), null);
});
test('new unpriced request metadata can be repriced once; legacy aggregate tokens stay unknown', t => {
  const f = fixture(t), file = path.join(f.root, 'usage.json');
  const store = createSubscriptionUsage({ file });
  store.record({ id: 'pending', engine: 'codex', model: 'gpt-5-fixture-0', samples: [{ input: 1000, output: 100, cacheRead: 400 }] });
  const saved = JSON.parse(fs.readFileSync(file));
  const usage = saved.accounts['codex:default'].usage;
  // Old usage predates the request journal. Its 250 unknown tokens cannot be guessed.
  usage.unpricedTokens += 250; fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = createSubscriptionUsage({ file }); pricing.installCatalog(transformCatalog(f.upstream));
  assert.equal(restarted.reprice(), true); assert.equal(restarted.reprice(), false);
  const stats = restarted.state().accounts[0].usage;
  assert.equal(stats.requests, 1); assert.equal(stats.unpricedTokens, 250); assert.equal(stats.pricedTokens, 1100);
  assert.equal(stats.estimatedCostUsd, (600 * 2 + 100 * 10 + 400 * 0.1) / 1e6);
  assert.equal(stats.byModel['gpt-5-fixture-0'].unpricedTokens, 0);
});

test('Antigravity Opus thinking uses the canonical catalog price for new usage, cache and reasoning', t => {
  const f = fixture(t), model = 'claude-opus-4-6-thinking';
  assert.equal(pricing.priceFor(model), pricing.priceFor('claude-opus-4-6'));
  const rates = { input: 7, output: 30, cacheRead: .7, cacheWrite: 8.75 };
  pricing.installCatalog({ ...bundled, models: { ...bundled.models, 'claude-opus-4-6': rates } });
  assert.equal(pricing.priceFor(model), rates, 'the alias follows refreshed canonical rates');
  const sample = { input: 50841, output: 582, cacheRead: 30799, reasoning: 400, aggregate: true };
  const expected = (20042 * rates.input + 582 * rates.output + 30799 * rates.cacheRead) / 1e6;
  assert.equal(pricing.estimateTokens(model, sample), expected);
  const store = createSubscriptionUsage({ file: path.join(f.root, 'usage.json') });
  store.record({ id: 'antigravity-thinking', engine: 'antigravity', model, samples: [sample] });
  const usage = store.state().accounts[0].usage;
  assert.equal(usage.pricedTokens, 51423); assert.equal(usage.unpricedTokens, 0);
  assert.equal(usage.estimatedCostUsd, expected); assert.equal(usage.reasoningTokens, 400);
  assert.ok(usage.byModel[model], 'preserve the actual model ID in usage');
  for (const unknown of ['claude-opus-4-6-thinking-auto', 'claude-opus-999-thinking', 'auto', 'toString']) {
    assert.equal(pricing.priceFor(unknown), null);
    assert.equal(pricing.estimateTokens(unknown, sample), null);
  }
});

test('catalog refresh includes Gemini 4 and Claude 5 standard text API prices', () => {
  const filler = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['gpt-5-fixture-' + i, {
    litellm_provider: 'openai', input_cost_per_token: 0.000002, output_cost_per_token: 0.00001,
  }]));
  const upstream = {
    ...filler,
    'gemini/gemini-4-argon': { litellm_provider: 'gemini', input_cost_per_token: 0.000002,
      output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000001 },
    'gemini/gemini-4-neon': { litellm_provider: 'gemini', input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.00000015 },
    'claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 0.000004,
      output_cost_per_token: 0.00002, cache_read_input_token_cost: 0.0000002,
      cache_creation_input_token_cost: 0.000005 },
    'gemini/gemini-4-neon-image': { litellm_provider: 'gemini', input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015 },
  };
  const catalog = transformCatalog(upstream);
  assert.deepEqual(catalog.models['gemini-4-argon'], { input: 2, output: 10, cacheRead: 0.1, cacheWrite: null });
  assert.deepEqual(catalog.models['gemini-4-neon'], { input: 3, output: 15, cacheRead: 0.15, cacheWrite: null });
  assert.deepEqual(catalog.models['claude-opus-5-5'], { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(bundled.models['gemini-4-argon'], catalog.models['gemini-4-argon']);
  assert.deepEqual(bundled.models['gemini-4-neon'], catalog.models['gemini-4-neon']);
  assert.deepEqual(bundled.models['claude-opus-5-5'], catalog.models['claude-opus-5-5']);
  assert.equal(catalog.models['gemini-4-neon-image'], undefined);
});

test('bundled snapshot prices Antigravity Gemini 4 and Claude Opus 5.5 usage', () => {
  const cases = [
    { model: 'gemini-4-argon', sample: { input: 4413303, output: 30114, cacheRead: 4050142 },
      cost: 1.4324762 },
    { model: 'gemini-4-neon', sample: { input: 2638024, output: 38708, cacheRead: 2124871 },
      cost: 2.43880965 },
    { model: 'claude-opus-5-5', sample: { input: 2057556, output: 19439, cacheRead: 1859277 },
      cost: 1.5537514 },
  ];
  for (const value of cases) {
    assert.ok(pricing.priceFor(value.model), value.model);
    assert.equal(pricing.estimateAggregateTokens(value.model, value.sample), value.cost);
  }
});

test('Kimi K3.1 Code aliases use official standard and Highspeed prices', t => {
  const f = fixture(t);
  const cases = [
    { model: 'kimi-code/k3.1-pro', canonical: 'kimi-k3.1-pro', input: 2, output: 10 },
    { model: 'kimi-code/k3.1-pro-highspeed', canonical: 'kimi-k3.1-pro-highspeed', input: 4, output: 20 },
  ];
  const store = createSubscriptionUsage({ file: path.join(f.root, 'usage.json') });
  let expected = 0;
  for (const [index, value] of cases.entries()) {
    assert.equal(pricing.priceFor(value.model), pricing.priceFor(value.canonical));
    assert.deepEqual(pricing.priceFor(value.model), { input: value.input, output: value.output, cacheRead: 0.2, cacheWrite: null });
    const sample = { input: 10000, output: 1000, cacheRead: 6000, cacheWrite: 0 };
    const cost = (4000 * value.input + 1000 * value.output + 6000 * 0.2) / 1e6;
    expected += cost;
    assert.equal(pricing.estimateTokens(value.model, sample), cost);
    assert.equal(pricing.estimateTokens(value.model, { ...sample, cacheWrite: 1 }), null);
    store.record({ id: `kimi-k3.1-${index}`, engine: 'kimi', model: value.model, samples: [sample] });
  }
  const usage = store.state().accounts[0].usage;
  assert.equal(usage.pricedTokens, 22000);
  assert.equal(usage.unpricedTokens, 0);
  assert.equal(usage.estimatedCostUsd, expected);
});
