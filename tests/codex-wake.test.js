'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wakeAccount } = require('../src/engines/codex-wake');

for (const outcome of ['completed', 'failed', 'timeout', 'close', 'start-error']) test('account greeting: ' + outcome, async () => {
  const calls = []; let stopped = false;
  const action = wakeAccount({ cwd: '/isolated-wake', model: 'account-model', timeoutMs: 30,
    createClient: callbacks => ({ ready: Promise.resolve(), write() {}, shutdown: async () => { stopped = true; },
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/start') {
          if (outcome === 'start-error') throw new Error('invalid credentials');
          return { thread: { id: 'wake-1' } };
        }
        if (outcome === 'close') callbacks.onClose(new Error('closed'));
        else if (outcome !== 'timeout') callbacks.onNotification('turn/completed', { threadId: 'wake-1', turn: { status: outcome, error: { message: 'quota exceeded' } } });
        return { turn: { id: 'turn-1' } };
      } }) });
  if (outcome === 'completed') await action;
  else await assert.rejects(action, /quota exceeded|timed out|closed|invalid credentials/);
  assert.equal(stopped, true);
  assert.equal(calls[0].params.ephemeral, true);
  assert.equal(calls[0].params.sandbox, 'read-only');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, outcome === 'start-error' ? 0 : 1);
  if (calls[1]) assert.deepEqual(calls[1].params.input, [{ type: 'text', text: '你好' }]);
});

test('account greeting records reported tokens on its selected subscription, including a failed turn', async () => {
  const { createSubscriptionMeter } = require('../src/engines/subscription-meter');
  for (const status of ['completed', 'failed']) {
    const records = [];
    const usageMeter = createSubscriptionMeter({ engine: 'codex', accountId: 'account-2', model: 'gpt-5.4', record: row => records.push(row) });
    const action = wakeAccount({ cwd: '/isolated-wake', model: 'gpt-5.4', usageMeter,
      createClient: callbacks => ({ ready: Promise.resolve(), shutdown: async () => {},
        request: async method => {
          if (method === 'thread/start') return { thread: { id: 'wake-meter' } };
          const usage = { inputTokens: 500, outputTokens: 10, cachedInputTokens: 200 };
          callbacks.onNotification('thread/tokenUsage/updated', { threadId: 'wake-meter', tokenUsage: { total: usage, last: usage } });
          callbacks.onNotification('turn/completed', { threadId: 'wake-meter', turn: { status } });
          return { turn: { id: 'turn-meter' } };
        } }) });
    if (status === 'completed') await action;
    else await assert.rejects(action, /did not complete/);
    assert.equal(records.length, 1);
    assert.equal(records[0].accountId, 'account-2');
    assert.equal(records[0].outcome, status === 'completed' ? 'requests' : 'failures');
    assert.equal(records[0].samples[0].input, 500);
    assert.equal(records[0].samples[0].output, 10);
  }
});
