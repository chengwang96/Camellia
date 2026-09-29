'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StreamingSession } = require('../src/engines/streaming-session');
const { CodexSession } = require('../src/engines/codex-session');

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
