'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionFailure } = require('../src/engines/subscription-recovery');

test('Codex terminal retry exhaustion is recognized from native metadata or legacy messages', () => {
  for (const codexErrorInfo of ['responseTooManyFailedAttempts', { responseTooManyFailedAttempts: { httpStatusCode: 503 } }]) {
    assert.equal(subscriptionFailure({ is_error: true, result: 'Connection failed', codexErrorInfo }, 'codex'), 'retry');
  }
  for (const result of ['exceeded retry limit', 'Retry limit reached', 'Retries exhausted', 'Retry attempts exhausted',
    'Too many failed attempts', 'Request failed after 5 retries']) {
    assert.equal(subscriptionFailure({ type: 'result', is_error: true, result }, 'codex'), 'retry');
    assert.equal(subscriptionFailure({ is_error: true, result }, 'kimi'), null);
  }
});

test('transient retry notices, tool output and unrelated failures never trigger account rotation', () => {
  for (const event of [
    { is_error: false, result: 'exceeded retry limit' },
    { type: 'gui:tool', is_error: true, result: 'exceeded retry limit' },
    { type: 'error', is_error: true, result: 'exceeded retry limit', willRetry: true },
    { is_error: true, result: 'Reconnecting... 1/5' },
    { is_error: true, result: 'Connection reset' },
    { is_error: true, result: 'File not found' },
  ]) assert.equal(subscriptionFailure(event, 'codex'), null);
});
