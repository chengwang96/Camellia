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

function denyTaskWrites(context, h) {
  const write = fs.writeFileSync;
  return context.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).startsWith(h.options.file + '.')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return write(file, ...args);
  });
}

test('failed start persistence releases reservations and pauses scheduled work', async context => {
  const h = fixture(context), first = h.create(), second = h.create();
  const original = fs.readFileSync(h.options.file, 'utf8'), write = denyTaskWrites(context, h);
  h.advance(1); await assert.rejects(h.scheduler.tick(), /disk full/);
  assert.equal(h.runs.length, 0); assert.equal(h.scheduler.inflight.size, 0); assert.equal(h.scheduler.timer, null);
  for (const task of h.scheduler.list()) assert.equal(task.status, 'paused');
  assert.equal(h.scheduler.get(first.id, first.sessionId).runs, 0);
  assert.equal(fs.readFileSync(h.options.file, 'utf8'), original);
  assert.match(h.changes.at(-1).storageError, /disk full/);
  write.mock.restore();
  h.scheduler.action(second.id, second.sessionId, 'resume'); h.advance(1); await h.scheduler.tick();
  assert.equal(h.runs.length, 1); h.runs[0].resolve({ subtype: 'stopped' }); await h.flush();
});

test('failed creation and edit never report success or keep unsaved instructions', context => {
  const h = fixture(context), task = h.create(); h.scheduler.action(task.id, task.sessionId, 'pause');
  const write = denyTaskWrites(context, h);
  assert.throws(() => h.create({ instruction: 'Unsaved task' }), /disk full/);
  assert.equal(h.scheduler.list().length, 1);
  assert.throws(() => h.scheduler.action(task.id, task.sessionId, 'update', { instruction: 'Unsaved edit' }), /disk full/);
  assert.equal(h.scheduler.get(task.id, task.sessionId).instruction, task.instruction);
  write.mock.restore();
});

test('failed pause persistence still interrupts the current check and prevents another check', async context => {
  const h = fixture(context), task = h.create(); h.advance(1); await h.scheduler.tick();
  const write = denyTaskWrites(context, h);
  assert.throws(() => h.scheduler.action(task.id, task.sessionId, 'pause'), /disk full/);
  assert.deepEqual(h.interrupts, [task.id]);
  h.runs[0].resolve({ subtype: 'success' }); await h.flush();
  assert.equal(h.scheduler.inflight.size, 0); assert.equal(h.scheduler.timer, null);
  h.advance(10); await h.scheduler.tick(); assert.equal(h.runs.length, 1);
  write.mock.restore();
});

test('repair authorization cannot succeed when its reservation cannot be saved', async context => {
  const h = fixture(context), task = h.create({ maxRepairs: 1 }); h.advance(1); await h.scheduler.tick();
  const write = denyTaskWrites(context, h);
  assert.throws(() => h.scheduler.claimRepair(task.id, task.sessionId), /disk full/);
  assert.equal(h.scheduler.get(task.id, task.sessionId).repairs, 0);
  assert.equal(h.scheduler.get(task.id, task.sessionId).status, 'paused');
  h.runs[0].resolve({ subtype: 'stopped' }); await h.flush(); write.mock.restore();
});

test('unreadable task storage cannot be overwritten during startup or creation', context => {
  const h = fixture(context), original = fs.readFileSync(h.options.file, 'utf8'), read = fs.readFileSync;
  const denied = context.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === h.options.file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  const warnings = [], restarted = new ScheduledTasks({ ...h.options, onLoadError: error => warnings.push(error) });
  assert.equal(warnings.length, 1); assert.equal(restarted.list().length, 0);
  assert.throws(() => restarted.create('conversation', 'codex', { instruction: 'New work' }), /Cannot read/);
  denied.mock.restore(); assert.equal(fs.readFileSync(h.options.file, 'utf8'), original); restarted.close();
});

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

for (const [field, value] of [['intervalMinutes', 0], ['maxRuns', null], ['maxHours', 0], ['maxRepairs', -1],
  ['runs', null], ['repairs', -1], ['expiresAt', null]]) {
  test('invalid saved ' + field + ' cannot resume and leaves other tasks available', async context => {
    const h = fixture(context), bad = h.create(), good = h.scheduler.create('other', 'codex', { instruction: 'Inspect another log', intervalMinutes: 1 });
    h.scheduler.action(bad.id, bad.sessionId, 'pause'); h.scheduler.action(good.id, good.sessionId, 'pause');
    const records = JSON.parse(fs.readFileSync(h.options.file, 'utf8'));
    records.find(task => task.id === bad.id)[field] = value; fs.writeFileSync(h.options.file, JSON.stringify(records));
    const warnings = [], restored = new ScheduledTasks({ ...h.options, onLoadError: error => warnings.push(error) });
    context.after(() => restored.close());
    assert.equal(restored.list().length, 2); assert.equal(restored.get(bad.id, bad.sessionId)[field], value);
    assert.equal(restored.get(bad.id, bad.sessionId).status, 'paused'); assert.equal(warnings.length, 1);
    assert.throws(() => restored.action(bad.id, bad.sessionId, 'resume'), /Invalid task|Invalid saved/);
    restored.action(good.id, good.sessionId, 'resume'); h.advance(1); await restored.tick();
    assert.equal(h.runs.length, 1); assert.equal(h.runs[0].task.id, good.id);
    h.runs[0].resolve({ subtype: 'stopped' }); await h.flush();
  });
}

