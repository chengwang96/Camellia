'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { recordUsage, dayId } = require('../src/api/api-usage');
const { createSubscriptionUsage } = require('../src/api/subscription-usage');
const { recalculateHistory } = require('../src/api/subscription-repricing');
const pricing = require('../src/api/subscription-pricing');
const bundled = require('../src/api/subscription-prices.json');

const MODEL = 'gpt-6.1-sol', DAY = '2026-10-06';
const sample = { input: 400000, output: 1000, cacheRead: 200000, cacheWrite: 0, reasoning: 500 };
function legacyData(rows = [{ model: MODEL, sample }]) {
  const data = { version: 1, since: '2026-09-29T00:00:00Z', accounts: {}, recent: ['saved-turn'], pendingPricing: [] };
  for (const row of rows) {
    const key = `codex:${row.accountId || 'default'}`;
    const account = data.accounts[key] ||= { engine: 'codex', accountId: row.accountId || 'default', usage: {} };
    const value = row.sample;
    recordUsage(account.usage, row.model, { ...value, reported: true }, 'requests', new Date(`${row.day || DAY}T12:00:00`));
    for (const bucket of [account.usage, account.usage.byModel[row.model], account.usage.daily[row.day || DAY][row.model]]) {
      bucket.unpricedTokens = (bucket.unpricedTokens || 0) + value.input + value.output;
      bucket.pricedTokens ||= 0; bucket.estimatedCostUsd ||= 0;
      bucket.reasoningTokens = (bucket.reasoningTokens || 0) + (value.reasoning || 0);
    }
  }
  return data;
}
function fixture(t, data = legacyData()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-history-pricing-'));
  t.after(() => { removeTree(root); pricing.installCatalog(bundled, 'bundled'); delete pricing.catalogInfo.error; });
  const file = path.join(root, 'usage.json'); fs.writeFileSync(file, JSON.stringify(data));
  return { root, file, data, store: createSubscriptionUsage({ file }) };
}
function buckets(data, model = MODEL) {
  const usage = data.accounts['codex:default'].usage;
  return [usage, usage.byModel[model], usage.daily[DAY]?.[model]].filter(Boolean);
}
const baseCost = (value, model = MODEL) => {
  const rates = pricing.priceFor(model);
  return ((value.input - (value.cacheRead || 0) - (value.cacheWrite || 0)) * rates.input
    + value.output * rates.output + (value.cacheRead || 0) * (rates.cacheRead || 0) + (value.cacheWrite || 0) * (rates.cacheWrite || 0)) / 1e6;
};

test('manual refresh fills legacy aggregates with labelled base-rate estimates and survives repeated refresh and restart', async t => {
  const f = fixture(t), original = structuredClone(f.data);
  const prices = { refresh: async () => ({ ok: true }) };
  const result = await f.store.refreshPricing({ prices, recover: async () => [] });
  assert.equal(result.ok, true); assert.equal(result.repricing.estimatedTokens, 401000);
  for (const value of buckets(JSON.parse(fs.readFileSync(f.file)))) {
    assert.equal(value.unpricedTokens, 0); assert.equal(value.pricedTokens, 401000);
    assert.equal(value.approximateTokens, 401000); assert.equal(value.estimatedCostUsd, baseCost(sample));
    assert.equal(value.requests, 1); assert.equal(value.inputTokens, sample.input); assert.equal(value.reasoningTokens, 500);
  }
  assert.deepEqual(f.data, original);
  const saved = fs.readFileSync(f.file, 'utf8');
  const restarted = createSubscriptionUsage({ file: f.file });
  await restarted.refreshPricing({ prices, recover: () => { throw new Error('No remaining history should be scanned'); } });
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
});

test('native recovery must reconcile every token bucket and turn before pricing individual long-context requests', t => {
  const f = fixture(t);
  const samples = [{ input: 300000, output: 600, cacheRead: 150000, reasoning: 300 },
    { input: 100000, output: 400, cacheRead: 50000, reasoning: 200 }];
  const row = { account: 'codex:default', day: DAY, model: MODEL, turns: 1, samples };
  const result = f.store.repriceHistory([row]);
  assert.equal(result.recoveredTokens, 401000); assert.equal(result.estimatedTokens, 0);
  const expected = samples.reduce((sum, value) => sum + pricing.estimateTokens(MODEL, value), 0);
  assert.notEqual(expected, baseCost(sample));
  for (const value of buckets(JSON.parse(fs.readFileSync(f.file)))) {
    assert.equal(value.estimatedCostUsd, expected); assert.equal(value.approximateTokens, 0);
  }
  for (const mismatch of [{ turns: 2 }, { samples: [{ ...sample, cacheRead: 199999 }] }, { samples: [{ ...sample, reasoning: 499 }] }]) {
    const next = recalculateHistory(f.data, [{ ...row, ...mismatch }]);
    assert.equal(next.result.recoveredTokens, 0); assert.equal(next.result.estimatedTokens, 401000);
  }
});

