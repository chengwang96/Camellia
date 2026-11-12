'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const probe = require('../src/engines/codex-weekly-probe');
const { createCodex } = require('../src/engines/codex');

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const seconds = value => Math.floor(value / 1000);
const limits = ({ weeklyReset, weeklyUsed = 0, primaryReset = NOW + 60 * 60 * 1000 }) => ({ codex: {
  primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: seconds(primaryReset) },
  secondary: { usedPercent: weeklyUsed, windowDurationMins: 10080, resetsAt: weeklyReset === null ? null : seconds(weeklyReset) },
} });

test('weekly probe ignores shorter windows and future reset times', () => {
  assert.deepEqual(probe.weeklyWindows({ primary: { windowDurationMins: 300, resetsAt: 1 } }), []);
  assert.equal(probe.weeklyWindows(limits({ weeklyReset: NOW + 1000 }))[0].id, 'codex:secondary');
  assert.deepEqual(probe.dueWeeklyProbe({ rateLimits: limits({ weeklyReset: NOW + 1000 }), now: NOW }), []);
  assert.deepEqual(probe.nextWeeklyReset(limits({ weeklyReset: NOW + 1000 }), NOW), seconds(NOW + 1000));
});

test('weekly probe becomes due after the known reset elapses and stops after a successful greeting', () => {
  const elapsed = limits({ weeklyReset: NOW - 1000, weeklyUsed: 100 });
  const due = probe.dueWeeklyProbe({ rateLimits: elapsed, now: NOW });
  assert.deepEqual(due, [{ id: 'codex:secondary', resetAt: seconds(NOW - 1000) }]);
  const attempted = probe.markWeeklyAttempt({}, due, NOW);
  assert.deepEqual(probe.dueWeeklyProbe({ rateLimits: elapsed, records: attempted, now: NOW + 1000 }), []);
  const retried = probe.dueWeeklyProbe({ rateLimits: elapsed, records: attempted, now: NOW + probe.PROBE_RETRY_MS });
  assert.equal(retried.length, 1);
  const completed = probe.markWeeklyProbe(attempted, due, { at: new Date(NOW + 2000) });
  assert.equal(completed['codex:secondary'].probe.resetAt, seconds(NOW - 1000));
  assert.deepEqual(probe.dueWeeklyProbe({ rateLimits: elapsed, records: completed, now: NOW + probe.PROBE_RETRY_MS }), []);
});

test('weekly probe keeps the last known reset time when a later reading omits it', () => {
  const records = probe.observeWeekly(limits({ weeklyReset: NOW + 1000 }), {}, NOW);
  assert.equal(records['codex:secondary'].lastResetAt, seconds(NOW + 1000));
  assert.deepEqual(probe.dueWeeklyProbe({ rateLimits: limits({ weeklyReset: null }), records, now: NOW + 500 }), []);
  assert.equal(probe.dueWeeklyProbe({ rateLimits: limits({ weeklyReset: null }), records, now: NOW + 2000 }).length, 1);
});

test('a failed weekly greeting retries after the cooldown', () => {
  const elapsed = limits({ weeklyReset: NOW - 1000 });
  const failed = probe.markWeeklyFailure({}, [{ id: 'codex:secondary', resetAt: seconds(NOW - 1000) }],
    { at: new Date(NOW), error: 'offline' });
  assert.equal(failed['codex:secondary'].error, 'offline');
  assert.equal(probe.dueWeeklyProbe({ rateLimits: elapsed, records: failed, now: NOW + 1000 }).length, 0);
  assert.equal(probe.dueWeeklyProbe({ rateLimits: elapsed, records: failed, now: NOW + probe.PROBE_RETRY_MS }).length, 1);
});

function fixture({ enabled }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-weekly-probe-'));
  let config = enabled ? { subscriptionWeeklyProbe: { codex: true } } : {};
  const now = Date.now();
  let weeklyReset = Math.floor((now - 60000) / 1000), sent = false, turns = 0, wakeOptions;
  const accountClient = { ready: Promise.resolve(), shutdown: async () => {}, request: async method => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'weekly@example.test', planType: 'plus' } };
    if (method === 'model/list') return { data: [{ model: 'gpt-weekly', isDefault: true, serviceTiers: [] }], nextCursor: null };
    if (method === 'account/rateLimits/read') return { rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 },
      secondary: { usedPercent: sent ? 0 : 100, windowDurationMins: 10080, resetsAt: weeklyReset },
    } };
    if (method === 'account/logout') return {};
    throw new Error('Unexpected request: ' + method);
  } };
  let notifications;
  const wakeClient = { ready: Promise.resolve(), shutdown: async () => {}, write() {}, request: async method => {
    if (method === 'thread/start') return { thread: { id: 'wake-thread' } };
    if (method === 'turn/start') {
      turns++; sent = true; weeklyReset = Math.floor(Date.now() / 1000) + 7 * 86400;
      setTimeout(() => notifications.onNotification('turn/completed', { threadId: 'wake-thread', turn: { status: 'completed' } }), 0);
      return { turn: { id: 'wake-turn' } };
    }
    throw new Error('Unexpected request: ' + method);
  } };
  const engine = createCodex({
    dataDir: root, loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; },
    runtimes: () => ({ locate: () => ({ file: path.join(root, 'fixture.exe') }) }),
    createAccountClient: options => {
      if (options.onRequest) { wakeOptions = options; notifications = options; return wakeClient; }
      return accountClient;
    },
  });
  return { root, engine, turns: () => turns, wakeOptions: () => wakeOptions, sent: () => sent };
}

async function waitFor(check, message) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('a detected weekly refresh sends one greeting and records the new reset time', async t => {
  const f = fixture({ enabled: true });
  t.after(async () => { await f.engine.shutdown(); removeTree(f.root); });
  await f.engine.handlers['account-refresh']({ id: 'default' });
  await waitFor(() => f.turns() === 1 && f.engine.accountState().weeklyProbe?.['codex:secondary']?.probe?.sentAt,
    'The automatic greeting did not run');
  const state = f.engine.accountState();
  assert.equal(state.rateLimits.codex.secondary.usedPercent, 0);
  assert.ok(state.rateLimits.codex.secondary.resetsAt > Math.floor(Date.now() / 1000) + 6 * 86400);
  assert.equal(f.wakeOptions().env.CODEX_HOME, state.home);
  assert.match(f.wakeOptions().args.join(' '), /app-server/);
  await f.engine.handlers['account-refresh']({ id: 'default' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.turns(), 1);
});

test('the weekly greeting stays off until the preference is enabled', async t => {
  const f = fixture({ enabled: false });
  t.after(async () => { await f.engine.shutdown(); removeTree(f.root); });
  await f.engine.handlers['account-refresh']({ id: 'default' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.turns(), 0);
  assert.equal(f.engine.accountState().weeklyProbe, undefined);
});
