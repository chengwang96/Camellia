'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeSubagents } = require('../src/engines/native-subagents');
const { CodexSession } = require('../src/engines/codex-session');
const { GrokSession } = require('../src/engines/grok-session');
const { COMPLETED_TASK_LIMIT } = require('../src/shared/subagents');

test('native terminal task retention is bounded across epochs without evicting active work or recent identities', () => {
  const evicted = [], tracker = new NativeSubagents('kimi', () => {}, { onEvict: id => evicted.push(id) });
  tracker.native('waiting', { status: 'waiting', turnId: 'approval-turn', approvals: [{ requestId: 'approval' }] });
  tracker.native('running', { status: 'running', turnId: 'live-turn' });
  for (let round = 0; round < 10; round++) {
    tracker.begin();
    for (let index = 0; index < 100; index++) tracker.native('child-' + (round * 100 + index), {
      status: 'completed', turnId: 'old-turn', result: 'x'.repeat(16000),
    });
  }
  assert.equal(tracker.children.size, COMPLETED_TASK_LIMIT + 2);
  assert.equal(tracker.aliases.size, tracker.children.size);
  assert.equal(tracker.identities.size, tracker.children.size);
  assert.ok(tracker.retired.size <= 512);
  assert.equal(evicted.length, 1000 - COMPLETED_TASK_LIMIT);
  assert.equal(tracker.children.get('waiting').approvals[0].requestId, 'approval');
  assert.equal(tracker.children.get('running').turnId, 'live-turn');
  tracker.native('child-999', { status: 'completed', result: 'Late final answer' });
  assert.equal(tracker.children.get('child-999').result, 'Late final answer');
  tracker.native('child-871', { status: 'running', turnId: 'old-turn' });
  assert.equal(tracker.children.has('child-871'), false, 'old snapshots cannot revive recently evicted terminal work');
  tracker.native('child-871', { status: 'running', turnId: 'new-turn' });
  assert.equal(tracker.children.get('child-871').turnId, 'new-turn', 'a new native turn can resume an old child');
  tracker.disconnect();
  assert.equal(tracker.children.size, COMPLETED_TASK_LIMIT);
  assert.ok([...tracker.children.values()].every(task => !task.canStop && !task.approvals.length));
});

test('repeated native identity merges have bounded alias retention and preserve the current native ID', () => {
  const tracker = new NativeSubagents('claude', () => {});
  tracker.update('display', { status: 'running' });
  for (let i = 0; i < 1000; i++) tracker.bind('native-' + i, 'display');
  assert.equal(tracker.children.size, 1);
  assert.equal(tracker.aliases.size, 8);
  assert.equal(tracker.nativeId('display'), 'native-999');
  assert.equal(tracker.resolve('native-999'), 'display');
  assert.ok(tracker.retired.size <= 512);
});

test('invalid identities and repeated terminal call receipts cannot create unbounded secondary indexes', () => {
  const tracker = new NativeSubagents('kimi', () => {});
  for (let i = 0; i < 1000; i++) {
    tracker.native('invalid ' + i, { status: 'completed' });
    tracker.native('child', { toolCallId: 'receipt-' + i, status: 'completed', result: 'Final answer' });
  }
  assert.equal(tracker.children.size, 1);
  assert.equal(tracker.aliases.size, 1);
  assert.equal(tracker.identities.size, 1);
  assert.equal(tracker.calls.size, COMPLETED_TASK_LIMIT);
});

test('Codex prunes terminal task payloads, pending reads and retired turns together, preserving child controls', async t => {
  const calls = [], session = new CodexSession({ gen: 1, opts: {}, settings: {}, onEvent() {}, onResult() {}, log() {} });
  Object.assign(session, { sessionId: 'parent', childPolling: true,
    client: { request: async (...args) => { calls.push(args); return {}; } } });
  t.after(() => clearTimeout(session.childTimer));
  session.childUpdate('waiting', { status: 'waiting', turnId: 'approval-turn', approvals: [{ requestId: 'approval' }] });
  for (let i = 0; i < 1000; i++) {
    session.childUpdate('child-' + i, { status: 'completed', turnId: 'first' });
    session.childUpdate('child-' + i, { status: 'completed', turnId: 'second', result: 'x'.repeat(16000), canReply: true });
  }
  assert.equal(session.children.size, COMPLETED_TASK_LIMIT + 1);
  assert.equal(session.children.has('child-0'), false);
  assert.ok(session.childReads.size <= COMPLETED_TASK_LIMIT + 1);
  assert.ok(session.retiredChildTurns.size <= COMPLETED_TASK_LIMIT);
  assert.equal(session.children.get('waiting').approvals[0].requestId, 'approval');
  await session.controlChild('child-999', { operation: 'reply', expectedTurnId: 'second', prompt: 'Continue' });
  assert.equal(calls.at(-1)[0], 'turn/start');
  assert.equal(session.children.get('child-999').status, 'running');
});

test('Grok evicts terminal child session routes and streamed result buffers with the shared tracker', () => {
  const session = new GrokSession({ name: 'Grok', gen: 1, settings: {}, opts: {}, spec: { modeEngine: 'grok' },
    log() {}, onEvent() {}, onResult() {} });
  session.sessionId = 'root';
  for (let i = 0; i < 1000; i++) {
    const childSession = 'session-' + i;
    session.receive({ method: '_x.ai/session_notification', params: { sessionId: 'root', update: {
      sessionUpdate: 'subagent_spawned', subagent_id: 'child-' + i, child_session_id: childSession, attempt_id: 'turn-' + i,
    } } });
    session.receive({ method: 'session/update', params: { sessionId: childSession, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(16000) },
    } } });
    session.receive({ method: '_x.ai/session_notification', params: { sessionId: childSession, update: {
      sessionUpdate: 'turn_completed', stop_reason: 'end_turn',
    } } });
  }
  assert.equal(session.children.size, COMPLETED_TASK_LIMIT);
  assert.equal(session.childSessions.size, COMPLETED_TASK_LIMIT);
  assert.equal(session.childText.size, COMPLETED_TASK_LIMIT);
  assert.equal(session.children.get('child-999').result.length, 16000);
});
