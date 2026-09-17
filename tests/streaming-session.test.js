'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamingSession } = require('../src/engines/streaming-session');

test('native replay keeps typeless message deltas separate from block deltas', () => {
  const session = Object.assign(new StreamingSession(), { opts: {}, gen: 1, eventSeq: 0, running: true, replayEvents: [], onEvent() {} });
  assert.doesNotThrow(() => {
    session.emit({ type: 'assistant', message: { content: [] } });
    session.emitStream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  });
  for (const [type, key] of [['text_delta', 'text'], ['thinking_delta', 'thinking'], ['input_json_delta', 'partial_json']]) {
    session.emitStream({ type: 'content_block_start', index: 0 });
    for (const part of ['first', 'second']) session.emitStream({ type: 'content_block_delta', index: 0, delta: { type, [key]: part } });
    session.emitStream({ type: 'content_block_stop', index: 0 });
    const chunks = session.replayEvents.filter(event => event.event?.delta?.type === type);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].event.delta[key], 'firstsecond');
  }
  assert.equal(session.replayEvents[1].event.delta.stop_reason, 'tool_use');
});
