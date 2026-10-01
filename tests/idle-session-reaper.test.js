'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionPool } = require('../src/engines/session-pool');
const { IdleSessionReaper } = require('../src/engines/idle-session-reaper');

function harness({ timeoutMs = 100, blocked = false } = {}) {
  const pool = new SessionPool();
  let now = 1000, stopped = 0, released = [];
  const reaper = new IdleSessionReaper([pool], { timeoutMs, now: () => now, isBlocked: () => blocked,
    onRelease: ids => { released = ids; } });
  const add = (id, session = { shutdown: async () => { stopped++; } }) => pool.set({ conversationId: id }, session);
  return { pool, reaper, add, advance: value => { now += value; }, get stopped() { return stopped; }, released: () => released };
}

test('reaps a session only after its grace window and leaves the transcript untouched', async () => {
  const h = harness({ timeoutMs: 100 });
  h.add('a');
  assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(99);
  assert.deepEqual(await h.reaper.sweep(), []);
  assert.equal(h.stopped, 0);
  h.advance(1);
  assert.deepEqual(await h.reaper.sweep(), ['a']);
  assert.equal(h.stopped, 1);
  assert.equal(h.pool.get({ conversationId: 'a' }), null);
  assert.deepEqual(h.released(), ['a']);
  // A reaped conversation that becomes active again keeps its process until the
  // next full grace window, so a burst of messages cannot thrash it.
  h.add('a');
  assert.deepEqual(await h.reaper.sweep(), []);
});

test('never reaps a running, blocked or legacy session and keeps the ones it cannot stop', async () => {
  const h = harness({ timeoutMs: 100 });
  h.add('running', { running: true, shutdown: async () => { throw new Error('Stop the response before releasing this conversation'); } });
  h.reaper.lastActive.set('running', 0);
  h.pool.set({}, { shutdown: async () => {} });
  h.reaper.lastActive.set('legacy', 0);
  h.reaper.lastActive.set('blocked', 0);
  h.add('blocked');
  h.reaper.isBlocked = id => id === 'blocked';
  h.advance(1000);
  assert.deepEqual(await h.reaper.sweep(), []);
  assert.equal(h.pool.get({ conversationId: 'blocked' }) !== null, true);
  assert.equal(h.pool.legacy !== null, true);
});

test('start and stop control a single self-unrefing interval', () => {
  const h = harness();
  h.reaper.start(); h.reaper.start();
  assert.ok(h.reaper.timer);
  h.reaper.stop();
  assert.equal(h.reaper.timer, null);
});

test('a function timeout tracks the live retention setting between sweeps', async () => {
  const pool = new SessionPool();
  let now = 5000, minutes = 30;
  const reaper = new IdleSessionReaper([pool], { timeoutMs: () => minutes * 60000, now: () => now });
  let stopped = 0;
  pool.set({ conversationId: 'a' }, { shutdown: async () => { stopped++; } });
  await reaper.sweep();
  now += 29 * 60000;
  assert.deepEqual(await reaper.sweep(), []);
  minutes = 5;
  assert.deepEqual(await reaper.sweep(), ['a']);
  assert.equal(stopped, 1);
});
