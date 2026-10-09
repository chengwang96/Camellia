'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { removeTree } = require('./test-fs.cjs');
const { writeJson } = require('../src/shared/json-store');
const { resetCredits, availableCredits, createResetCredits } = require('../src/engines/codex-reset-credits');
const { createCodex } = require('../src/engines/codex');

const NOW = 1800000000000;
const credit = (id, expiry) => ({ id, resetType: 'codexRateLimits', status: 'available', grantedAt: NOW / 1000 - 100,
  expiresAt: expiry, title: null, description: null });
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reset-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('camellia-reset-test-')); removeTree(root); });
  return root;
}
function fixture(t) {
  const root = temporary(t);
  const f = { file: path.join(root, 'request.json'), calls: [], patches: [], now: NOW,
    account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' },
    limits: { accountId: 'official-account', rateLimits: { primary: { usedPercent: 100 } }, rateLimitResetCredits: {
      availableCount: 3, credits: [credit('later', NOW / 1000 + 1000), credit('earliest', NOW / 1000 + 100), credit('no-expiry', null)] } },
    outcome: 'reset', failConsume: false, failRead: false };
  f.client = { request: async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'account/read') return { account: f.account };
    if (method === 'account/rateLimits/read') { if (f.failRead) throw new Error('offline'); return f.limits; }
    assert.equal(method, 'account/rateLimitResetCredit/consume');
    if (f.onConsume) await f.onConsume();
    if (f.failConsume) throw new Error('Connection closed after sending');
    if (f.outcome === 'reset' || f.outcome === 'alreadyRedeemed') {
      f.limits = { ...f.limits, rateLimits: { primary: { usedPercent: 0 } }, rateLimitResetCredits: { availableCount: 2, credits: null } };
    }
    return { outcome: f.outcome };
  } };
  f.service = () => createResetCredits({ file: f.file, getClient: async () => f.client,
    publish: patch => f.patches.push(patch), now: () => f.now });
  f.consumes = () => f.calls.filter(call => call.method.endsWith('/consume'));
  return f;
}

test('reset credits retain authoritative counts and nullable/capped details', () => {
  assert.equal(resetCredits(null), null);
  assert.equal(resetCredits({ availableCount: '3' }), null);
  assert.deepEqual(resetCredits({ availableCount: 3 }), { availableCount: 3, credits: null });
  assert.equal(resetCredits({ availableCount: 8, credits: [credit('one', null)] }).availableCount, 8);
  assert.deepEqual(resetCredits({ availableCount: 0, credits: [] }), { availableCount: 0, credits: [] });
  const summary = resetCredits({ availableCount: 5, credits: [credit('never', null), credit('soon', NOW / 1000 + 2),
    credit('expired', NOW / 1000), { ...credit('used', null), status: 'redeemed' }, { ...credit('other', null), resetType: 'unknown' }] });
  assert.deepEqual(availableCredits(summary, NOW).map(item => item.id), ['soon', 'never']);
});

test('opening/canceling is read-only and redemption requires the matching second confirmation', async t => {
  const f = fixture(t), service = f.service(), preview = await service.preview();
  assert.equal(preview.account.email, f.account.email);
  assert.equal(preview.credits.availableCount, 3);
  assert.equal(preview.creditId, 'earliest');
  assert.equal(f.consumes().length, 0);
  await assert.rejects(service.consume({ confirmationToken: preview.confirmationToken }), /Confirm/);
  await assert.rejects(service.consume({ confirmed: true, confirmationToken: 'wrong' }), /Open/);
  assert.equal(f.consumes().length, 0);
  const result = await service.consume({ confirmed: true, confirmationToken: preview.confirmationToken });
  assert.equal(result.outcome, 'reset');
  assert.equal(f.consumes().length, 1);
  assert.deepEqual(f.consumes()[0].params, { idempotencyKey: preview.confirmationToken, creditId: 'earliest' });
  assert.equal(f.patches.at(-1).rateLimits.codex.primary.usedPercent, 0);
  assert.equal(f.patches.at(-1).rateLimitResetCredits.availableCount, 2);
  await service.consume({ confirmed: true, confirmationToken: preview.confirmationToken });
  assert.equal(f.consumes().length, 1, 'completed confirmation cannot consume another card');
});

test('expired confirmation and changed account cannot consume a reset credit', async t => {
  const f = fixture(t), service = f.service(), first = await service.preview();
  f.now += 300001;
  await assert.rejects(service.consume({ confirmed: true, confirmationToken: first.confirmationToken }), /expired/);
  const second = await service.preview();
  f.limits.accountId = 'other-team-for-the-same-email';
  await assert.rejects(service.consume({ confirmed: true, confirmationToken: second.confirmationToken }), /account changed/);
  assert.equal(f.consumes().length, 0);
});

test('concurrent confirmation clicks share one redemption and one result', async t => {
  const f = fixture(t), service = f.service(), preview = await service.preview();
  const results = await Promise.all([service.consume({ confirmed: true, confirmationToken: preview.confirmationToken }),
    service.consume({ confirmed: true, confirmationToken: preview.confirmationToken })]);
  assert.equal(f.consumes().length, 1);
  assert.deepEqual(results[0], results[1]);
});

