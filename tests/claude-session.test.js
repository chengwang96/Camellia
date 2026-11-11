'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ClaudeSession } = require('../src/engines/claude-session');
const { createHarness } = require('./main-process-harness.cjs');
const path = require('node:path');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');

function fixture(t, opts = {}) {
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false });
  const writes = [], events = [], results = [], timers = new Map();
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: line => writes.push(JSON.parse(line)) });
  proc.kill = () => { proc.killed = true; };
  const spawns = [];
  const session = new ClaudeSession({ gen: 1, settings: { cwd: 'test' }, opts, exe: 'fake', spec: { args: [], cwd: 'test' },
    spawn: (exe, args) => { spawns.push({ exe, args }); return proc; }, onEvent: ev => events.push(ev), onResult: ev => results.push(ev),
    setTimer: fn => { timers.set(1, fn); return 1; }, clearTimer: id => timers.delete(id) });
  session.start();
  t.after(() => session.kill());
  return { session, proc, writes, events, results, timers, spawns };
}
test('Claude selected DeepSeek web tools suppress native web search and fetch only for that session', t => {
  const config = { command: 'node', args: ['goal-mcp-stdio.js'] };
  const selected = fixture(t, { goalBridge: { config, webTools: true } });
  const args = selected.spawns[0].args;
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'WebSearch,WebFetch');
  assert.match(args[args.indexOf('--mcp-config') + 1], /camellia_goals/);
  const native = fixture(t, { goalBridge: { config, webTools: false } });
  assert.equal(native.spawns[0].args.includes('--disallowedTools'), false);
});

test('Claude reports native background task progress and its actual terminal state', t => {
  const f = fixture(t);
  for (const row of [
    { subtype: 'task_started', task_id: 'task-child', description: 'Inspect the files' },
    { subtype: 'task_progress', task_id: 'task-child', description: 'Inspect the files', summary: 'Found the test' },
    { subtype: 'task_notification', task_id: 'task-child', status: 'failed', summary: 'Test failed' },
  ]) f.session.emitLine(JSON.stringify({ type: 'system', ...row }));
  const tasks = f.events.filter(event => event.type === 'gui:subagent').map(event => event.task);
  assert.equal(tasks[0].status, 'running'); assert.equal(tasks[1].progress, 'Found the test');
  assert.equal(tasks[2].status, 'failed'); assert.equal(tasks[2].canStop, false);
});

test('Claude recovers missed task starts from the native background snapshot and retains real completion', t => {
  const f = fixture(t);
  f.session.emitLine(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'child', task_type: 'local_agent', description: 'Audit source' },
    { task_id: 'shell', task_type: 'local_bash', description: 'Run shell' },
  ] }));
  assert.equal(f.session.children.size, 1); assert.equal(f.session.children.get('child').status, 'running');
  f.session.emitLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed', summary: 'Audit passed' }));
  assert.equal(f.session.children.get('child').result, 'Audit passed');
});

