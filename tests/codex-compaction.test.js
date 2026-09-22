'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexSession } = require('../src/engines/codex-session');
const { CodexClient } = require('../src/engines/codex-client');

function fixture(context) {
  const calls = [], events = [];
  const session = new CodexSession({ gen: 1, opts: {}, settings: {}, log() {}, onEvent: event => events.push(event), onResult() {} });
  session.sessionId = 'native-thread'; session.ready = Promise.resolve();
  session.client = { async request(method, params) { calls.push({ method, params }); return {}; }, async shutdown() {} };
  context.after(() => session.shutdown());
  const notify = (method, params) => session.notify(method, { threadId: session.sessionId, ...params });
  return { session, calls, events, notify };
}

test('native compact uses the existing thread and waits beyond RPC acknowledgement and item completion', async context => {
  const { session, calls, events, notify } = fixture(context);
  const progress = [];
  let settled = false;
  const done = session.compact({ onProgress: event => progress.push(event) }).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ method: 'thread/compact/start', params: { threadId: 'native-thread' } }]);
  assert.equal(settled, false);
  notify('turn/started', { turn: { id: 'compact-turn' } });
  notify('item/started', { item: { id: 'compact-item', type: 'contextCompaction' } });
  notify('item/completed', { item: { id: 'compact-item', type: 'contextCompaction' } });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(progress.length, 2);
  session.notify('turn/completed', { threadId: 'unrelated', turn: { status: 'completed' } });
  assert.equal(session.running, true);
  notify('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } });
  assert.deepEqual(await done, { ok: true });
  assert.equal(session.running, false);
  assert.equal(session.sessionId, 'native-thread');
  assert.deepEqual(events, []);
});

for (const early of [false, true]) test('native compaction cancellation works ' + (early ? 'before' : 'after') + ' turn start', async context => {
  const { session, calls, notify } = fixture(context);
  const done = session.compact();
  const rejected = assert.rejects(done, /cancel/i);
  await new Promise(resolve => setImmediate(resolve));
  if (early) session.interrupt();
  notify('turn/started', { turn: { id: 'compact-turn' } });
  if (!early) session.interrupt();
  assert.ok(calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === 'compact-turn'));
  notify('turn/completed', { turn: { id: 'compact-turn', status: 'interrupted' } });
  await rejected;
  assert.equal(session.running, false);
});

test('native compaction fails on terminal error and process exit, and has a bounded timeout', async context => {
  for (const mode of ['error', 'exit', 'timeout']) {
    const { session, notify } = fixture(context);
    const done = session.compact({ timeoutMs: mode === 'timeout' ? 15 : 1000 });
    const rejected = assert.rejects(done, mode === 'error' ? /provider failed/ : mode === 'exit' ? /process stopped/ : /timed out/);
    if (mode === 'error') notify('turn/completed', { turn: { status: 'failed', error: { message: 'provider failed' } } });
    if (mode === 'exit') await session.kill();
    await rejected;
    assert.equal(session.running, false);
  }
});

test('unsupported native API preserves the RPC code without terminating the usable session', async context => {
  const { session } = fixture(context);
  session.client.request = async () => { throw Object.assign(new Error('Unknown method'), { code: -32601 }); };
  await assert.rejects(session.compact(), { code: -32601 });
  assert.equal(session.dead, false);
  const client = Object.create(CodexClient.prototype);
  const done = new Promise((resolve, reject) => { client.pending = new Map([[1, { resolve, reject }]]); });
  client.receive({ id: 1, error: { code: -32601, message: 'Unknown method' } });
  await assert.rejects(done, { code: -32601 });
});

test('automatic native compaction is a progress event, not an executable tool', context => {
  const { session, events, notify } = fixture(context);
  session.running = true; session.replayEvents = []; session.startedAt = Date.now();
  notify('item/started', { item: { id: 'auto', type: 'contextCompaction' } });
  notify('item/completed', { item: { id: 'auto', type: 'contextCompaction' } });
  assert.deepEqual(events.map(event => [event.type, event.state]), [['gui:compaction', 'running'], ['gui:compaction', 'completed']]);
  assert.equal(session.running, true);
});