test('ambiguous requests reuse the original key and card after reopening and restarting', async t => {
  const f = fixture(t), service = f.service(), preview = await service.preview();
  f.failConsume = true;
  await assert.rejects(service.consume({ confirmed: true, confirmationToken: preview.confirmationToken }));
  const reopened = await service.preview();
  assert.equal(reopened.confirmationToken, preview.confirmationToken);
  assert.equal(reopened.retry, true);
  f.now += 600000;
  // The backend may have applied the first reset before the connection failed.
  f.limits.rateLimitResetCredits = { availableCount: 0, credits: [] };
  const restarted = f.service(), retry = await restarted.preview();
  assert.equal(retry.confirmationToken, preview.confirmationToken);
  f.failConsume = false; f.outcome = 'alreadyRedeemed';
  assert.equal((await restarted.consume({ confirmed: true, confirmationToken: retry.confirmationToken })).outcome, 'alreadyRedeemed');
  assert.deepEqual(f.consumes()[0].params, f.consumes()[1].params);
});

test('count-only responses let the official service select the credit', async t => {
  const f = fixture(t); f.limits.rateLimitResetCredits.credits = null;
  const service = f.service(), preview = await service.preview();
  assert.equal(preview.creditId, null);
  await service.consume({ confirmed: true, confirmationToken: preview.confirmationToken });
  assert.deepEqual(f.consumes()[0].params, { idempotencyKey: preview.confirmationToken });
});

test('unsupported, empty and API-key accounts never enable redemption', async t => {
  const f = fixture(t), service = f.service();
  f.limits.rateLimitResetCredits = null;
  assert.equal((await service.preview()).confirmationToken, null);
  f.limits.rateLimitResetCredits = { availableCount: 0, credits: [] };
  assert.equal((await service.preview()).confirmationToken, null);
  f.account = { type: 'apiKey' };
  await assert.rejects(service.preview(), /ChatGPT/);
  assert.equal(f.consumes().length, 0);
});

for (const outcome of ['noCredit', 'nothingToReset']) test(`${outcome} refreshes official state without assuming a reset`, async t => {
  const f = fixture(t); f.outcome = outcome;
  const service = f.service(), preview = await service.preview();
  assert.equal((await service.consume({ confirmed: true, confirmationToken: preview.confirmationToken })).outcome, outcome);
  assert.equal(f.patches.at(-1).rateLimits.codex.primary.usedPercent, 100);
  assert.equal(f.patches.at(-1).rateLimitResetCredits.availableCount, 3);
});

test('a known reset remains successful when the follow-up refresh fails', async t => {
  const f = fixture(t), service = f.service(), preview = await service.preview();
  f.onConsume = async () => { f.failRead = true; };
  const result = await service.consume({ confirmed: true, confirmationToken: preview.confirmationToken });
  assert.equal(result.outcome, 'reset');
  assert.match(result.warning, /refresh failed/);
  assert.equal(f.patches.at(-1).rateLimitResetCredits, null);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).outcome, 'reset');
});

test('failure to persist an attempt prevents the native consume request', async t => {
  const f = fixture(t), service = f.service(), preview = await service.preview();
  fs.mkdirSync(f.file);
  await assert.rejects(service.consume({ confirmed: true, confirmationToken: preview.confirmationToken }));
  assert.equal(f.consumes().length, 0);
});

test('unknown outcomes remain unresolved and can only retry with the original key', async t => {
  const f = fixture(t); f.outcome = 'unexpected';
  const service = f.service(), preview = await service.preview();
  await assert.rejects(service.consume({ confirmed: true, confirmationToken: preview.confirmationToken }), /unknown/);
  assert.equal((await service.preview()).confirmationToken, preview.confirmationToken);
});