test('Claude adopts a native task-notification turn after a reply so its follow-up is not lost', t => {
  const f = fixture(t);
  assert.equal(f.session.sendUserMessage('Run the long verification'), true);
  f.session.emitLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'The verification is running.' }));
  assert.equal(f.session.running, false);
  const before = f.events.length;
  f.session.emitLine(JSON.stringify({ type: 'user', session_id: 'native-1', origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>\n<task-id>job</task-id>\n<status>completed</status>\n</task-notification>' } }));
  assert.equal(f.session.running, true);
  assert.deepEqual(f.events.slice(before).map(event => event.type), ['gui:background-turn', 'user']);
  f.session.emitLine(JSON.stringify({ type: 'assistant', session_id: 'native-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'The verification finished: the cloth did not unfold.' }] } }));
  f.session.emitLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'The verification finished: the cloth did not unfold.' }));
  assert.equal(f.results.at(-1).result, 'The verification finished: the cloth did not unfold.');
  assert.equal(f.session.running, false);
});

test('Claude keeps a task notification inside an active turn instead of adopting it', t => {
  const f = fixture(t);
  f.session.sendUserMessage('Run the verification');
  const before = f.events.length;
  f.session.emitLine(JSON.stringify({ type: 'user', origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' } }));
  assert.equal(f.session.running, true);
  assert.equal(f.events.slice(before).some(event => event.type === 'gui:background-turn'), false);
});

test('Claude keeps background lifecycle events flowing during context compaction', async t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify({ type: 'system', ...row }));
  send({ subtype: 'task_started', task_id: 'child', task_type: 'local_agent' });
  send({ subtype: 'task_started', task_id: 'shell', task_type: 'local_bash' });
  const compacted = f.session.compact();
  send({ subtype: 'task_notification', task_id: 'child', status: 'completed', summary: 'Audit passed' });
  send({ subtype: 'task_updated', task_id: 'shell', patch: { status: 'failed' } });
  send({ subtype: 'compact_boundary' });
  f.session.emitLine(JSON.stringify({ type: 'result', subtype: 'success' }));
  await compacted;
  assert.equal(f.session.backgroundTasks.size, 0);
  assert.equal(f.session.children.get('child').status, 'completed');
  assert.equal(f.session.children.get('child').result, 'Audit passed');
  assert.equal(f.results.length, 0, 'compaction must not become a parent reply');
});

test('Claude snapshots respect terminal states and preserve completed results across stale updates', t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify({ type: 'system', ...row }));
  send({ subtype: 'background_tasks_changed', tasks: [
    { task_id: 'child', task_type: 'local_agent' }, { task_id: 'shell', task_type: 'local_bash' },
  ] });
  send({ subtype: 'task_notification', task_id: 'child', status: 'completed', summary: 'Audit passed' });
  send({ subtype: 'task_updated', task_id: 'shell', patch: { status: 'killed' } });
  for (const status of ['completed', undefined, 'running']) {
    send({ subtype: 'background_tasks_changed', tasks: [
      { task_id: 'child', task_type: 'local_agent', status }, { task_id: 'shell', task_type: 'local_bash', status },
    ] });
    send({ subtype: 'task_progress', task_id: 'child', summary: 'Late progress' });
    send({ subtype: 'task_progress', task_id: 'shell', summary: 'Late progress' });
    assert.equal(f.session.backgroundTasks.size, 0);
    assert.equal(f.session.children.get('child').status, 'completed');
    assert.equal(f.session.children.get('child').result, 'Audit passed');
    assert.equal(f.session.children.get('child').canStop, false);
  }
  send({ subtype: 'background_tasks_changed', tasks: [
    { task_id: 'failed-child', task_type: 'local_agent', status: 'failed' },
    { task_id: 'waiting-child', task_type: 'local_agent', status: 'waiting' },
  ] });
  assert.equal(f.session.children.get('failed-child').status, 'failed');
  assert.equal(f.session.children.get('failed-child').canStop, false);
  assert.equal(f.session.children.get('waiting-child').status, 'waiting');
  assert.deepEqual([...f.session.backgroundTasks.keys()], ['waiting-child']);
});

test('Claude marks a child missing from an authoritative background snapshot unavailable until native evidence arrives', t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify({ type: 'system', ...row }));
  send({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'child', task_type: 'local_agent' }] });
  send({ subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(f.session.backgroundTasks.size, 0);
  assert.equal(f.session.children.get('child').status, 'unavailable');
  assert.equal(f.session.children.get('child').canStop, false);
  assert.equal(f.session.children.get('child').result, undefined, 'absence is not evidence of success');
  send({ subtype: 'task_progress', task_id: 'child', status: 'running', summary: 'Still working' });
  assert.equal(f.session.children.get('child').status, 'running');
  send({ subtype: 'task_notification', task_id: 'child', status: 'failed', summary: 'Native failure' });
  assert.equal(f.session.children.get('child').status, 'failed');
  assert.equal(f.session.backgroundTasks.size, 0);
});

test('Claude preserves child approval waits and native tool completion across task snapshots', t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify(row));
  send({ type: 'system', subtype: 'task_started', task_id: 'waiting', task_type: 'local_agent' });
  f.session.onControlRequest({ request_id: 'approval', request: { subtype: 'can_use_tool', agent_id: 'waiting', tool_name: 'Bash', input: { command: 'test' } } });
  send({ type: 'system', subtype: 'task_progress', task_id: 'waiting', summary: 'Needs permission' });
  assert.equal(f.session.children.get('waiting').status, 'waiting');
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: { description: 'Audit files' } }] } });
  send({ type: 'user', tool_use_result: { agentId: 'finished', status: 'completed' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Audit passed' }] } });
  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'waiting', task_type: 'local_agent' }, { task_id: 'finished', task_type: 'local_agent' },
  ] });
  const finished = f.session.children.get(f.session.subagents.resolve('finished'));
  assert.equal(finished.status, 'completed');
  assert.equal(finished.result, 'Audit passed');
  assert.equal(f.session.children.get('waiting').status, 'waiting');
  assert.equal(f.session.children.get('waiting').approvals.length, 1);
  assert.deepEqual([...f.session.backgroundTasks.keys()], ['waiting']);
});

