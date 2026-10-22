'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { readJson } = require('../src/shared/json-store');
const { accountSummary, accountExhausted, usableAccountId } = require('../src/engines/subscription-accounts');
const { quotaPatch } = require('../src/engines/codex-reset-credits');
const { createCodex } = require('../src/engines/codex');

const profile = { id: 'default', label: '' };
const credits = (balance, unlimited = false) => ({ balance, hasCredits: Number(balance) > 0, unlimited });
const summary = rateLimits => accountSummary('codex', profile, { account: { email: 'test@example.com' }, rateLimits });

test('Codex credit balances support legacy and named buckets without adding repeated account balances', () => {
  const snapshot = { primary: { usedPercent: 13 }, credits: credits('58453.6') };
  for (const rateLimits of [snapshot, { codex: snapshot }, { other: snapshot }, { credits: snapshot.credits }]) {
    assert.deepEqual(summary(rateLimits).credits, { balance: 58453.6, hasCredits: true, unlimited: false });
  }
  assert.equal(summary({ extra: { credits: credits('20') }, codex: snapshot }).credits.balance, 58453.6);
  for (const result of [{ rateLimits: snapshot }, { rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot, extra: snapshot } }]) {
    assert.equal(summary(quotaPatch(result).rateLimits).credits.balance, 58453.6);
  }
});

test('Codex credits distinguish zero, missing balances and unlimited access', () => {
  for (const balance of [0, '0', '0.00']) assert.deepEqual(summary({ credits: credits(balance) }).credits,
    { balance: 0, hasCredits: false, unlimited: false });
  for (const balance of [null, undefined, '', ' ', 'unknown', 'Infinity', -1, false, [], {}]) {
    assert.equal(summary({ credits: credits(balance) }).credits.balance, null);
  }
  assert.deepEqual(summary({ credits: credits(null, true) }).credits, { balance: null, hasCredits: false, unlimited: true });
  assert.equal(summary(null).credits, null);
  assert.equal(summary({ primary: { usedPercent: 0 } }).credits, null);
  assert.equal(accountSummary('codex', profile, { rateLimits: { credits: credits('15') } }).credits, null);
  assert.equal(Object.hasOwn(accountSummary('kimi', profile, {}), 'credits'), false);
});

test('Codex rotation requires both a full subscription window and explicitly empty credits', () => {
  const exhausted = rateLimits => accountExhausted('codex', { rateLimits });
  const wrap = [snapshot => snapshot, snapshot => ({ codex: snapshot }), snapshot => ({ other: snapshot })];
  for (const group of wrap) {
    for (const balance of [0, '0', '0.00']) {
      assert.equal(exhausted(group({ primary: { usedPercent: 100 }, credits: credits(balance) })), true);
      assert.equal(exhausted(group({ secondary: { usedPercent: 100 }, credits: credits(balance) })), true);
      assert.equal(exhausted(group({ primary: { usedPercent: 99 }, credits: credits(balance) })), false);
      assert.equal(exhausted(group({ credits: credits(balance) })), false);
    }
    for (const balance of [15, '58453.6', '0.001', null, undefined, '', ' ', 'unknown', 'Infinity', -1, false, [], {}]) {
      assert.equal(exhausted(group({ primary: { usedPercent: 100 }, credits: credits(balance) })), false);
    }
    assert.equal(exhausted(group({ primary: { usedPercent: 100 } })), false);
    assert.equal(exhausted(group({ primary: { usedPercent: 100 }, credits: credits(0, true) })), false);
    assert.equal(exhausted(group({ primary: { usedPercent: 100 }, credits: { balance: 0, hasCredits: true } })), false);
  }
});

test('Codex account selection keeps the selected account while credits can cover its full window', () => {
  const options = { engine: 'codex', activeId: 'default', accounts: [profile, { id: 'account-1' }], states: {
    default: { account: {}, rateLimits: { primary: { usedPercent: 100 }, credits: credits('15') } },
    'account-1': { account: {}, rateLimits: { primary: { usedPercent: 10 }, credits: credits(0) } },
  } };
  assert.equal(usableAccountId(options), 'default');
  options.states.default.rateLimits.credits = credits(0);
  assert.equal(usableAccountId(options), 'account-1');
});

test('Codex refresh, sparse notifications and cached reloads keep credit balances scoped to each account', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-credit-test-'));
  let engine, reloaded;
  t.after(async () => {
    await engine?.shutdown(); await reloaded?.shutdown();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('camellia-credit-test-'));
    removeTree(root);
  });
  let config = { subscriptionAccounts: { codex: [profile, { id: 'account-1', label: 'Backup' }] } };
  const notifications = new Map(), events = [];
  const readings = {
    default: { limitId: 'codex', primary: { usedPercent: 100 }, credits: credits('58453.6') },
    'account-1': { limitId: 'codex', primary: { usedPercent: 30 }, credits: credits('25') },
  };
  const options = { dataDir: root, loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; },
    runtimes: () => ({ locate: () => ({ file: path.join(root, 'fixture.exe') }) }), onAccount: state => events.push(state),
    createAccountClient: options => {
      const id = options.env.CODEX_HOME.includes('account-1') ? 'account-1' : 'default';
      notifications.set(id, options.onNotification);
      return { ready: Promise.resolve(), shutdown: async () => {}, request: async method => {
        if (method === 'account/read') return { account: { type: 'chatgpt', email: id + '@example.com', planType: 'pro' } };
        if (method === 'model/list') return { data: [{ model: 'model', serviceTiers: [] }], nextCursor: null };
        if (method === 'account/rateLimits/read') return { rateLimits: readings[id],
          rateLimitsByLimitId: { codex: readings[id], review: { primary: { usedPercent: 5 } } } };
        if (method === 'account/logout') return {};
        throw new Error('Unexpected request: ' + method);
      } };
    } };
  engine = createCodex(options);
  await engine.handlers['account-refresh']({ id: 'default' });
  await engine.handlers['account-refresh']({ id: 'account-1' });
  const balances = () => engine.accountState().accounts.map(account => account.credits?.balance);
  assert.deepEqual(balances(), [58453.6, 25]);
  assert.equal(engine.accountState().accounts[0].exhausted, false);
  const notify = update => notifications.get('default')('account/rateLimits/updated', { rateLimits: update });
  notify({ limitId: 'codex', primary: { usedPercent: 100 }, credits: null });
  assert.deepEqual(balances(), [58453.6, 25]);
  assert.equal(engine.accountState().accounts[0].exhausted, false);
  assert.equal(engine.accountState().rateLimits.review.primary.usedPercent, 5);
  notify({ limitId: 'codex', credits: credits('58450.125') });
  assert.deepEqual(balances(), [58450.125, 25]);
  assert.equal(events.at(-1).accounts[0].credits.balance, 58450.125);
  assert.equal(readJson(path.join(root, 'codex', 'account-state.json')).rateLimits.codex.credits.balance, '58450.125');
  reloaded = createCodex(options);
  assert.equal(reloaded.accountState().accounts[0].credits.balance, 58450.125);
  notify({ limitId: 'codex', credits: credits('0') });
  assert.deepEqual(balances(), [0, 25]);
  assert.equal(engine.accountState().accounts[0].exhausted, true);
  readings.default = { ...readings.default, credits: null };
  await engine.handlers['account-refresh']({ id: 'default' });
  assert.equal(engine.accountState().accounts[0].credits, null);
  assert.equal(engine.accountState().accounts[0].exhausted, false);
  await engine.handlers['sign-out']();
  assert.equal(engine.accountState().accounts[0].credits, null);
  assert.equal(engine.accountState().accounts[1].credits.balance, 25);
});
