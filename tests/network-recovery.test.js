'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restartNetworkEngines, networkChangeSummary, reapplyNetwork } = require('../src/main/network-recovery');

test('network engine refresh restarts idle engines, defers busy ones and reports failures', async () => {
  const stopped = [];
  const deferred = [];
  const logs = [];
  const result = await restartNetworkEngines({
    engines: ['claude', 'codex', 'kimi', 'grok'],
    isBusy: engine => engine === 'codex',
    stop: async engine => {
      stopped.push(engine);
      if (engine === 'kimi') throw new Error('still running');
    },
    defer: (engine, reason) => deferred.push({ engine, reason }),
    log: message => logs.push(message),
    timeoutMs: 1000,
  });
  assert.deepEqual(stopped, ['claude', 'kimi', 'grok']);
  assert.deepEqual(result.restarted, ['claude', 'grok']);
  assert.deepEqual(result.deferred, ['codex']);
  assert.deepEqual(result.failed, [{ engine: 'kimi', error: 'still running' }]);
  assert.deepEqual(deferred, [{ engine: 'codex', reason: 'network change' }]);
  assert.match(logs[0], /kimi: network change restart failed/);
});

test('only failed engine restarts or a stale live environment require a full restart', () => {
  const hot = networkChangeSummary({ restarted: ['codex'], deferred: [], failed: [] }, { consistent: true });
  assert.equal(hot.engineRestart, true);
  assert.equal(hot.restartRequired, false);

  const deferred = networkChangeSummary({ restarted: [], deferred: ['kimi'], failed: [] }, { consistent: true });
  assert.equal(deferred.engineRestart, false);
  assert.equal(deferred.restartRequired, false);

  const failed = networkChangeSummary({ restarted: [], deferred: [], failed: [{ engine: 'codex', error: 'timeout' }] },
    { consistent: true });
  assert.equal(failed.engineRestart, false);
  assert.equal(failed.restartRequired, true);

  const stale = networkChangeSummary({ restarted: ['codex'], deferred: [], failed: [] }, { consistent: false });
  assert.equal(stale.environmentConsistent, false);
  assert.equal(stale.restartRequired, true);
});

test('reapplyNetwork hot-applies the connection, restarts engines and verifies the result', async () => {
  const calls = [];
  const result = await reapplyNetwork({
    networkSettings: {
      async reapply() { calls.push('reapply'); return { mode: 'auto', configured: 'auto' }; },
      verify() { calls.push('verify'); return { consistent: true, expected: '', actual: '' }; },
    },
    restartEngines: async () => {
      calls.push('restart');
      return { restarted: ['claude', 'codex'], deferred: [], failed: [] };
    },
  });
  assert.deepEqual(calls, ['reapply', 'restart', 'verify']);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'auto');
  assert.equal(result.engineRestart, true);
  assert.equal(result.restartRequired, false);
  assert.equal(result.verification.consistent, true);
});

test('reapplyNetwork reports a full restart when the live transport cannot be applied', async () => {
  const logs = [];
  const result = await reapplyNetwork({
    networkSettings: {
      async reapply() { throw new Error('proxy bridge unavailable'); },
      verify() { return { consistent: false }; },
    },
    restartEngines: async () => { throw new Error('engines must not restart after a failed apply'); },
    log: message => logs.push(message),
  });
  assert.equal(result.ok, false);
  assert.equal(result.restartRequired, true);
  assert.equal(result.error, 'proxy bridge unavailable');
  assert.match(logs[0], /network reapply failed/);
});