test('Claude can resume a completed native agent in a new tool call without reviving its previous turn', t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify(row));
  const launch = (id, input) => send({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input }] } });
  launch('first', { description: 'Audit files', run_in_background: true });
  send({ type: 'system', subtype: 'task_started', task_id: 'worker', tool_use_id: 'first', task_type: 'local_agent' });
  send({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'completed', summary: 'First result' });
  f.session.sendUserMessage('Continue the audit');
  launch('second', { resume: 'worker', prompt: 'Check the remaining files', run_in_background: true });
  send({ type: 'system', subtype: 'task_started', task_id: 'worker', tool_use_id: 'second', task_type: 'local_agent' });
  const task = f.session.children.get(f.session.subagents.resolve('worker'));
  assert.equal(task.status, 'running');
  assert.equal(task.result, '');
  assert.equal(f.session.backgroundTasks.get('worker').status, 'running');
  send({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'completed', summary: 'Second result' });
  assert.equal(f.session.backgroundTasks.size, 0);
  assert.equal(f.session.children.get(task.id).result, 'Second result');
});

test('Claude native run IDs admit a resumed task and reject late events from its previous run', t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify({ type: 'system', task_id: 'worker', ...row }));
  send({ subtype: 'task_started', run_id: 'run-001', task_type: 'local_agent' });
  send({ subtype: 'task_notification', run_id: 'run-001', status: 'completed', summary: 'First result' });
  send({ subtype: 'task_started', run_id: 'run-002', task_type: 'local_agent' });
  send({ subtype: 'task_notification', run_id: 'run-001', status: 'completed', summary: 'Late old result' });
  send({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'worker', run_id: 'run-001', task_type: 'local_agent' }] });
  assert.equal(f.session.backgroundTasks.get('worker').status, 'running');
  assert.equal(f.session.children.get('worker').turnId, 'run-002');
  assert.equal(f.session.children.get('worker').result, '');
  send({ subtype: 'task_notification', run_id: 'run-002', status: 'completed', summary: 'Second result' });
  assert.equal(f.session.backgroundTasks.size, 0);
  assert.equal(f.session.children.get('worker').result, 'Second result');
});

test('Claude foreground children are not reconciled as background tasks until natively backgrounded', t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify({ type: 'system', task_id: 'worker', ...row }));
  send({ subtype: 'task_started', is_backgrounded: false, task_type: 'local_agent' });
  send({ subtype: 'task_progress', summary: 'Still working in foreground' });
  assert.equal(f.session.backgroundTasks.size, 0);
  assert.equal(f.session.children.get('worker').status, 'running');
  send({ subtype: 'task_updated', patch: { is_backgrounded: true } });
  assert.equal(f.session.backgroundTasks.get('worker').status, 'running');
  send({ subtype: 'task_notification', status: 'completed' });
  assert.equal(f.session.backgroundTasks.size, 0);
});

test('Claude background refresh waits for a native level snapshot and fences newer events from an older read', async t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify(row));
  f.session.sendUserMessage('Keep the parent running');
  send({ type: 'system', subtype: 'task_started', task_id: 'old', task_type: 'local_bash' });
  const checked = f.session.backgroundMonitor.check(); await Promise.resolve();
  const request = f.writes.at(-1);
  assert.equal(request.request.subtype, 'initialize');
  send({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } });
  assert.equal(f.session.backgroundTasks.has('old'), true, 'a successful refresh ack is not a task snapshot');
  send({ type: 'system', subtype: 'task_started', task_id: 'new', task_type: 'local_bash' });
  send({ type: 'system', subtype: 'task_notification', task_id: 'old', status: 'completed' });
  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'old', task_type: 'local_bash' }] });
  await checked;
  assert.deepEqual([...f.session.backgroundTasks.keys()], ['new']);
  assert.equal(f.session.running, true);
  assert.equal(f.results.length, 0);
  assert.equal(f.writes.some(row => ['interrupt', 'stop_task'].includes(row.request?.subtype)), false);
});

