'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionPool } = require('../src/engines/session-pool');
const { IdleSessionReaper } = require('../src/engines/idle-session-reaper');

function harness({ timeoutMs = 100, blocked = false } = {}) {
  let now = 1000, stopped = 0, released = [];
  const pool = new SessionPool({ now: () => now });
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
  h.pool.set({}, { shutdown: async () => {} });
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
test('an independent child keeps its native process alive after the parent turn finishes', async () => {
  const h = harness(), child = { status: 'running' };
  h.add('parent', { running: false, children: new Map([['child', child]]), shutdown: async () => {} });
  h.advance(1000); assert.deepEqual(await h.reaper.sweep(), []);
  child.status = 'waiting'; h.advance(1000); assert.deepEqual(await h.reaper.sweep(), []);
  child.status = 'completed'; assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(101); assert.deepEqual(await h.reaper.sweep(), ['parent']);
});

test('a function timeout tracks the live retention setting between sweeps', async () => {
  let now = 5000, minutes = 30;
  const pool = new SessionPool({ now: () => now });
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

test('long running work receives a full idle window after it finishes', async () => {
  const h = harness(), session = { running: true, shutdown: async () => {} };
  h.add('long', session);
  await h.reaper.sweep();
  h.advance(500);
  assert.deepEqual(await h.reaper.sweep(), []);
  session.running = false;
  assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(99);
  assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(1);
  assert.deepEqual(await h.reaper.sweep(), ['long']);
});

test('a notified completion starts retention at its exact time between sweeps', async () => {
  const h = harness(), session = { running: true, shutdown: async () => {} };
  h.add('completion', session); await h.reaper.sweep();
  h.advance(500);
  session.running = false; h.pool.touch({ conversationId: 'completion' });
  h.advance(99);
  assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(1);
  assert.deepEqual(await h.reaper.sweep(), ['completion']);
});

test('short turns between sweeps refresh activity while passive lookups do not', async () => {
  const h = harness(); h.add('short'); await h.reaper.sweep();
  for (let i = 0; i < 3; i++) {
    h.advance(80); h.pool.touch({ conversationId: 'short' });
  }
  assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(99);
  for (let i = 0; i < 10; i++) h.pool.get({ conversationId: 'short' });
  assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(1); assert.deepEqual(await h.reaper.sweep(), ['short']);
});

for (const reason of ['permission', 'goal', 'recovery', 'stopping']) {
  test(reason + ' protection ends with a full idle window even without a notification', async () => {
    const h = harness(); let busy = true;
    h.reaper.isBlocked = () => busy;
    h.add('protected'); await h.reaper.sweep(); h.advance(500);
    assert.deepEqual(await h.reaper.sweep(), []);
    busy = false;
    assert.deepEqual(await h.reaper.sweep(), []);
    h.advance(100); assert.deepEqual(await h.reaper.sweep(), ['protected']);
  });
}

test('engine instances sharing a conversation ID have independent activity and all expired instances close', async () => {
  let now = 0, closed = 0;
  const a = new SessionPool({ now: () => now }), b = new SessionPool({ now: () => now });
  for (const pool of [a, b]) pool.set({ conversationId: 'same' }, { shutdown: async () => { closed++; } });
  const reaper = new IdleSessionReaper([a, b], { now: () => now, timeoutMs: 100 });
  await reaper.sweep(); now = 90; b.touch({ conversationId: 'same' }); now = 100;
  assert.deepEqual(await reaper.sweep(), ['same']);
  assert.equal(a.get({ conversationId: 'same' }), null);
  assert.ok(b.get({ conversationId: 'same' }));
  now = 190; assert.deepEqual(await reaper.sweep(), ['same']); assert.equal(closed, 2);
  for (const pool of [a, b]) pool.set({ conversationId: 'same' }, { shutdown: async () => { closed++; } });
  now += 100; assert.deepEqual(await reaper.sweep(), ['same']); assert.equal(closed, 4);
});

test('replacing, deleting and reopening an ID resets retention and drops obsolete bookkeeping', async () => {
  const h = harness(); h.add('replace'); const old = h.pool.get({ conversationId: 'replace' });
  await h.reaper.sweep(); h.advance(1000); h.add('replace');
  assert.deepEqual(await h.reaper.sweep(), []);
  assert.equal(h.reaper.observed.has(old), false); assert.equal(h.reaper.observed.size, 1);
  h.pool.set({ conversationId: 'replace' }, null); await h.reaper.sweep();
  assert.equal(h.reaper.observed.size, 0);
  h.advance(1000); h.add('replace'); assert.deepEqual(await h.reaper.sweep(), []);
  h.advance(100); assert.deepEqual(await h.reaper.sweep(), ['replace']);
  assert.equal(h.reaper.observed.size, 0);
});

test('new activity after selection cancels teardown before shutdown is invoked', async () => {
  const h = harness(); h.add('race'); await h.reaper.sweep(); h.advance(100);
  const pending = h.reaper.sweep();
  h.pool.touch({ conversationId: 'race' });
  assert.deepEqual(await pending, []); assert.equal(h.stopped, 0);
  h.advance(100); assert.deepEqual(await h.reaper.sweep(), ['race']);
});

test('overlapping sweeps join one teardown and a replacement survives shutdown', async () => {
  const h = harness(); let finish, calls = 0;
  h.add('overlap', { shutdown: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  await h.reaper.sweep(); h.advance(100);
  const first = h.reaper.sweep(), second = h.reaper.sweep();
  assert.equal(first, second); await new Promise(setImmediate); assert.equal(calls, 1);
  h.add('overlap'); const replacement = h.pool.get({ conversationId: 'overlap' });
  finish(); assert.deepEqual(await first, ['overlap']);
  assert.equal(h.pool.get({ conversationId: 'overlap' }), replacement);
  assert.deepEqual(await h.reaper.sweep(), []);
});

test('failed shutdown remains tracked and retries after one retention window', async () => {
  const h = harness(); let calls = 0;
  h.add('failed', { shutdown: async () => { calls++; throw new Error('still alive'); } });
  await h.reaper.sweep(); h.advance(100);
  assert.deepEqual(await h.reaper.sweep(), []); assert.equal(calls, 1);
  assert.deepEqual(await h.reaper.sweep(), []); assert.equal(calls, 1);
  h.advance(100); await h.reaper.sweep(); assert.equal(calls, 2);
  assert.ok(h.pool.get({ conversationId: 'failed' }));
});

test('idle maintenance leaves discussion-owned resources and native contexts to their owner', async () => {
  const h = harness(); let calls = 0;
  const session = { opts: { discussionLaunch: {} }, shutdown: async () => { calls++; } };
  h.add('member', session); h.advance(1000);
  assert.deepEqual(await h.reaper.sweep(), []);
  assert.equal(calls, 0); assert.equal(h.pool.get({ conversationId: 'member' }), session);
  assert.equal(h.reaper.observed.size, 0);
});

test('wall-clock corrections do not expire a newly idle process', async t => {
  const pool = new SessionPool(), reaper = new IdleSessionReaper([pool]);
  pool.set({ conversationId: 'clock' }, { shutdown: async () => { throw new Error('Must remain idle'); } });
  await reaper.sweep(); t.mock.method(Date, 'now', () => 10 ** 15);
  assert.deepEqual(await reaper.sweep(), []);
  t.mock.method(Date, 'now', () => 0);
  assert.deepEqual(await reaper.sweep(), []);
});
