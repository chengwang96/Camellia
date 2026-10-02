'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareTextInput } = require('../src/engines/discussions/context');
function fixture() {
  const delivery = { id: 'delivery', participantId: 'a', generation: 1, runtimeId: 'runtime', requestId: 'request', inputThroughSeq: 3, profile: { contextWindow: 32000 } };
  const state = { participants: [{ id: 'a', name: 'Reviewer', session: { generation: 1, coveredThroughSeq: 1, nativeId: 'native', nativeOwnMessageIds: ['own'] } }],
    requests: [{ id: 'request', messageId: 'question' }], deliveries: [], messages: [
      { id: 'old', seq: 1, role: 'user', text: 'Already covered' },
      { id: 'peer', seq: 2, role: 'assistant', speakerId: 'b', speakerName: 'Peer', text: 'Useful evidence' },
      { id: 'question', seq: 3, role: 'user', text: 'Unique current question' },
      { id: 'future', seq: 4, role: 'user', text: 'Must not leak future' },
    ] };
  return { state, delivery };
}
test('text context preserves attribution, emits current request once and excludes future and covered messages', () => {
  const { state, delivery } = fixture(), plan = prepareTextInput(state, delivery);
  assert.match(plan.prompt, /Useful evidence/); assert.match(plan.prompt, /"speaker":"Peer"/);
  assert.ok(!plan.prompt.includes('Already covered')); assert.ok(!plan.prompt.includes('Must not leak future'));
  assert.equal(plan.prompt.split('Unique current question').length, 2); assert.equal(plan.inputThroughSeq, 3);
});
test('a fresh member receives earlier history and budget overflow or missing capacity does not silently truncate', () => {
  const { state, delivery } = fixture(); state.participants[0].session.coveredThroughSeq = 0; state.participants[0].session.nativeId = null;
  assert.match(prepareTextInput(state, delivery).prompt, /Already covered/);
  delivery.profile.contextWindow = 1024; state.messages[1].text = '中文'.repeat(1000);
  assert.throws(() => prepareTextInput(state, delivery), error => error.code === 'DISCUSSION_CONTEXT_FULL');
  delivery.profile.contextWindow = 0;
  assert.throws(() => prepareTextInput(state, delivery), error => error.code === 'DISCUSSION_CONTEXT_UNKNOWN');
  assert.throws(() => prepareTextInput(state, delivery, { aborted: true }), { name: 'AbortError' });
});

test('identity guidance comes only from this delivery snapshot and counts toward context budget', () => {
  const { state, delivery } = fixture();
  state.participants[0].identityPrompt = 'A later edit that must not affect the snapshot';
  state.participants.push({ id: 'b', identityPrompt: 'Private peer identity' });
  delivery.identityPrompt = 'You are a scientist. Explain uncertainty.';
  const prompt = prepareTextInput(state, delivery).prompt;
  assert.match(prompt, /User-defined identity guidance for you: "You are a scientist\. Explain uncertainty\."/);
  assert.ok(!prompt.includes('A later edit')); assert.ok(!prompt.includes('Private peer identity'));
  delivery.identityPrompt = '';
  assert.ok(!prepareTextInput(state, delivery).prompt.includes('User-defined identity guidance for you:'));
  delivery.profile.contextWindow = 2048; delivery.identityPrompt = '证据'.repeat(500);
  assert.throws(() => prepareTextInput(state, delivery), error => error.code === 'DISCUSSION_CONTEXT_FULL');
});