test('Claude missing refresh snapshots become unknown and a subsequent native snapshot recovers', async t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify(row));
  send({ type: 'system', subtype: 'task_started', task_id: 'worker', task_type: 'local_agent' });
  let checked = f.session.backgroundMonitor.check(); await Promise.resolve();
  let request = f.writes.at(-1);
  send({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } });
  f.session.backgroundMonitor.controller.abort(); await checked;
  assert.equal(f.session.backgroundTasks.get('worker').status, 'unknown');
  assert.equal(f.session.backgroundTasks.get('worker').canStop, true);
  assert.equal(f.session.children.get('worker').status, 'unavailable');
  assert.equal(f.session.backgroundRead, null);
  checked = f.session.backgroundMonitor.check(); await Promise.resolve();
  request = f.writes.at(-1);
  send({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } });
  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'worker', task_type: 'local_agent' }] });
  await checked;
  assert.equal(f.session.backgroundTasks.get('worker').status, 'running');
  assert.equal(f.session.children.get('worker').status, 'running');
  checked = f.session.backgroundMonitor.check(); await Promise.resolve();
  f.session.backgroundMonitor.controller.abort(); await checked;
  assert.equal(f.session.backgroundTasks.get('worker').status, 'unknown');
  send({ type: 'system', subtype: 'task_progress', task_id: 'worker', summary: 'New native progress' });
  assert.equal(f.session.backgroundTasks.get('worker').status, 'running');
  assert.equal(f.session.children.get('worker').status, 'running');
});

for (const mode of ['close', 'stdin-error', 'kill']) test('Claude clears idle background work and disconnects children on ' + mode, t => {
  const f = fixture(t);
  f.session.emitLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'worker', task_type: 'local_agent' }));
  if (mode === 'close') f.proc.emit('close', 1);
  else if (mode === 'stdin-error') f.proc.stdin.emit('error', new Error('EPIPE'));
  else f.session.kill();
  assert.equal(f.session.backgroundTasks.size, 0);
  assert.equal(f.events.findLast(event => event.type === 'gui:background-work').tasks.length, 0);
  assert.equal(f.session.children.get('worker').status, 'unavailable');
  assert.equal(f.session.children.get('worker').canStop, false);
  assert.equal(f.session.dead, true);
  assert.equal(f.results.length, 0, 'background teardown must not invent another parent reply');
});

test('Claude stops background shells through native task control without interrupting the parent', async t => {
  const f = fixture(t), send = row => f.session.emitLine(JSON.stringify(row));
  f.session.running = true;
  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'shell', task_type: 'local_bash', description: 'Run evaluation' },
    { task_id: 'keep', task_type: 'local_bash', description: 'Keep server running' },
  ] });
  assert.equal(f.events.findLast(event => event.type === 'gui:background-work').tasks.length, 2);
  assert.equal(f.session.children.size, 0);
  const stopped = f.session.stopBackgroundTasks(['shell']);
  const request = f.writes.at(-1);
  assert.deepEqual(request.request, { subtype: 'stop_task', task_id: 'shell' });
  send({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } });
  await stopped;
  assert.equal(f.session.backgroundTasks.size, 2, 'an acknowledgement is not a terminal event');
  send({ type: 'system', subtype: 'task_notification', task_id: 'shell', status: 'stopped' });
  assert.deepEqual([...f.session.backgroundTasks.keys()], ['keep']);
  assert.equal(f.session.running, true); assert.equal(f.session.cancelled, false);
  f.proc.emit('close', 0);
  assert.equal(f.events.findLast(event => event.type === 'gui:background-work').tasks.length, 0);
});

test('Claude background stop errors retain the task so it can be retried', async t => {
  const f = fixture(t);
  f.session.emitLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'shell', task_type: 'local_bash' }));
  const stopped = f.session.stopBackgroundTasks(['shell']);
  const request = f.writes.at(-1);
  f.session.emitLine(JSON.stringify({ type: 'control_response', response: { request_id: request.request_id, subtype: 'error', error: 'Cannot stop task' } }));
  await assert.rejects(stopped, /Cannot stop/);
  assert.equal(f.session.backgroundTasks.size, 1);
});

test('Claude Agent calls remain visible without lifecycle starts and bind native IDs without duplicate cards', async t => {
  const f = fixture(t);
  const send = row => f.session.emitLine(JSON.stringify(row));
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: { description: 'Review files', prompt: 'Check imports', run_in_background: true } }] } });
  send({ type: 'user', tool_use_result: { isAsync: true, agentId: 'native-child', status: 'async_launched' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'Started in the background' }] } });
  send({ type: 'system', subtype: 'task_progress', task_id: 'native-child', tool_use_id: 'agent-call', summary: 'Reading files' });
  assert.equal(f.session.children.size, 1);
  const task = [...f.session.children.values()][0];
  assert.equal(task.goal, 'Check imports'); assert.equal(task.progress, 'Reading files'); assert.equal(task.status, 'running');
  const stopping = f.session.controlChild(task.id, { operation: 'stop', expectedTurnId: task.turnId });
  const request = f.writes.at(-1); assert.equal(request.request.task_id, 'native-child');
  send({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } }); await stopping;
  send({ type: 'system', subtype: 'task_updated', task_id: 'native-child', patch: { status: 'killed' } });
  assert.equal([...f.session.children.values()][0].status, 'stopped');
});

