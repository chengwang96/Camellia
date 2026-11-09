'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BackgroundTaskMonitor } = require('../src/engines/background-task-monitor');

function fixture(t, read) {
  const tasks = new Map(), timers = new Map(), updates = [];
  let next = 0, publishes = 0, closed = false;
  const monitor = new BackgroundTaskMonitor({ tasks, read, closed: () => closed,
    setTimer: (callback, ms) => { const id = ++next; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    apply: (id, row) => { updates.push(row); if (['completed', 'failed', 'stopped', 'unavailable'].includes(row.status)) tasks.delete(id);
      else tasks.set(id, { ...tasks.get(id), ...row }); },
    publish: () => { publishes++; monitor.changed(); },
  });
  t.after(() => monitor.stop());
  return { tasks, timers, updates, monitor, get publishes() { return publishes; }, close: () => { closed = true; monitor.stop(); } };
}

test('background checks run only while tasks exist and never overlap', async t => {
  let complete, reads = 0;
  const h = fixture(t, () => { reads++; return new Promise(resolve => { complete = resolve; }); });
  h.monitor.changed(); assert.equal(h.timers.size, 0);
  h.tasks.set('one', { id: 'one', status: 'running' });
  h.monitor.changed(); h.monitor.changed();
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [30000]);
  const first = h.monitor.check();
  assert.equal(h.monitor.check(), first);
  await Promise.resolve();
  assert.equal(reads, 1);
  complete([{ id: 'one', status: 'running' }]); await first;
  assert.equal(h.tasks.get('one').status, 'running');
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [30000]);
  h.tasks.clear(); h.monitor.changed(); assert.equal(h.timers.size, 0);
});

test('native terminal results or absence recover missed ends without inventing success', async t => {
  const h = fixture(t, async () => [{ id: 'success', status: 'completed' }, { id: 'failure', status: 'failed' }, { id: 'keep', status: 'running' }]);
  for (const id of ['success', 'failure', 'missing', 'keep']) h.tasks.set(id, { id, status: 'running' });
  await h.monitor.check();
  assert.deepEqual([...h.tasks.keys()], ['keep']);
  assert.equal(h.updates.find(task => task.id === 'missing').status, 'unavailable');
  assert.equal(h.publishes, 1);
});

for (const mode of ['error', 'timeout', 'malformed', 'duplicate']) test('background ' + mode + ' becomes unknown and a later native read recovers', async t => {
  let recovered = false;
  const h = fixture(t, async () => {
    if (recovered) return [{ id: 'one', status: 'running' }];
    if (mode === 'error') throw new Error('offline');
    if (mode === 'timeout') return new Promise(() => {});
    return mode === 'malformed' ? {} : [{ id: 'one' }, { id: 'one' }];
  });
  h.tasks.set('one', { id: 'one', status: 'running', canStop: true });
  const pending = h.monitor.check();
  await Promise.resolve();
  if (mode === 'timeout') [...h.timers.values()].find(timer => timer.ms === 10000).callback();
  await pending;
  assert.equal(h.tasks.get('one').status, 'unknown');
  assert.equal(h.tasks.get('one').canStop, true);
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [30000]);
  recovered = true; await h.monitor.check();
  assert.equal(h.tasks.get('one').status, 'running');
});

for (const fails of [false, true]) test('an older check cannot overwrite newer lifecycle events, fails=' + fails, async t => {
  let resolve, reject;
  const h = fixture(t, () => new Promise((yes, no) => { resolve = yes; reject = no; }));
  h.tasks.set('updated', { id: 'updated', status: 'running' });
  h.tasks.set('ended', { id: 'ended', status: 'running' });
  h.tasks.set('resumed', { id: 'resumed', status: 'running', run: 1 });
  const pending = h.monitor.check(); await Promise.resolve();
  const fresh = { id: 'updated', status: 'waiting' };
  h.tasks.set('updated', fresh); h.tasks.delete('ended');
  h.tasks.set('new', { id: 'new', status: 'running' });
  h.tasks.set('resumed', { id: 'resumed', status: 'running', run: 2 });
  if (fails) reject(new Error('failed old read'));
  else resolve([{ id: 'ended', status: 'running' }]);
  await pending;
  assert.equal(h.tasks.get('updated'), fresh);
  assert.equal(h.tasks.has('ended'), false);
  assert.equal(h.tasks.has('new'), true);
  assert.equal(h.tasks.get('resumed').run, 2);
  assert.equal(h.publishes, 0);
});

for (const immediate of [false, true]) test('process teardown cancels background checks without late publication, immediate=' + immediate, async t => {
  let resolve;
  const h = fixture(t, () => new Promise(yes => { resolve = yes; }));
  h.tasks.set('one', { id: 'one', status: 'running' });
  const pending = h.monitor.check();
  if (!immediate) await Promise.resolve();
  h.close(); resolve?.([]); await pending;
  assert.equal(h.timers.size, 0);
  assert.equal(h.publishes, 0);
});