test('editing invalid saved task options restores valid scheduling without resetting counters', async context => {
  const h = fixture(context), task = h.create(); h.scheduler.action(task.id, task.sessionId, 'pause');
  const records = JSON.parse(fs.readFileSync(h.options.file, 'utf8'));
  records[0].intervalMinutes = 0; records[0].runs = 2; fs.writeFileSync(h.options.file, JSON.stringify(records));
  const restored = new ScheduledTasks(h.options); context.after(() => restored.close());
  restored.action(task.id, task.sessionId, 'update', { intervalMinutes: 2 });
  restored.action(task.id, task.sessionId, 'resume');
  assert.equal(restored.get(task.id, task.sessionId).runs, 2);
  await restored.tick(); h.advance(1); await restored.tick(); assert.equal(h.runs.length, 0);
  h.advance(1); await restored.tick(); assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].task.runs, 3); h.runs[0].resolve({ subtype: 'stopped' }); await h.flush();
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

test('task edits are atomic, conversation-scoped and never implicitly resume a paused task', context => {
  const harness = fixture(context), task = harness.create();
  harness.scheduler.action(task.id, task.sessionId, 'pause');
  const before = harness.scheduler.list();
  assert.throws(() => harness.scheduler.action(task.id, 'other', 'cancel'), /not found/);
  assert.throws(() => harness.scheduler.action(task.id, task.sessionId, 'update', { instruction: 'Changed', maxRuns: 0 }), /Invalid/);
  assert.deepEqual(harness.scheduler.list(), before);
  const updated = harness.scheduler.action(task.id, task.sessionId, 'update', { intervalMinutes: 30 });
  assert.equal(updated.status, 'paused');
  assert.equal(updated.nextRunAt, null);
  updated.instruction = 'Mutated returned snapshot';
  assert.equal(harness.scheduler.get(task.id, task.sessionId).instruction, task.instruction);
  const restored = new ScheduledTasks(harness.options); context.after(() => restored.close());
  assert.equal(restored.get(task.id, task.sessionId).intervalMinutes, 30);
  assert.equal(restored.get(task.id, task.sessionId).status, 'paused');
});

test('cancelling one running conversation leaves another running task independent', async context => {
  const harness = fixture(context), first = harness.create();
  const second = harness.scheduler.create('other', 'claude', { instruction: 'Inspect another log', intervalMinutes: 1 });
  harness.advance(1); await harness.scheduler.tick();
  assert.equal(harness.runs.length, 2);
  harness.scheduler.report(first.id, first.sessionId, { status: 'complete', summary: 'Late completion' });
  harness.scheduler.action(first.id, first.sessionId, 'cancel');
  assert.throws(() => harness.scheduler.action(first.id, first.sessionId, 'resume'), /ended/);
  assert.deepEqual(harness.interrupts, [first.id]);
  harness.scheduler.report(second.id, second.sessionId, { status: 'continue', summary: 'Healthy' });
  for (const run of harness.runs) run.resolve({ subtype: 'success' });
  await harness.flush();
  assert.equal(harness.scheduler.get(first.id, first.sessionId).status, 'cancelled');
  assert.equal(harness.scheduler.get(second.id, second.sessionId).status, 'scheduled');
  harness.advance(1); await harness.scheduler.tick();
  assert.equal(harness.runs.length, 3);
  assert.equal(harness.runs[2].task.id, second.id);
  harness.runs[2].resolve({ subtype: 'stopped' }); await harness.flush();
});

test('shutdown and deletion disarm timers and leave external experiments alone', async context => {
  const harness = fixture(context), task = harness.create();
  harness.scheduler.removeSession(task.sessionId);
  assert.equal(harness.scheduler.list().length, 0);
  harness.create(); harness.scheduler.close(); harness.advance(10); await harness.scheduler.tick();
  assert.equal(harness.runs.length, 0); assert.equal(harness.interrupts.length, 0);
  assert.throws(() => harness.create(), /shutting down/);
});