test('Claude routes child approvals and stop requests without interrupting the parent', async t => {
  const f = fixture(t); f.session.sendUserMessage('Parent work');
  f.session.emitLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent', tool_use_id: 'spawn-tool', description: 'Inspect files' }));
  f.session.emitLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'spawn-tool', message: { content: [{ type: 'text', text: 'Child progress' }] } }));
  assert.equal(f.events.filter(event => event.type === 'assistant').length, 0);
  assert.equal(f.session.children.get('child').progress, 'Child progress');
  f.session.onControlRequest({ request_id: 'child-request', request: { subtype: 'can_use_tool', agent_id: 'child', tool_name: 'Bash', input: { command: 'git status' } } });
  assert.equal(f.events.filter(event => event.type === 'gui:permission').length, 0);
  assert.equal(f.session.children.get('child').status, 'waiting');
  f.session.complete({ subtype: 'success', result: 'Parent result' });
  assert.equal(f.session.permissions.has('child-request'), true);
  await f.session.controlChild('child', { operation: 'approve', approvalId: 'child-request', response: { allow: true } });
  assert.equal(f.writes.at(-1).response.request_id, 'child-request');
  const stopped = f.session.controlChild('child', { operation: 'stop', expectedTurnId: f.session.children.get('child').turnId });
  const request = f.writes.at(-1);
  assert.deepEqual(request.request, { subtype: 'stop_task', task_id: 'child' });
  f.session.emitLine(JSON.stringify({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success', response: {} } }));
  await stopped; assert.equal(f.session.children.get('child').status, 'running', 'receipt does not invent a terminal state');
  f.session.emitLine(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'child', patch: { status: 'stopped' } }));
  assert.equal(f.session.children.get('child').status, 'stopped'); assert.equal(f.session.children.get('child').canStop, false);
  assert.equal(f.session.cancelled, false);
  f.session.emitLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'shell', task_type: 'local_bash' }));
  assert.equal(f.session.children.has('shell'), false, 'background shells are not presented as agents');
});

test('image input failure leaves Claude idle and the next valid image send retains its actual bytes', context => {
  const fs = require('node:fs'), os = require('node:os');
  const file = path.join(os.tmpdir(), 'claude-image-' + require('node:crypto').randomUUID() + '.png');
  context.after(() => fs.rmSync(file, { force: true }));
  const h = fixture(context), before = h.writes.length;
  assert.throws(() => h.session.sendUserMessage('Read this', [{ path: file, isImage: true }]), /ENOENT/);
  assert.equal(h.session.running, false); assert.equal(h.writes.length, before); assert.equal(h.timers.size, 0);
  const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(file, pixels);
  assert.equal(h.session.sendUserMessage('Read this', [{ path: file, isImage: true }]), true);
  const image = h.writes.at(-1).message.content[1];
  assert.equal(image.source.media_type, 'image/png');
  assert.deepEqual(Buffer.from(image.source.data, 'base64'), pixels);
});

test('Claude native compact requires a compact boundary and a successful result without a user result', async context => {
  const harness = fixture(context, { sessionId: 'original' });
  const done = harness.session.compact();
  assert.equal(harness.writes.at(-1).message.content[0].text, '/compact');
  harness.session.emitLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 'original' }));
  assert.equal(harness.session.running, true);
  harness.session.emitLine(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'original' }));
  assert.deepEqual(await done, { ok: true });
  assert.equal(harness.results.length, 0);
  assert.equal(harness.events.length, 0);
  assert.equal(harness.session.sessionId, 'original');
});

for (const mode of ['no-boundary', 'cancel', 'exit']) test('Claude compact rejects ' + mode, async context => {
  const harness = fixture(context);
  const rejected = assert.rejects(harness.session.compact());
  if (mode === 'exit') harness.session.kill();
  else {
    if (mode === 'cancel') harness.session.interrupt();
    harness.session.emitLine(JSON.stringify({ type: 'result', subtype: 'success' }));
  }
  await rejected;
  assert.equal(harness.results.length, 0);
  assert.equal(harness.session.running, false);
});

for (const isError of [false, true]) test(`Claude compact preserves too-few-messages result (is_error=${isError})`, async context => {
  const harness = fixture(context);
  const rejected = assert.rejects(harness.session.compact(), /^Error: Not enough messages to compact\.$/);
  harness.session.emitLine(JSON.stringify({ type: 'result', subtype: isError ? 'error' : 'success',
    is_error: isError, result: 'Not enough messages to compact.' }));
  await rejected;
  assert.equal(harness.session.running, false);
  assert.equal(harness.results.length, 0);
  assert.equal(harness.events.length, 0);
});

