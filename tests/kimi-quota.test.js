'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readKimiQuota, normalizeKimiQuota } = require('../src/engines/kimi-quota');
const { createHarness } = require('./claude-harness.cjs');
const { writeJson } = require('../src/shared/json-store');
const path = require('node:path');

const usage = { kind: 'ok', summary: { used: 20, limit: 100, reset_at: '2026-09-24T00:00:00Z' },
  limits: [{ used: 0, limit: 100, window: { duration: 5, unit: 'hour' }, reset_at: '2026-09-17T05:00:00Z' }],
  extra_usage: { balance_cents: 1234, currency: 'CNY' } };

test('native Kimi usage distinguishes quota, unknown amounts and extra usage money', () => {
  const result = normalizeKimiQuota(usage);
  assert.deepEqual(result.windows.map(w => [w.label, w.usedPercent]), [['Weekly', 20], ['5 hours', 0]]);
  assert.equal(result.balances[0].value, 12.34); assert.equal(result.balances[0].currency, 'CNY');
  assert.deepEqual(normalizeKimiQuota({ ...usage, extra_usage: null }).balances, []);
  assert.deepEqual(normalizeKimiQuota({ ...usage, summary: { used: 1, limit: 0 } }).windows.map(w => w.usedPercent), [0]);
  const newer = normalizeKimiQuota({ quota: { usages: { limit5h: { usedRatio: 0.25 }, limit7d: { usedRatio: 1.2 } },
    extraUsage: { balanceCents: 0, currency: 'USD' } } });
  assert.deepEqual(newer.windows.map(w => w.usedPercent), [25, 120]);
  assert.equal(newer.balances[0].value, 0);
  assert.throws(() => normalizeKimiQuota({ kind: 'ok', summary: null, limits: [] }), /did not return/);
});

test('quota transport uses an authenticated loopback CLI, never launches a browser, and closes on success or failure', async () => {
  for (const fail of [false, true]) {
    let child;
    const request = readKimiQuota({ home: __dirname, file: '/fixture/kimi.mjs', node: process.execPath,
      environment: { KIMI_API_KEY: 'wrong-api-key', PATH: process.env.PATH },
      spawnProcess(exe, args, options) {
        assert.ok(args.includes('--no-open')); assert.deepEqual(args.slice(2, 6), ['--host', '127.0.0.1', '--port', '0']);
        assert.equal(options.windowsHide, true); assert.equal(options.env.KIMI_API_KEY, undefined);
        child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
          kill() { this.stopped = true; queueMicrotask(() => this.emit('close', 0)); } });
        queueMicrotask(() => { child.stdout.write('Kimi server: http://127.0.0.1:23456/#tok'); child.stdout.write('en=local-private-token\n'); });
        return child;
      },
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:23456/api/v1/oauth/usage');
        assert.equal(options.headers.Authorization, 'Bearer local-private-token'); assert.equal(options.redirect, 'error');
        return { ok: !fail, status: fail ? 500 : 200, json: async () => ({ data: usage }) };
      },
    });
    if (fail) await assert.rejects(request, /HTTP 500/);
    else assert.equal((await request).balances[0].value, 12.34);
    assert.equal(child.stopped, true); child.stdout.destroy(); child.stderr.destroy();
  }
});

test('signed-in subscriptions appear in insights without adding an API provider or leaking login metadata', async t => {
  const first = createHarness();
  writeJson(path.join(first.userData, 'kimi-subscription/account-state.json'), { account: { name: 'Kimi Code', region: 'global' }, models: [],
    usage: { latest: { ...normalizeKimiQuota(usage), at: '2026-09-17T01:00:00Z' }, history: [], status: 'ok' } });
  const h = createHarness(first.root); t.after(() => h.cleanup());
  const state = await h.call('provider-insights');
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.subscriptions[0].info.latest.windows[0].usedPercent, 20);
  assert.deepEqual(state.keys, {});
  assert.deepEqual((await h.call('api-router-get-state')).providers, []);
  assert.doesNotMatch(JSON.stringify(state), /oauth|access_token|refresh_token/);
});
