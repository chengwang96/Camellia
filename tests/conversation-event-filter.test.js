'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ConversationEventFilter } = require('../src/main/conversation-event-filter');
const { createHarness } = require('./main-process-harness.cjs');

test('desktop content follows the selected conversation while lifecycle events remain global', () => {
  const filter = new ConversationEventFilter(), contents = {};
  const selected = randomUUID(), other = randomUUID();
  filter.watch(contents, { sessionId: selected });
  for (const type of ['stream_event', 'assistant', 'user', 'system', 'result', 'gui:tool', 'gui:plan', 'gui:permission', 'gui:subagent']) {
    assert.equal(filter.allows(contents, { type, session_id: selected }), true, type);
    assert.equal(filter.allows(contents, { type, session_id: other }), false, type);
  }
  for (const type of ['conversation:started', 'conversation:activity', 'conversation:turn-end', 'conversation:title', 'conversation:task', 'conversation:review-consent'])
    assert.equal(filter.allows(contents, { type, session_id: other }), true, type);
  assert.equal(filter.allows(contents, { type: 'global-notice' }), true);

  // Interleaving background sessions must not serialize any of their tokens
  // into desktop IPC; selecting another session changes the destination at once.
  let delivered = 0;
  const background = Array.from({ length: 4 }, () => randomUUID());
  for (let i = 0; i < 10000; i++) delivered += filter.allows(contents, {
    type: 'stream_event', session_id: background[i % background.length],
  });
  assert.equal(delivered, 0);
  filter.watch(contents, { sessionId: other });
  assert.equal(filter.allows(contents, { type: 'gui:tool', session_id: other }), true);
  assert.equal(filter.allows(contents, { type: 'gui:tool', session_id: selected }), false);
});

test('empty views mute content and pending new/forked sends retain early output', () => {
  const filter = new ConversationEventFilter(), contents = {}, otherWindow = {};
  const id = randomUUID(), event = { type: 'stream_event', session_id: id };
  assert.equal(filter.allows(contents, event), true, 'compatibility with an unsubscribed renderer');
  filter.watch(contents, {});
  assert.equal(filter.allows(contents, event), false);
  filter.watch(contents, { pending: true });
  assert.equal(filter.allows(contents, event), true, 'the new id is not known until send returns');
  filter.watch(contents, { sessionId: id });
  assert.equal(filter.allows(contents, event), true);
  assert.throws(() => filter.watch(contents, { sessionId: '../invalid' }), /Invalid conversation/);
  assert.equal(filter.allows(contents, event), true, 'invalid updates preserve the current view');
  filter.watch(otherWindow, {});
  assert.equal(filter.allows(contents, event), true, 'windows have independent subscriptions');
  filter.watch(contents, {});
  assert.equal(filter.allows(contents, event), false, 'leaving or cancelling resets the pending subscription');
});

test('main IPC filters background output without changing live snapshots or saved replies', async t => {
  const h = createHarness(); t.after(() => h.cleanup()); h.configureApi();
  h.api.sharedConversations.prepare = async () => {};
  const contents = { send: (channel, data) => h.events.push({ channel, data }) };
  h.api.setWindow({ isDestroyed: () => false, setTitle() {}, webContents: contents });
  const watch = payload => h.call('conversation-watch', payload, { sender: contents });
  assert.equal(h.call('conversation-watch', {}, { sender: {} }).ok, false);
  assert.equal(watch({ sessionId: '../invalid' }).ok, false);
  const send = prompt => h.call('conversation-command', { engine: 'claude', action: 'send', payload: { prompt } });
  const a = await send('Conversation A'), b = await send('Conversation B');
  assert.equal(a.ok, true, a.error); assert.equal(b.ok, true, b.error);
  const [pa, pb] = h.processes;
  const token = (proc, text) => proc.stdout.emit('data', JSON.stringify({ type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }) + '\n');
  const stream = id => h.events.filter(e => e.channel === 'dsh:conversation-event'
    && e.data.session_id === id && e.data.type === 'stream_event');
  assert.equal(watch({ sessionId: a.sessionId }).ok, true);
  token(pb, 'Background token'); token(pa, 'Foreground token');
  assert.equal(stream(b.sessionId).length, 0);
  assert.equal(stream(a.sessionId).length, 1);
  const snapshot = await h.call('conversation-command', { engine: 'claude', action: 'load-session', payload: b.sessionId });
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.ok(snapshot.live.events.some(e => e.event?.delta?.text === 'Background token'));
  assert.equal(watch({ sessionId: b.sessionId }).ok, true);
  token(pb, 'Now visible'); token(pa, 'Now background');
  assert.equal(stream(b.sessionId).length, 1);
  assert.equal(stream(a.sessionId).length, 1);
  h.finishTurn(pa); h.finishTurn(pb);
  assert.ok(h.events.some(e => e.data.type === 'conversation:turn-end' && e.data.session_id === a.sessionId));
  for (const id of [a.sessionId, b.sessionId]) {
    const history = await h.call('conversation-command', { engine: 'claude', action: 'load-session', payload: id });
    assert.ok(history.messages.some(row => row.role === 'assistant' && row.text === 'Test response'));
  }
});