test('Claude automatic compact boundary publishes a context event', context => {
  const harness = fixture(context);
  harness.session.sendUserMessage('Continue');
  harness.session.emitLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }));
  assert.ok(harness.events.some(event => event.type === 'gui:compaction' && event.state === 'completed'));
});

test('Claude compaction timeout terminates the process without publishing a user result', async context => {
  const harness = fixture(context);
  harness.session.initialized = true;
  const rejected = assert.rejects(harness.session.compact(), /timed out/);
  harness.timers.get(1)();
  await rejected;
  assert.equal(harness.proc.killed, true);
  assert.equal(harness.results.length, 0);
});

test('Claude registers the goal MCP server without changing normal tool permissions', t => {
  const config = { command: process.execPath, args: ['goal-mcp-stdio.js'], env: { CAMELLIA_GOAL_TOKEN: 'private' } };
  const harness = fixture(t, { goalBridge: { config } });
  const args = harness.spawns[0].args;
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: { camellia_goals: config } });
  assert.equal(args.includes('--permission-prompt-tool'), true);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('CLI JSON survives one-byte UTF-8 chunks and a final line without a newline', t => {
  const f = fixture(t); f.session.sendUserMessage('问题');
  const rows = [{ type: 'system', subtype: 'init', session_id: 'chat' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '中文工作区🧪' }] } },
    { type: 'result', subtype: 'success', result: '完成了' }];
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'));
  for (const byte of bytes) f.proc.stdout.emit('data', Buffer.from([byte]));
  f.proc.emit('exit', 0); // stdout may still drain after this event
  f.proc.emit('close', 0);
  assert.equal(f.events[1].message.content[0].text, '中文工作区🧪');
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].result, '完成了');
  assert.equal(f.session.running, false);
  assert.equal(f.timers.size, 0);
});

test('clean exit without result completes an in-flight turn as an error exactly once', t => {
  const f = fixture(t); f.session.sendUserMessage('test');
  f.proc.emit('close', 0); f.proc.emit('close', 0);
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].subtype, 'exit_0');
  assert.equal(f.results[0].is_error, true);
  assert.equal(f.session.running, false);
  assert.equal(f.session.dead, true);
  assert.equal(f.timers.size, 0);
});

test('spawn failure unblocks sending and reaches the same result hook as normal output', t => {
  const f = fixture(t); f.session.sendUserMessage('test');
  f.proc.emit('error', new Error('ENOENT')); f.proc.emit('close', -1);
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].subtype, 'spawn_error');
  assert.equal(f.session.running, false);
  assert.equal(f.timers.size, 0);
});

test('broken stdin terminates a turn without an uncaught process error', t => {
  const f = fixture(t); f.session.sendUserMessage('test');
  f.proc.stdin.emit('error', new Error('EPIPE'));
  assert.equal(f.session.running, false);
  assert.equal(f.results[0].subtype, 'stdin_error');
  assert.equal(f.proc.killed, true);
});

test('unwritable stdin reports send failure immediately', t => {
  const f = fixture(t); f.proc.stdin.writable = false;
  assert.equal(f.session.sendUserMessage('test'), false);
  assert.equal(f.session.running, false);
  assert.equal(f.results.length, 1);
});

test('initialization timeout completes the turn and does not report duplicate close errors', t => {
  const f = fixture(t); f.session.sendUserMessage('test');
  f.timers.get(1)(); f.proc.emit('close', null, 'SIGTERM');
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].subtype, 'session_timeout');
  assert.equal(f.session.running, false);
});

test('permission approval preserves tool arguments and rejects stale request IDs', t => {
  const f = fixture(t); f.session.sendUserMessage('test');
  assert.deepEqual(f.spawns[0].args.slice(-2), ['--permission-prompt-tool', 'stdio']);
  const input = { file_path: '文档.md', content: 'original' };
  f.session.emitLine(JSON.stringify({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input } }));
  assert.equal(f.session.answerPermission('permission-1', true), true);
  assert.deepEqual(f.writes.at(-1).response.response.updatedInput, input);
  assert.equal(f.session.answerPermission('permission-1', true), false);
  assert.equal(f.session.answerPermission('unknown', true), false);
});

test('repeated successful turns reuse the process; terminal callbacks run once per turn', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    assert.equal(f.session.sendUserMessage('test'), true);
    assert.equal(f.session.sendUserMessage('busy'), false);
    f.session.emitLine('{"type":"result","subtype":"success"}');
    f.session.emitLine('{"type":"result","subtype":"success"}');
  }
  assert.equal(f.results.length, 3);
  f.proc.emit('close', 0);
  assert.equal(f.results.length, 3);
});

