'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotDelta } = require('../src/main/remote/stream-delta');
const { RemoteGateway } = require('../src/main/remote/gateway');

test('live deltas append text and retain unchanged metadata and process entries', () => {
  const first = { instanceId: 'server', cursor: 1, historyVersion: 'history', settings: { model: 'fixture' },
    live: { runId: 4, eventSeq: 1, text: '你好🙂', textTruncated: false, process: [{ type: 'tool', text: 'ready' }] } };
  const next = { ...first, cursor: 2, live: { ...first.live, eventSeq: 2, text: first.live.text + ' next' } };
  const patch = snapshotDelta(first, next);
  assert.equal(patch.delta, true);
  assert.equal(patch.cursor, 2);
  assert.equal(patch.live.textDelta, ' next');
  assert.equal(patch.live.textBaseLength, first.live.text.length);
  assert.equal(patch.live.baseEventSeq, 1);
  assert.equal(patch.live.text, undefined);
  assert.equal(patch.live.process, undefined);
  assert.equal(patch.settings, undefined);
  assert.equal(patch.historyVersion, undefined);
});

test('live deltas fall back to complete live state for replacements and new runs', () => {
  const first = { instanceId: 'server', cursor: 1, live: { runId: 4, eventSeq: 2, text: 'abcdef', process: [] } };
  for (const live of [{ ...first.live, text: 'changed' }, { ...first.live, runId: 5, text: 'abcdef next' }]) {
    const patch = snapshotDelta(first, { ...first, cursor: 2, live });
    assert.equal(patch.live.text, live.text);
    assert.equal(patch.live.textDelta, undefined);
  }
  const next = { instanceId: 'restarted', cursor: 1, live: first.live };
  assert.equal(snapshotDelta(first, next), next);
});

test('snapshot deltas remove absent fields explicitly and keep complete initial snapshots', () => {
  const full = { instanceId: 'server', cursor: 1, queue: [{ id: 'one' }], live: null };
  assert.equal(snapshotDelta(null, full), full);
  const patch = snapshotDelta(full, { instanceId: 'server', cursor: 2, live: null });
  assert.equal(patch.delta, true);
  assert.equal(patch.queue, null);
  assert.equal(patch.live, undefined);
});

test('publishing an event does not synchronously trim the command journal', () => {
  let trims = 0;
  const gateway = new RemoteGateway({ reader: {}, commands: { trimJournal() { trims++; return false; } } });
  gateway.publish({ type: 'stream_event', session_id: 'conversation' });
  assert.equal(trims, 0);
});
