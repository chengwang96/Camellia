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