test('Allow all still collects AskUserQuestion answers and preserves the native question schema', t => {
  const f = fixture(t); f.session.settings.permissionMode = 'bypassPermissions'; f.session.sendUserMessage('Work');
  const input = { questions: [
    { header: 'Scope', question: 'Which files?', options: [{ label: 'Main', description: 'Main workflow' }, { label: 'All', description: 'Every file' }], multiSelect: false },
    { header: 'Outputs', question: 'Which outputs?', options: [{ label: 'CSV' }, { label: 'JSON' }], multiSelect: true },
    { header: 'Name', question: 'Project name?', options: [], multiSelect: false },
  ], metadata: { source: 'fixture' } };
  f.session.emitLine(JSON.stringify({ type: 'control_request', request_id: 'question-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }));
  const event = f.events.at(-1);
  assert.equal(event.permissionMode, 'bypassPermissions');
  assert.equal(event.questions[0].id, 'claude-question-0');
  assert.equal(event.questions[1].multiSelect, true);
  assert.equal(f.writes.some(m => m.type === 'control_response'), false, 'a question cannot be automatically answered by Allow all');
  assert.throws(() => f.session.answerPermission('question-1', true, {}), /Answer each question/);
  assert.equal(f.session.permissions.size, 1, 'invalid answers keep the request available for retry');
  assert.equal(f.session.answerPermission('question-1', true, { 'claude-question-0': 'Main', 'claude-question-1': ['CSV', 'JSON'], 'claude-question-2': 'My project' }), true);
  assert.deepEqual(f.writes.at(-1).response.response, { behavior: 'allow', updatedInput: { ...input,
    answers: { 'Which files?': 'Main', 'Which outputs?': 'CSV, JSON', 'Project name?': 'My project' } } });
  assert.equal(f.session.answerPermission('question-1', true, {}), false);
  f.session.emitLine(JSON.stringify({ type: 'control_request', request_id: 'question-2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }));
  assert.equal(f.session.answerPermission('question-2', false, undefined, 'Questions skipped'), true);
  assert.deepEqual(f.writes.at(-1).response.response, { behavior: 'deny', message: 'Questions skipped' });
});

test('Claude empty successful replies become errors while restored background work stays visible', t => {
  const f = fixture(t, { sessionId: 'native-session' });
  f.session.sendUserMessage('Continue the goal and tasks');
  const send = row => f.session.emitLine(JSON.stringify(row));
  send({ type: 'system', subtype: 'init', session_id: 'native-session' });
  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'prevalidate', task_type: 'local_bash', description: 'Prevalidate round 109', status: 'running' },
  ] });
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  send({ type: 'result', subtype: 'success', result: '', usage });
  assert.equal(f.results[0].subtype, 'empty_response');
  assert.equal(f.results[0].is_error, true);
  assert.equal(f.results[0].result, 'Claude returned no reply or tool activity.');
  assert.deepEqual(f.results[0].usage, usage);
  assert.equal(f.session.backgroundTasks.get('prevalidate').description, 'Prevalidate round 109');
});

test('Claude retains valid text and tool turns but rejects blank, thinking-only or child-only replies', t => {
  for (const kind of ['text', 'stream', 'tool', 'result', 'blank', 'whitespace', 'thinking', 'child']) {
    const f = fixture(t);
    f.session.sendUserMessage('Continue');
    const send = row => f.session.emitLine(JSON.stringify(row));
    if (kind === 'text') send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } });
    if (kind === 'stream') send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Done' } } });
    if (kind === 'tool') send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] } });
    if (kind === 'child') send({ type: 'assistant', parent_tool_use_id: 'background-task', message: { content: [{ type: 'text', text: 'Child progress' }] } });
    if (['whitespace', 'thinking'].includes(kind)) send({ type: 'assistant', message: {
      content: [{ type: kind === 'thinking' ? 'thinking' : 'text', [kind === 'thinking' ? 'thinking' : 'text']: kind === 'thinking' ? 'Working' : ' \n' }],
    } });
    send({ type: 'result', subtype: 'success', result: kind === 'result' ? 'Done' : '' });
    const valid = ['text', 'stream', 'tool', 'result'].includes(kind);
    assert.equal(f.results[0].subtype, valid ? 'success' : 'empty_response', kind);
    assert.equal(Boolean(f.results[0].is_error), !valid, kind);
  }
});

