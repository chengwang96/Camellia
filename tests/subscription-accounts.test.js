'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const accounts = require('../src/engines/subscription-accounts');

test('account lists always keep the legacy default account first and ignore duplicates', () => {
  const list = accounts.normalizeAccounts([{ id: 'account-2', label: ' Work ' }, { id: 'account-2' }, { id: 'Bad ID' }, { id: 'default', label: 'Personal' }]);
  assert.deepEqual(list, [{ id: 'default', label: 'Personal' }, { id: 'account-2', label: 'Work' }]);
  assert.deepEqual(accounts.normalizeAccounts(null), [{ id: 'default', label: '' }]);
  assert.equal(accounts.nextAccountId(list), 'account-1');
});

test('the active account falls back to default when the stored choice disappeared', () => {
  const config = { subscriptionAccounts: { kimi: [{ id: 'default' }, { id: 'account-1' }] }, subscriptionActive: { kimi: 'account-9' } };
  assert.equal(accounts.activeAccountId(config, 'kimi'), 'default');
  assert.equal(accounts.activeAccountId({ ...config, subscriptionActive: { kimi: 'account-1' } }, 'kimi'), 'account-1');
});

test('only the default account reuses the single-account home directory', () => {
  const userData = path.join('C:', 'app');
  assert.equal(accounts.accountHome({ userData, engine: 'kimi', id: 'default', root: path.join(userData, 'kimi-subscription') }), path.join(userData, 'kimi-subscription'));
  assert.equal(accounts.accountHome({ userData, engine: 'kimi', id: 'account-1', root: path.join(userData, 'kimi-subscription') }),
    path.join(userData, 'subscription-accounts', 'kimi', 'account-1'));
});

test('quota verdicts cover Kimi usage windows and every Codex rate-limit bucket', () => {
  assert.equal(accounts.accountExhausted('kimi', { usage: { windows: [{ usedPercent: 99 }] } }), false);
  assert.equal(accounts.accountExhausted('kimi', { usage: { windows: [{ usedPercent: 100 }] } }), true);
  assert.equal(accounts.accountExhausted('codex', { rateLimits: { primary: { usedPercent: 100 }, secondary: { usedPercent: 10 } } }), true);
  assert.equal(accounts.accountExhausted('codex', { rateLimits: { codex: { primary: { usedPercent: 20 }, secondary: { usedPercent: 30 } } } }), false);
  assert.equal(accounts.accountExhausted('codex', { rateLimits: null }), false);
  assert.equal(accounts.accountExhausted('antigravity', { models: [] }), false);
});

test('signed-in state matches each engine account API', () => {
  assert.equal(accounts.accountSignedIn('kimi', { account: { name: 'Kimi Code' } }), true);
  assert.equal(accounts.accountSignedIn('codex', { account: null }), false);
  assert.equal(accounts.accountSignedIn('codex', { account: { email: 'a@b.c' } }), true);
  assert.equal(accounts.accountSignedIn('antigravity', { verifiedAt: 1, models: [] }), true);
  assert.equal(accounts.accountSignedIn('antigravity', {}), false);
});

test('a new session prefers the conversation binding, then the selected account, then a usable account', () => {
  const list = accounts.normalizeAccounts([{ id: 'default' }, { id: 'account-1' }, { id: 'account-2' }]);
  const base = {
    engine: 'kimi', accounts: list, activeId: 'default',
    states: {
      default: { account: { email: 'primary@example.com' }, usage: { windows: [{ usedPercent: 100 }] } },
      'account-1': { account: { email: 'backup@example.com' }, usage: { windows: [{ usedPercent: 10 }] } },
      'account-2': { account: { email: 'extra@example.com' }, usage: { windows: [{ usedPercent: 5 }] } },
    },
  };
  assert.equal(accounts.usableAccountId({ ...base }), 'account-1');
  assert.equal(accounts.usableAccountId({ ...base, preferId: 'account-2' }), 'account-2');
  assert.equal(accounts.usableAccountId({ ...base, activeId: 'account-2', preferId: 'account-2' }), 'account-2');
  // An exhausted conversation binding still wins over switching silently.
  assert.equal(accounts.usableAccountId({ ...base, preferId: 'default', activeId: 'account-2' }), 'account-2');
  // When every signed-in account is exhausted, one is still used so the quota
  // error stays visible instead of the account looking signed out.
  const exhausted = { ...base, states: Object.fromEntries(Object.entries(base.states).map(([id, state]) =>
    [id, { ...state, usage: { windows: [{ usedPercent: 100 }] } }])) };
  assert.equal(accounts.usableAccountId(exhausted), 'default');
  // With nothing signed in, the configured account is kept for the sign-in hint.
  assert.equal(accounts.usableAccountId({ ...base, states: {} }), 'default');
});

