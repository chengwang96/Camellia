'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { approval, answer } = require('../src/main/remote/approvals');
test('questions support single, multiple and free text without silently approving empty answers', () => {
  const event = { requestId: 'native', toolName: 'Ask', questions: [
    { id: 'single', question: 'Pick', options: [{ label: 'A', description: 'First' }] },
    { id: 'multi', question: 'Pick several', multiSelect: true }, { id: 'secret', question: 'Type', isSecret: true }] };
  const view = approval(event);
  assert.equal(view.actionable, false); // Old APKs must not turn questions into allow/deny.
  assert.equal(view.responseSupported, true); assert.equal(view.questions[2].isSecret, true);
  const payload = { fingerprint: view.fingerprint, allow: true, input: { single: 'A', multi: ['A', 'Custom'], secret: 'value' } };
  assert.deepEqual(answer(event, payload).input, payload.input);
  assert.throws(() => answer(event, { ...payload, input: {} }), /Answer/);
  assert.throws(() => answer(event, { ...payload, input: { ...payload.input, extra: 'bad' } }), /Invalid/);
  assert.throws(() => answer({ ...event, reason: 'changed' }, payload), /changed/);
  assert.deepEqual(answer(event, { fingerprint: view.fingerprint, allow: false }), { allow: false });
});
test('only scoped one-time options can be forwarded and oversized requests are not actionable', () => {
  const event = { requestId: 'native', options: [{ optionId: 'one', kind: 'allow_once', name: 'Allow' }, { optionId: 'forever', kind: 'allow_always', name: 'Always' }] };
  const payload = { fingerprint: approval(event).fingerprint, allow: true };
  assert.equal(answer(event, payload).optionId, 'one');
  assert.throws(() => answer(event, { ...payload, optionId: 'forever' }), /unavailable/);
  assert.equal(approval({ input: { data: 'x'.repeat(33000) } }).responseSupported, false);
});