test('a user stop normalizes native error results and clears the cancellation watchdog', t => {
  const f = fixture(t); f.session.sendUserMessage('work');
  f.session.emitLine('{"type":"system","subtype":"init"}');
  assert.equal(f.session.interrupt(), true);
  assert.equal(f.session.interrupt(), false);
  f.session.emitLine('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Interrupted"]}');
  assert.equal(f.results[0].subtype, 'stopped');
  assert.equal(f.results[0].is_error, false);
  assert.equal(f.timers.size, 0);
  f.session.sendUserMessage('next'); f.session.emitLine('{"type":"result","subtype":"success","result":"Next done"}');
  assert.equal(f.results[1].subtype, 'success');
});

test('an unacknowledged stop kills the owned session and ignores late results', t => {
  const f = fixture(t); f.session.sendUserMessage('work'); f.session.emitLine('{"type":"system","subtype":"init"}');
  f.session.interrupt(); f.timers.get(1)();
  assert.equal(f.proc.killed, true);
  assert.equal(f.results[0].subtype, 'stopped');
  f.proc.stdout.emit('data', Buffer.from('{"type":"result","subtype":"success"}\n'));
  assert.equal(f.results.length, 1);
  assert.equal(f.timers.size, 0);
});

test('stopping resolves pending permissions and does not open new approval dialogs', t => {
  const f = fixture(t); f.session.sendUserMessage('work');
  const request = id => JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo test' } } });
  f.session.emitLine(request('before'));
  f.session.interrupt(); f.session.emitLine(request('after'));
  assert.equal(f.events.filter(e => e.type === 'gui:permission').length, 1);
  assert.deepEqual(f.writes.filter(e => e.type === 'control_response').map(e => e.response.response.behavior), ['deny', 'deny']);
  assert.equal(f.session.permissions.size, 0);
});

test('native error details are exposed instead of only error_during_execution', t => {
  const f = fixture(t); f.session.sendUserMessage('work');
  f.session.emitLine('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Provider unavailable","Try again later"]}');
  assert.equal(f.results[0].result, 'Provider unavailable\nTry again later');
});

test('Claude spawn preserves the exact native edit cut and dropped-turn guard', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  h.configureApi();
  const resumeSessionAt = '12345678-1234-4234-8234-123456789abc';
  const resumeDropsTurn = '23456789-1234-4234-8234-123456789abc';
  const spec = h.api.claudeSpawnSpec({ model: 'test-model' }, { sessionId: 'source-native', fork: true, resumeSessionAt, resumeDropsTurn });
  assert.equal(spec.args.includes('--fork-session'), true);
  assert.equal(spec.args[spec.args.indexOf('--resume-session-at') + 1], resumeSessionAt);
  assert.equal(spec.args[spec.args.indexOf('--resume-drops-turn') + 1], resumeDropsTurn);
});

test('Claude waits for the current input identity before cutting an identical earlier request', async t => {
  const fs = require('node:fs'), os = require('node:os'), { randomUUID } = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-claude-input-'));
  t.after(() => require('./test-fs.cjs').removeTree(root));
  const file = path.join(root, 'history.jsonl'), parentUuid = randomUUID();
  const row = { type: 'user', uuid: randomUUID(), parentUuid, message: { content: 'Continue' } };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  const h = fixture(t);
  h.session.nativeHistory = { find: () => file };
  h.session.sendUserMessage('Continue');
  const inputId = h.writes.at(-1).uuid;
  assert.ok(inputId);
  assert.equal(await h.session.editBoundary('Continue'), null, 'The prior identical turn must be retained');
  h.session.complete({ subtype: 'stopped' });
  assert.equal(await h.session.editBoundary('Continue'), null, 'Stopping does not make unpersisted input observable');
  fs.appendFileSync(file, JSON.stringify({ ...row, uuid: inputId }) + '\n');
  assert.deepEqual(await h.session.editBoundary('Continue'), { resumeSessionAt: parentUuid, resumeDropsTurn: inputId });
});

test('invalid replacement settings preserve the idle process and stale cancel cannot interrupt a newer session', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  h.configureApi();
  h.call('claude-send', { prompt: 'first' });
  const id = h.finishTurn();
  const first = h.api.getSession();
  writeConfig(path.join(h.home, '.dsh', 'ollama-proxy.json'), normalizeConfig({ providers: [{ id: 'p', baseUrl: 'http://127.0.0.1:19099', models: [{ id: 'test', upstream: 'test' }], keys: [{ id: 'k', key: 'fake' }] }] }));
  const failed = h.call('claude-send', { sessionId: id, settings: { thinkingBudget: 'high' } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Select a configured model/);
  assert.equal(h.api.getSession(), first);
  assert.equal(first.dead, false);
  const before = h.processes.at(-1).messages.length;
  h.call('claude-cancel', first.gen - 1);
  assert.equal(h.processes.at(-1).messages.length, before);
});
