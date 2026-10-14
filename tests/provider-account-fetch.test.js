'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProviderAccountConnection } = require('../src/main/provider-account-fetch');
const { queryAccount } = require('../src/api/provider-accounts');

const url = 'https://api.commandcode.ai/alpha/whoami?limits=1';
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

function fixture(mode = 'auto', fetchImpl = async () => { throw reset(); }) {
  const directCalls = [];
  let created = 0, closed = 0;
  const connection = createProviderAccountConnection({ getMode: () => mode, getProxyUrl: () => 'http://127.0.0.1:7890', fetchImpl,
    createDirect: () => { created++; return { fetch: async (...args) => { directCalls.push(args); return { ok: true, status: 200 }; }, close: () => { closed++; } }; } });
  return { connection, directCalls, created: () => created, closed: () => closed };
}

test('automatic account GET falls back once to direct using the same URL, credentials and deadline', async () => {
  const f = fixture();
  const options = { method: 'GET', headers: { Authorization: 'Bearer private' }, redirect: 'error', signal: AbortSignal.timeout(10000) };
  assert.equal((await f.connection.fetch(url, options)).status, 200);
  assert.deepEqual(f.directCalls, [[url, options]]);
  await f.connection.fetch(url, options);
  assert.equal(f.created(), 1); assert.equal(f.directCalls.length, 2);
  f.connection.close(); assert.equal(f.closed(), 1);
});

test('a healthy proxy and HTTP errors never cause a direct retry', async () => {
  for (const status of [200, 401, 403, 429, 503]) {
    const f = fixture('auto', async () => ({ status }));
    assert.equal((await f.connection.fetch(url)).status, status);
    assert.equal(f.created(), 0);
  }
});

test('without a selected proxy, automatic mode does not retry the same direct connection', async () => {
  let created = 0;
  const connection = createProviderAccountConnection({ getMode: () => 'auto', getProxyUrl: () => '',
    fetchImpl: async () => { throw reset(); }, createDirect: () => { created++; } });
  await assert.rejects(connection.fetch(url), /fetch failed/); assert.equal(created, 0);
});

test('explicit system proxy/direct choices and POST validation never take automatic GET fallback', async () => {
  for (const [mode, method] of [['system', 'GET'], ['direct', 'GET'], ['auto', 'POST'], ['prefer-direct', 'POST']]) {
    const f = fixture(mode);
    await assert.rejects(f.connection.fetch(url, { method }), /fetch failed/);
    assert.equal(f.created(), 0);
  }
});

test('aborted deadlines, redirects and non-connection failures cannot cause fallback', async () => {
  const aborted = fixture();
  await assert.rejects(aborted.connection.fetch(url, { signal: AbortSignal.abort() }), /fetch failed/);
  assert.equal(aborted.created(), 0);
  for (const error of [new TypeError('unexpected redirect'), Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' })]) {
    const f = fixture('auto', async () => { throw error; });
    await assert.rejects(f.connection.fetch(url), e => e === error); assert.equal(f.created(), 0);
  }
});

test('a failed direct attempt ends the request and never loops or switches hosts', async () => {
  let first = 0, second = 0;
  const connection = createProviderAccountConnection({ getMode: () => 'auto', getProxyUrl: () => 'http://localhost:7890',
    fetchImpl: async () => { first++; throw reset(); }, createDirect: () => ({ fetch: async actualUrl => {
      assert.equal(actualUrl, url); second++; throw reset();
    } }) });
  await assert.rejects(connection.fetch(url), /fetch failed/); assert.equal(first, 1); assert.equal(second, 1);
});

test('Command Code quota parsing recovers through direct fallback after a proxy connection reset', async () => {
  const directUrls = [];
  const connection = createProviderAccountConnection({ getMode: () => 'auto', getProxyUrl: () => 'http://localhost:7890',
    fetchImpl: async () => { throw reset(); }, createDirect: () => ({ fetch: async (actualUrl, options) => {
      directUrls.push(actualUrl); assert.equal(options.headers.Authorization, 'Bearer secret');
      return { ok: true, status: 200, json: async () => actualUrl.includes('whoami') ? { success: true, org: null }
        : actualUrl.includes('subscriptions') ? { success: true, data: { status: 'active', currentPeriodEnd: '2026-11-07T06:11:15Z' } }
        : { credits: { monthlyCredits: 34.96, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: { limited: true, exceeded: null, fiveHour: { used: 0, cap: 14, resetAt: 0 }, weekly: { used: 0, cap: 35, resetAt: 0 } } } };
    } }) });
  const result = await queryAccount({ baseUrl: 'https://api.commandcode.ai/provider/v1' }, 'secret', { fetchImpl: connection.fetch });
  assert.equal(result.status, 'ok'); assert.equal(result.balances[0].value, 34.96);
  assert.deepEqual(result.windows.map(w => w.usedPercent), [0, 0, null]); assert.equal(result.windows[2].remainingValue, 34.96);
  assert.deepEqual(directUrls, [url, 'https://api.commandcode.ai/alpha/billing/credits', 'https://api.commandcode.ai/alpha/billing/subscriptions']);
});