test('desktop handlers reset the selected card profile without switching the active account', async t => {
  const root = temporary(t), requests = [], homes = [];
  const accounts = [{ id: 'default', label: '' }, { id: 'account-1', label: 'Backup' }];
  let config = { subscriptionAccounts: { codex: accounts }, subscriptionActive: { codex: 'default' } };
  for (const account of accounts) writeJson(account.id === 'default' ? path.join(root, 'codex', 'account-state.json')
    : path.join(root, 'subscription-accounts', 'codex', account.id, 'account-state.json'), {
      account: { type: 'chatgpt', email: account.id + '@example.com' }, models: [{ id: 'model', serviceTiers: [] }] });
  let release, consumed = false;
  const engine = createCodex({ dataDir: root, loadConfig: () => config, saveConfig: patch => Object.assign(config, patch),
    runtimes: () => ({ locate: () => ({ file: path.join(root, 'fixture.exe') }) }),
    createAccountClient: options => {
      const home = options.env.CODEX_HOME; homes.push(home);
      const id = home.includes('account-1') ? 'account-1' : 'default';
      return { ready: Promise.resolve(), shutdown: async () => {}, request: async (method, params) => {
        requests.push({ id, method, params });
        if (method === 'account/read') return { account: { type: 'chatgpt', email: id + '@example.com', planType: 'pro' } };
        if (method === 'model/list') return { data: [{ model: 'model' }], nextCursor: null };
        if (method === 'account/rateLimits/read') return { accountId: id, rateLimits: { primary: { usedPercent: consumed ? 0 : 100 } },
          rateLimitResetCredits: { availableCount: consumed ? 1 : 2, credits: [credit('target-card', NOW / 1000 + 100)] } };
        if (method.endsWith('/consume')) { await new Promise(resolve => { release = resolve; }); consumed = true; return { outcome: 'reset' }; }
        return {};
      } };
    } });
  t.after(() => engine.shutdown());
  await assert.rejects(engine.handlers['account-reset-preview']({ id: 'unknown' }), /Unknown/);
  const opened = await engine.handlers['account-reset-preview']({ id: 'account-1' });
  assert.equal(opened.preview.account.email, 'account-1@example.com');
  assert.equal(opened.activeId, 'default');
  assert.equal(opened.accounts.find(account => account.id === 'account-1').rateLimitResetCredits.availableCount, 2);
  assert.deepEqual(homes, [path.join(root, 'subscription-accounts', 'codex', 'account-1')]);
  const pending = engine.handlers['account-reset-consume']({ id: 'account-1', confirmed: true, confirmationToken: opened.preview.confirmationToken });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(engine.handlers['account-remove']({ id: 'account-1' }), /reset request/);
  await assert.rejects(engine.handlers['sign-out'](), /reset request/);
  release(); const result = await pending;
  assert.equal(result.activeId, 'default');
  assert.equal(result.outcome, 'reset');
  assert.equal(result.accounts.find(account => account.id === 'account-1').rateLimitResetCredits.availableCount, 1);
  assert.equal(result.accounts.find(account => account.id === 'account-1').quotaWindows[0].usedPercent, 0);
  assert.equal(requests.filter(request => request.method.endsWith('/consume'))[0].id, 'account-1');
});

test('the real desktop preload and main IPC require confirmation and return the refreshed account', async t => {
  const module = require('../src/engines/codex'), factory = module.createCodex;
  const calls = []; let consumed = false;
  t.mock.method(module, 'createCodex', options => {
    writeJson(path.join(options.dataDir, 'codex', 'account-state.json'), {
      account: { type: 'chatgpt', email: 'desktop@example.com' }, models: [{ id: 'fixture', serviceTiers: [] }] });
    return factory({ ...options, runtimes: () => ({ locate: () => ({ file: path.join(options.dataDir, 'fixture.exe') }) }),
      createAccountClient: () => ({ ready: Promise.resolve(), shutdown: async () => {}, request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'account/read') return { account: { type: 'chatgpt', email: 'desktop@example.com', planType: 'pro' } };
        if (method === 'account/rateLimits/read') return { accountId: 'desktop', rateLimits: { primary: { usedPercent: consumed ? 0 : 100 } },
          rateLimitResetCredits: { availableCount: consumed ? 1 : 2, credits: null } };
        if (method.endsWith('/consume')) { consumed = true; return { outcome: 'reset' }; }
        throw new Error('Unexpected native method: ' + method);
      } }) });
  });
  const h = require('./claude-harness.cjs').createHarness();
  t.after(async () => { await h.api.codex.shutdown(); h.cleanup(); });
  let bridge;
  const ipc = new EventEmitter(); ipc.invoke = (channel, payload) => h.call(channel.slice(4), payload);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8'), {
    process: { argv: [] }, window: { addEventListener() {} },
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'dshDesktop') bridge = value; } }, ipcRenderer: ipc, webUtils: {} }),
  });
  const preview = await bridge.codexAccountResetPreview('default');
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.preview.account.email, 'desktop@example.com');
  assert.equal(consumed, false);
  const denied = await bridge.codexAccountResetConsume({ id: 'default', confirmationToken: preview.preview.confirmationToken });
  assert.equal(denied.ok, false); assert.match(denied.error, /Confirm/); assert.equal(consumed, false);
  const result = await bridge.codexAccountResetConsume({ id: 'default', confirmed: true, confirmationToken: preview.preview.confirmationToken });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.outcome, 'reset');
  assert.equal(result.accounts[0].rateLimitResetCredits.availableCount, 1);
  assert.equal(result.accounts[0].quotaWindows[0].usedPercent, 0);
  assert.equal(calls.filter(call => call.method.endsWith('/consume')).length, 1);
});

test('a slow canceled preview cannot replace a newer confirmation for the same account', async t => {
  const f = fixture(t), original = f.client.request;
  let finish;
  f.client.request = async (method, params) => {
    if (method === 'account/rateLimits/read' && !finish) await new Promise(resolve => { finish = resolve; });
    return original(method, params);
  };
  const service = f.service(), older = service.preview();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const newer = await service.preview();
  finish(); const canceled = await older;
  assert.equal(canceled.confirmationToken, null);
  assert.equal((await service.consume({ confirmed: true, confirmationToken: newer.confirmationToken })).outcome, 'reset');
  assert.equal(f.consumes().length, 1);
});
