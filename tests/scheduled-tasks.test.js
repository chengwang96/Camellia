'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { removeTree } = require('./test-fs.cjs');
const { ScheduledTasks, taskOptions } = require('../src/engines/scheduled-tasks');
const { instructions } = require('../src/engines/task-tools');
const { validateTool, matchesUserRequest } = require('../src/engines/goal-tools');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-'));
  let now = 1000, busy = false;
  const runs = [], interrupts = [], changes = [];
  const options = { file: path.join(root, 'tasks.json'), now: () => now,
    setTimer: () => ({ unref() {} }), clearTimer() {}, busy: () => busy,
    interrupt: task => interrupts.push(task.id), onChange: task => changes.push(task),
    run: task => new Promise(resolve => runs.push({ task, resolve })) };
  const scheduler = new ScheduledTasks(options);
  context.after(() => { scheduler.close(); removeTree(root); });
  return { scheduler, options, runs, interrupts, changes, advance: minutes => { now += minutes * 60000; }, busy: value => { busy = value; },
    create: values => scheduler.create('conversation', 'codex', { instruction: 'Inspect existing training logs', intervalMinutes: 1, ...values }),
    flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('task schema enforces finite bounds and accepts natural-language request provenance', () => {
  assert.equal(taskOptions({ instruction: 'check' }).maxRepairs, 0);
  for (const value of [0, -1, 1.5, '10', Infinity, NaN, 1441]) assert.throws(() => taskOptions({ instruction: 'check', intervalMinutes: value }));
  validateTool('camellia_task_create', { run_token: 'token', instruction: 'check', user_request: 'Create a scheduled task', maxRepairs: 0 });
  assert.throws(() => validateTool('camellia_task_create', { run_token: 'token', instruction: 'check', user_request: 'yes', maxRepairs: '1' }));
  for (const text of ['创建定时任务：检查进度', '请每隔 10 分钟检查日志', 'Create a scheduled task: check logs', 'Check every 10 minutes', '训练已经启动了，能每十分钟帮我看一下日志吗？', '训练日志在这里。\n每半小时帮我看看进度，不要重启。', 'Could you monitor this every hour?']) assert.equal(matchesUserRequest(text, text), true, text);
  assert.equal(matchesUserRequest('训练日志在这里。\n每半小时帮我看看进度。', '每半小时帮我看看进度'), true);
  assert.equal(matchesUserRequest('检查日志', '每小时检查日志'), false);
  assert.match(instructions, /Discussion, negation, hypothetical requests/);
  assert.match(instructions, /rather than requiring a command template/);
});

test('scheduler waits without model calls, skips busy conversations and never overlaps checks', async context => {
  const harness = fixture(context), task = harness.create();
  await harness.scheduler.tick(); assert.equal(harness.runs.length, 0);
  harness.advance(1); harness.busy(true); await harness.scheduler.tick(); assert.equal(harness.runs.length, 0);
  harness.busy(false); harness.advance(1); await harness.scheduler.tick(); assert.equal(harness.runs.length, 1);
  harness.advance(10); await harness.scheduler.tick(); assert.equal(harness.runs.length, 1);
  harness.scheduler.report(task.id, task.sessionId, { status: 'continue', summary: 'Epoch 5, healthy' });
  harness.runs[0].resolve({ subtype: 'success' }); await harness.flush();
  assert.equal(harness.scheduler.get(task.id, task.sessionId).status, 'scheduled');
  await harness.scheduler.tick(); assert.equal(harness.runs.length, 1);
  harness.advance(1); await harness.scheduler.tick(); assert.equal(harness.runs.length, 2);
  harness.scheduler.report(task.id, task.sessionId, { status: 'complete', summary: 'Outputs verified' });
  harness.runs[1].resolve({ subtype: 'success' }); await harness.flush();
  harness.advance(100); await harness.scheduler.tick(); assert.equal(harness.runs.length, 2);
  assert.equal(harness.scheduler.get(task.id, task.sessionId).status, 'complete');
});

test('pause invalidates in-flight completion and blocks resume until the check exits', async context => {
  const harness = fixture(context), task = harness.create();
  harness.advance(1); await harness.scheduler.tick();
  harness.scheduler.report(task.id, task.sessionId, { status: 'complete', summary: 'Done' });
  harness.scheduler.action(task.id, task.sessionId, 'pause');
  assert.deepEqual(harness.interrupts, [task.id]);
  assert.throws(() => harness.scheduler.action(task.id, task.sessionId, 'resume'));
  harness.runs[0].resolve({ subtype: 'success' }); await harness.flush();
  assert.equal(harness.scheduler.get(task.id, task.sessionId).status, 'paused');
  assert.throws(() => harness.scheduler.report(task.id, task.sessionId, { status: 'complete' }));
  harness.scheduler.action(task.id, task.sessionId, 'resume');
  assert.equal(harness.scheduler.get(task.id, task.sessionId).status, 'scheduled');
});

test('multiple tasks reserve a conversation even while model setup is asynchronous', async context => {
  const harness = fixture(context);
  harness.create(); harness.create(); harness.advance(1);
  await harness.scheduler.tick(); assert.equal(harness.runs.length, 1);
  assert.equal(harness.scheduler.list().filter(task => task.status === 'running').length, 1);
  harness.runs[0].resolve({ subtype: 'stopped' }); await harness.flush();
  harness.advance(1); await harness.scheduler.tick(); assert.equal(harness.runs.length, 2);
  harness.runs[1].resolve({ subtype: 'stopped' }); await harness.flush();
});

test('recovery reservations are bounded, persist and cannot be duplicated in a check', async context => {
  const harness = fixture(context), task = harness.create({ maxRepairs: 1 });
  harness.advance(1); await harness.scheduler.tick();
  assert.equal(harness.scheduler.claimRepair(task.id, task.sessionId).remaining, 0);
  assert.throws(() => harness.scheduler.claimRepair(task.id, task.sessionId));
  assert.throws(() => harness.scheduler.claimRepair(task.id, 'other'));
  harness.scheduler.report(task.id, task.sessionId, { status: 'continue', summary: 'Recovered' });
  harness.runs[0].resolve({ subtype: 'success' }); await harness.flush();
  harness.advance(1); await harness.scheduler.tick();
  assert.throws(() => harness.scheduler.claimRepair(task.id, task.sessionId), /limit/);
  harness.scheduler.report(task.id, task.sessionId, { status: 'blocked', summary: 'Recovery exhausted' });
  harness.runs[1].resolve({ subtype: 'success' }); await harness.flush();
  const restored = new ScheduledTasks(harness.options); context.after(() => restored.close());
  assert.equal(restored.get(task.id, task.sessionId).repairs, 1);
  assert.equal(restored.get(task.id, task.sessionId).status, 'paused');
});

test('restart pauses scheduled and interrupted tasks without catch-up calls', async context => {
  const harness = fixture(context), first = harness.create(), second = harness.create({ intervalMinutes: 10 });
  harness.advance(1); await harness.scheduler.tick();
  const restored = new ScheduledTasks(harness.options); context.after(() => restored.close());
  assert.equal(restored.get(first.id, first.sessionId).status, 'paused');
  assert.equal(restored.get(second.id, second.sessionId).status, 'paused');
  harness.advance(60); await restored.tick(); assert.equal(harness.runs.length, 1);
  harness.runs[0].resolve({ subtype: 'stopped' }); await harness.flush();
});

test('run and wall-clock limits stop checks, including a hung check', async context => {
  const harness = fixture(context), task = harness.create({ maxRuns: 1 });
  harness.advance(1); await harness.scheduler.tick();
  harness.scheduler.report(task.id, task.sessionId, { status: 'continue', summary: 'Healthy' });
  harness.runs[0].resolve({ subtype: 'success' }); await harness.flush();
  assert.equal(harness.scheduler.get(task.id, task.sessionId).status, 'paused');
  assert.throws(() => harness.scheduler.action(task.id, task.sessionId, 'resume'), /limit/);
  harness.scheduler.action(task.id, task.sessionId, 'update', { maxRuns: 2 });
  harness.scheduler.action(task.id, task.sessionId, 'resume');
  harness.scheduler.action(task.id, task.sessionId, 'cancel');
  const hung = harness.create({ maxHours: 1 });
  harness.advance(1); await harness.scheduler.tick();
  harness.advance(60); await harness.scheduler.tick();
  assert.equal(harness.scheduler.get(hung.id, hung.sessionId).status, 'paused');
  assert.ok(harness.interrupts.includes(hung.id));
  harness.runs[1].resolve({ subtype: 'stopped' }); await harness.flush();
});

test('missing or failed reports pause instead of looping or accepting completion', async context => {
  const harness = fixture(context), task = harness.create();
  harness.advance(1); await harness.scheduler.tick();
  harness.runs[0].resolve({ subtype: 'success', result: 'I am done' }); await harness.flush();
  assert.equal(harness.scheduler.get(task.id, task.sessionId).status, 'paused');
  harness.scheduler.action(task.id, task.sessionId, 'resume'); harness.advance(1); await harness.scheduler.tick();
  harness.scheduler.report(task.id, task.sessionId, { status: 'complete', summary: 'Done' });
  harness.runs[1].resolve({ subtype: 'error', is_error: true, result: 'Connection lost' }); await harness.flush();
  assert.equal(harness.scheduler.get(task.id, task.sessionId).status, 'paused');
});

test('shutdown and deletion disarm timers and leave external experiments alone', async context => {
  const harness = fixture(context), task = harness.create();
  harness.scheduler.removeSession(task.sessionId);
  assert.equal(harness.scheduler.list().length, 0);
  harness.create(); harness.scheduler.close(); harness.advance(10); await harness.scheduler.tick();
  assert.equal(harness.runs.length, 0); assert.equal(harness.interrupts.length, 0);
  assert.throws(() => harness.create(), /shutting down/);
});