test('mixed priced and unpriced history replaces the bucket price once and clears its pending requests', t => {
  const data = legacyData();
  for (const value of buckets(data)) { value.pricedTokens = 200000; value.unpricedTokens = 201000; value.estimatedCostUsd = .9; }
  data.pendingPricing.push({ account: 'codex:default', day: DAY, model: MODEL, sample: { input: 200000, output: 1000, cacheRead: 100000, aggregate: true } });
  const f = fixture(t, data);
  assert.equal(f.store.reprice(), false);
  const result = f.store.repriceHistory();
  assert.equal(result.repricedTokens, 201000);
  const saved = JSON.parse(fs.readFileSync(f.file));
  for (const value of buckets(saved)) {
    assert.equal(value.estimatedCostUsd, baseCost(sample)); assert.equal(value.pricedTokens, 401000);
    assert.equal(value.approximateTokens, 401000); assert.equal(value.requests, 1);
  }
  assert.deepEqual(saved.pendingPricing, []); assert.equal(f.store.reprice(), false);
  assert.equal(f.store.repriceHistory().repricedTokens, 0);
});

test('lifetime history older than the daily retention period is repriced once without leaving a replayable pending entry', t => {
  const data = legacyData(); delete data.accounts['codex:default'].usage.daily[DAY];
  data.pendingPricing = [{ account: 'codex:default', day: DAY, model: MODEL, sample: { ...sample, aggregate: true } }];
  const f = fixture(t, data); assert.equal(f.store.repriceHistory().repricedTokens, 401000);
  const saved = JSON.parse(fs.readFileSync(f.file));
  assert.equal(saved.accounts['codex:default'].usage.unpricedTokens, 0);
  assert.equal(saved.accounts['codex:default'].usage.approximateTokens, 401000);
  assert.deepEqual(saved.accounts['codex:default'].usage.daily, {}); assert.deepEqual(saved.pendingPricing, []);
});

test('unknown model prices, missing cache rates and inconsistent aggregates stay unpriced; all aggregate fallbacks retain the historical estimate label', t => {
  const linear = 'gpt-5.3-codex';
  pricing.installCatalog({ ...bundled, models: { ...bundled.models, 'cache-rate-fixture': { input: 2, output: 10, cacheRead: null, cacheWrite: null } } });
  const f = fixture(t, legacyData([{ model: 'future-model', sample }, { model: 'cache-rate-fixture', sample }, { model: linear, sample }]));
  const result = f.store.repriceHistory(); assert.equal(result.repricedTokens, 401000); assert.equal(result.estimatedTokens, 401000);
  const usage = f.store.state().accounts[0].usage;
  assert.equal(usage.byModel['future-model'].unpricedTokens, 401000);
  assert.equal(usage.byModel['cache-rate-fixture'].unpricedTokens, 401000);
  assert.equal(usage.byModel[linear].estimatedCostUsd, baseCost(sample, linear));
  assert.equal(usage.byModel[linear].approximateTokens, 401000);
  const invalid = legacyData(); invalid.accounts['codex:default'].usage.daily[DAY][MODEL].pricedTokens = 1;
  assert.equal(recalculateHistory(invalid).result.repricedTokens, 0);
});

test('saving a historical recalculation is atomic and a failed write can be retried', t => {
  const f = fixture(t), original = fs.readFileSync(f.file, 'utf8');
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.file) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  assert.throws(() => f.store.repriceHistory());
  assert.equal(f.store.state().accounts[0].usage.unpricedTokens, 401000);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  mock.mock.restore(); assert.equal(f.store.repriceHistory().repricedTokens, 401000);
  assert.equal(f.store.state().error, null);
});

test('concurrent clicks coalesce and usage recorded while native history is read remains in the final totals', async t => {
  const today = dayId(new Date()), f = fixture(t, legacyData([{ model: MODEL, sample, day: today }]));
  let release, priceCalls = 0, historyCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { prices: { refresh: async () => { priceCalls++; return { ok: true }; } }, recover: async () => {
    historyCalls++; await gate;
    return [{ account: 'codex:default', day: today, model: MODEL, turns: 1, samples: [sample] }];
  } };
  const first = f.store.refreshPricing(options), second = f.store.refreshPricing(options);
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.store.state().repricing.refreshing, true);
  f.store.record({ id: 'new-turn', engine: 'codex', model: MODEL, samples: [{ input: 1000, output: 10 }] });
  release(); assert.equal((await first).ok, true);
  const usage = f.store.state().accounts[0].usage;
  assert.equal(usage.requests, 2); assert.equal(usage.inputTokens, 401000); assert.equal(usage.outputTokens, 1010);
  assert.equal(usage.unpricedTokens, 0); assert.equal(usage.pricedTokens, 402010);
  assert.equal(usage.approximateTokens, 402010);
  assert.equal(priceCalls, 1); assert.equal(historyCalls, 1); assert.equal(f.store.state().repricing.refreshing, false);
});

test('manual historical repricing still works from the cached catalog when refreshing prices is offline', async t => {
  const f = fixture(t);
  const result = await f.store.refreshPricing({ prices: { refresh: async () => ({ ok: false, error: 'Offline' }) }, recover: async () => [] });
  assert.equal(result.ok, false); assert.equal(result.error, 'Offline');
  assert.equal(f.store.state().accounts[0].usage.unpricedTokens, 0);
  assert.equal(f.store.state().repricing.refreshing, false);
});
