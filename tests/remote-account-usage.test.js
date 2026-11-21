'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accountUsageSnapshot, createAccountUsage } = require('../src/main/remote/account-usage');
const now = new Date(2026, 10, 15, 12);
function fixture() {
  return { router: { providers: [{ id: 'p', name: 'Provider', baseUrl: 'secret-url', keys: [{ id: 'k', name: 'My key', key: 'secret-key' }] }],
    usage: { k: { requests: 8, inputTokens: 100, byModel: { model: { requests: 6, inputTokens: 80 } },
      daily: { '2026-11-15': { model: { requests: 1, inputTokens: 10 } }, '2026-11-09': { model: { requests: 2 } },
        '2026-11-08': { model: { requests: 3 } }, '2026-11-16': { model: { requests: 99 } } } } },
    usageArchive: [{ id: 'old', providerName: 'Removed', usage: { requests: 1 } }],
    subscriptionUsage: { accounts: [{ id: 'codex:a', provider: 'ChatGPT', label: 'Account', usage: {
      byModel: { model: { requests: 2, estimatedCostUsd: 1.5, unreported: 1 } } } }] } },
  insights: { providers: { p: { supported: true } }, keys: { k: { error: 'secret-key', latest: { at: now.toISOString(),
    raw: { token: 'secret' }, windows: [{ label: '5 hours', usedPercent: 25, raw: 'secret' }], balances: [{ currency: 'CNY', value: 0 }, { currency: 'USD', value: null }] } } } } };
}
test('usage projection excludes credentials, endpoints, raw quotas, histories and upstream errors', () => {
  const view = accountUsageSnapshot(fixture(), now);
  assert.doesNotMatch(JSON.stringify(view), /secret|baseUrl|history/);
  const account = view.accounts[0];
  assert.equal(account.windows[0].usedPercent, 25);
  assert.equal(account.balances[0].value, 0);
  assert.equal(account.balances[1].value, null);
  assert.equal(account.failed, true);
  assert.equal(view.accounts[1].archived, true);
});
test('periods include local today, filter future days, and preserve lifetime legacy and removed-key counters', () => {
  const view = accountUsageSnapshot(fixture(), now);
  const sum = range => view.ranges[range].filter(row => row.accountId === 'api:k').reduce((n, row) => n + row.requests, 0);
  assert.equal(sum('1'), 1); assert.equal(sum('7'), 3); assert.equal(sum('30'), 6); assert.equal(sum('month'), 6); assert.equal(sum('all'), 8);
  assert.equal(view.ranges.all.find(row => row.accountId === 'api:k' && row.model === '').inputTokens, 20);
  assert.equal(view.ranges.all.find(row => row.accountId === 'archive:old').requests, 1);
  assert.equal(view.ranges.all.find(row => row.accountId === 'subscription:codex:a').estimatedCostUsd, 1.5);
});
test('unsupported and unqueried balances stay distinct; router errors are never a zero result', () => {
  const input = fixture(); input.insights.keys = {};
  let account = accountUsageSnapshot(input, now).accounts[0];
  assert.equal(account.supported, true); assert.equal(account.updatedAt, null); assert.deepEqual(account.balances, []);
  input.insights.providers = {}; account = accountUsageSnapshot(input, now).accounts[0];
  assert.equal(account.supported, false);
  assert.throws(() => accountUsageSnapshot({ router: { ok: false, error: 'secret' } }), /unavailable/);
});
test('calendar month starts on the first local day and excludes the previous month', () => {
  const input = fixture();
  input.router.usage.k.daily = {
    '2026-10-31': { model: { requests: 40 } }, '2026-11-01': { model: { requests: 5 } },
    '2026-11-15': { model: { requests: 2 } }, '2026-11-16': { model: { requests: 99 } },
  };
  const view = accountUsageSnapshot(input, now);
  const requests = range => view.ranges[range].filter(row => row.accountId === 'api:k').reduce((n, row) => n + row.requests, 0);
  assert.equal(requests('month'), 7);
  assert.equal(requests('30'), 47);
});
test('refresh is nonblocking, coalesced, rate limited and failure retains last good readings', async () => {
  let resolve, calls = 0, time = now.getTime();
  const service = createAccountUsage({ read: fixture, now: () => new Date(time), refresh: () => { calls++; return new Promise(r => { resolve = r; }); } });
  assert.equal(service.refresh().refreshing, true);
  service.refresh(); await Promise.resolve(); assert.equal(calls, 1);
  resolve(); await new Promise(r => setImmediate(r));
  assert.equal(service.refresh().refreshing, false); assert.equal(calls, 1);
  time += 60_001; service.refresh(); await Promise.resolve(); assert.equal(calls, 2);
  resolve(); await new Promise(r => setImmediate(r));
  const failed = createAccountUsage({ read: fixture, refresh: () => { throw Error('secret'); } });
  failed.refresh(); await new Promise(r => setImmediate(r));
  assert.equal(failed.state().refreshFailed, true); assert.equal(failed.state().accounts[0].balances[0].value, 0);
});