test('account summaries expose sign-in, quota and identity per account', () => {
  const list = accounts.normalizeAccounts(null);
  const summaries = accounts.accountSummaries({ engine: 'codex', accounts: list, activeId: 'default',
    states: { default: { account: { email: 'a@b.c', planType: 'plus' }, models: [{ id: 'm' }], rateLimits: { primary: { usedPercent: 100 } } } } });
  assert.deepEqual(summaries, [{ id: 'default', label: '', active: true, signedIn: true, exhausted: true, installed: true,
    loginPending: false, error: '', models: 1, email: 'a@b.c', plan: 'plus' }]);
});

test('a conversation keeps its account; only a new conversation fails over to available quota', () => {
  const list = accounts.normalizeAccounts([{ id: 'default' }, { id: 'account-1' }]);
  const states = {
    default: { account: { email: 'primary@example.com' }, usage: { windows: [{ usedPercent: 100 }] } },
    'account-1': { account: { email: 'backup@example.com' }, usage: { windows: [{ usedPercent: 0 }] } },
  };
  const base = { engine: 'kimi', accounts: list, states, activeId: 'default' };
  // An existing conversation stays on the account that owns its thread even
  // though that account is out of quota.
  assert.equal(accounts.boundAccountId({ ...base, preferId: 'default' }), 'default');
  // A new conversation (no binding) moves to the account that still has quota.
  assert.equal(accounts.boundAccountId({ ...base }), 'account-1');
  // A binding to a removed account also fails over.
  assert.equal(accounts.boundAccountId({ ...base, preferId: 'account-9' }), 'account-1');
});

// A fake engine account service: one signed-in account per home directory.
function fakePool() {
  let config = {};
  const loadConfig = () => config;
  const saveConfig = patch => { config = { ...config, ...patch }; return config; };
  const events = [];
  const pool = accounts.createAccountPool({ engine: 'kimi', userData: path.join('C:', 'app'), root: path.join('C:', 'app', 'kimi-subscription'),
    bindingsKey: 'kimiSessionAccounts', loadConfig, saveConfig, onState: state => events.push(state),
    createService: (profile, notify) => ({ profile, signedIn: false, exhausted: false,
      state() { return { account: this.signedIn ? { name: profile.label || profile.id } : null, models: this.signedIn ? [{ id: 'm' }] : [],
        usage: { windows: this.exhausted ? [{ usedPercent: 100 }] : [] }, home: profile.home }; },
      async signIn() { this.signedIn = true; notify(); },
      async signOut() { this.signedIn = false; notify(); },
      async refreshUsage() { return this.state(); }, async refresh() { return this.state(); },
      async cancelLogin() { return this.state(); }, async openLogin() { return this.state(); },
      async shutdown() {}, get active() { return false; } }) });
  return { pool, events, services: () => pool.states(), loadConfig };
}

test('the pool keeps one service per account and follows the selected account', async () => {
  const { pool } = fakePool();
  assert.deepEqual(pool.list().map(account => account.id), ['default']);
  const added = pool.add('Team');
  assert.equal(added, 'account-1');
  assert.equal(pool.activeId(), 'account-1');
  await pool.signIn();
  assert.equal(pool.state().account.name, 'Team');
  await pool.select('default');
  assert.equal(pool.state().account, null);
  // Both services stay alive so a signed-in account is not silently dropped.
  const added2 = pool.add('Backup');
  await pool.signIn(added2);
  assert.equal(Object.keys(pool.states()).length, 3);
  assert.equal(pool.state(added2).account.name, 'Backup');
});

test('the pool binds a new conversation to a signed-in account with quota', async () => {
  const { pool } = fakePool();
  const second = pool.add('Backup');
  await pool.signIn(second);
  await pool.select('default');
  await pool.signIn('default');
  // The selected default account is exhausted, so a new conversation fails over.
  pool.service('default').exhausted = true;
  assert.equal(pool.bind(null), 'account-1');
  // Once bound, the conversation keeps its account even when that one is spent.
  assert.equal(pool.bind('sess-1'), 'account-1');
  pool.service('account-1').exhausted = true;
  assert.equal(pool.bind('sess-1'), 'account-1');
});

test('removing an added account signs out, forgets it and returns to the default account', async () => {
  const { pool } = fakePool();
  const id = pool.add('Backup');
  await pool.signIn(id);
  await pool.remove(id);
  assert.deepEqual(pool.list().map(account => account.id), ['default']);
  assert.equal(pool.activeId(), 'default');
  // The default account is only signed out, never dropped.
  await pool.signIn('default');
  await pool.remove('default');
  assert.deepEqual(pool.list().map(account => account.id), ['default']);
  assert.equal(pool.state().account, null);
});

test('one unreadable account file reports an error for that row only', () => {
  const { pool } = fakePool();
  pool.service('default').state = () => { throw new Error('Cannot read configuration'); };
  const state = pool.state();
  assert.equal(state.error, 'Cannot read configuration');
  assert.deepEqual(state.accounts.map(account => [account.id, account.error]), [['default', 'Cannot read configuration']]);
});
