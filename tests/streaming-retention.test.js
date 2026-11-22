'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StreamingSession } = require('../src/engines/streaming-session');
const { CodexSession } = require('../src/engines/codex-session');
const { replaceToolSnapshot } = require('../src/engines/tool-history');

test('completed turns release replay and Codex output indexes after delivering the result', () => {
  for (const Session of [StreamingSession, CodexSession]) {
    let delivered;
    const session = new Session({});
    Object.assign(session, { running: true, text: 'answer', replayEvents: [{ text: 'x'.repeat(1000000) }],
      permissions: new Map(), opts: {}, onEvent: event => { delivered = event; }, onResult() {}, log() {},
      outputItems: new Map(), outputBlocks: [], eventSeq: 0, startedAt: Date.now() });
    session.finish({ subtype: 'success' });
    assert.equal(delivered.type, 'result');
    assert.deepEqual(session.replayEvents, []);
    assert.equal(session.running, false);
  }
});

test('live replay replaces tool snapshots by id while preserving their original position', () => {
  const session = new StreamingSession();
  Object.assign(session, { running: true, replayEvents: [], opts: {}, gen: 4, eventSeq: 0, onEvent() {} });
  session.emit({ type: 'gui:plan', entries: [] });
  for (let index = 0; index < 10000; index++) session.emit({ type: 'gui:tool', id: 'write', status: 'running', output: 'partial ' + index });
  session.emit({ type: 'gui:tool', id: 'read', status: 'completed', output: 'done' });
  session.emit({ type: 'gui:tool', id: 'write', status: 'completed', output: 'final' });
  assert.equal(session.replayEvents.length, 3);
  assert.deepEqual(session.replayEvents.map(event => [event.type, event.id, event.status, event.output]), [
    ['gui:plan', undefined, undefined, undefined], ['gui:tool', 'write', 'completed', 'final'], ['gui:tool', 'read', 'completed', 'done'],
  ]);
  assert.equal(session.replayEvents[1].eventSeq, 10003);
});

test('tool snapshot indexes avoid rescanning many unique tools during reverse updates', () => {
  const events = [];
  for (let index = 0; index < 1000; index++) {
    const event = { type: 'gui:tool', id: 'tool-' + index, status: 'running', output: 'partial' };
    assert.equal(replaceToolSnapshot(events, event), false);
    events.push(structuredClone(event));
  }
  events.findIndex = () => { throw new Error('Indexed tool updates must not scan the event history'); };
  for (let index = events.length - 1; index >= 0; index--) {
    const event = { type: 'gui:tool', id: 'tool-' + index, status: 'completed', output: 'final-' + index };
    assert.equal(replaceToolSnapshot(events, event), true);
    assert.equal(events[index].output, 'final-' + index);
  }
  assert.equal(events.length, 1000);
  assert.deepEqual(events.map(event => event.id), Array.from({ length: 1000 }, (_, index) => 'tool-' + index));
});
