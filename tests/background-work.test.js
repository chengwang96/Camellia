'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./main-process-harness.cjs');

test('desktop IPC stops the displayed background task through its pooled native session and can continue chatting', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  h.configureApi();
  h.api.sharedConversations.prepare = async () => {};
  h.api.sharedConversations.generateTitle = async () => '';
  const command = (action, payload) => h.call('conversation-command', { engine: 'claude', action, payload });
  const run = await command('send', { prompt: 'Run the evaluation in the background' });
  assert.equal(run.ok, true, run.error);
  const native = h.api.claudeSessions.get({ conversationId: run.sessionId });
  const proc = h.processes.findLast(item => item.messages.some(message => message.type === 'user'));
  const emit = row => proc.stdout.emit('data', JSON.stringify(row) + '\n');
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'evaluation', task_type: 'local_bash', description: 'Evaluation' }] });
  h.finishTurn(proc);
  const view = await command('load-session', run.sessionId);
  assert.equal(view.backgroundWork.tasks.length, 1);
  assert.equal(view.backgroundWork.tasks[0].canStop, true);
  assert.equal(h.api.sharedConversations.busy(run.sessionId), false);
  const stopped = command('stop-background-work', { sessionId: run.sessionId, tasks: view.backgroundWork.tasks });
  await new Promise(setImmediate);
  const request = proc.messages.at(-1);
  assert.deepEqual(request.request, { subtype: 'stop_task', task_id: 'evaluation' });
  emit({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } });
  assert.ok(h.api.sharedConversations.backgroundStatus(run.sessionId));
  emit({ type: 'system', subtype: 'task_updated', task_id: 'evaluation', patch: { status: 'stopped' } });
  assert.equal((await stopped).ok, true);
  assert.equal(h.api.sharedConversations.backgroundStatus(run.sessionId), null);
  assert.equal(proc.killed, false);
  assert.equal(proc.messages.some(message => message.request?.subtype === 'interrupt'), false);
  const next = await command('send', { sessionId: run.sessionId, prompt: 'Continue with the same context' });
  assert.equal(next.ok, true, next.error);
  assert.equal(h.api.claudeSessions.get({ conversationId: run.sessionId }), native);
  h.finishTurn(proc);
});

test('desktop state settles background completion during compaction without replacing the parent reply', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  h.configureApi();
  h.api.sharedConversations.prepare = async () => {};
  h.api.sharedConversations.generateTitle = async () => '';
  const command = (action, payload) => h.call('conversation-command', { engine: 'claude', action, payload });
  const run = await command('send', { prompt: 'Audit files in the background' });
  const native = h.api.claudeSessions.get({ conversationId: run.sessionId });
  const proc = h.processes.findLast(item => item.messages.some(message => message.type === 'user'));
  const emit = row => proc.stdout.emit('data', JSON.stringify(row) + '\n');
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'audit', task_type: 'local_agent' }, { task_id: 'shell', task_type: 'local_bash' },
  ] });
  h.finishTurn(proc, 'Parent reply retained');
  const before = await command('load-session', run.sessionId);
  assert.equal(before.backgroundWork.tasks.length, 2);
  const compacted = native.compact();
  emit({ type: 'system', subtype: 'task_notification', task_id: 'audit', status: 'completed', summary: 'Audit passed' });
  emit({ type: 'system', subtype: 'task_updated', task_id: 'shell', patch: { status: 'failed' } });
  emit({ type: 'system', subtype: 'compact_boundary' });
  emit({ type: 'result', subtype: 'success' });
  await compacted;
  const after = await command('load-session', run.sessionId);
  assert.equal(after.backgroundWork, null);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.subagents.find(task => task.id === 'audit').status, 'completed');
  assert.equal(after.subagents.find(task => task.id === 'audit').result, 'Audit passed');
  assert.equal(proc.killed, false);
});

test('stopping an already-ended background task verifies the missing terminal notice through a native snapshot', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  h.configureApi(); h.api.sharedConversations.prepare = async () => {}; h.api.sharedConversations.generateTitle = async () => '';
  const command = (action, payload) => h.call('conversation-command', { engine: 'claude', action, payload });
  const run = await command('send', { prompt: 'Run the evaluation in the background' });
  const proc = h.processes.findLast(item => item.messages.some(message => message.type === 'user'));
  const emit = row => proc.stdout.emit('data', JSON.stringify(row) + '\n');
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'evaluation', task_type: 'local_bash' }] });
  h.finishTurn(proc);
  const before = await command('load-session', run.sessionId);
  const stopped = command('stop-background-work', { sessionId: run.sessionId, tasks: before.backgroundWork.tasks });
  await new Promise(setImmediate);
  let request = proc.messages.at(-1);
  assert.equal(request.request.subtype, 'stop_task');
  emit({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } });
  await new Promise(setImmediate);
  request = proc.messages.at(-1);
  assert.equal(request.request.subtype, 'initialize');
  emit({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } });
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal((await stopped).ok, true);
  const after = await command('load-session', run.sessionId);
  assert.equal(after.backgroundWork, null);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(proc.killed, false);
});

test('desktop reports an empty resumed Claude reply without clearing native background work', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  h.configureApi(); h.api.sharedConversations.prepare = async () => {}; h.api.sharedConversations.generateTitle = async () => '';
  const command = (action, payload) => h.call('conversation-command', { engine: 'claude', action, payload });
  const run = await command('send', { prompt: 'Continue the goal and tasks' });
  const proc = h.processes.findLast(item => item.messages.some(message => message.type === 'user'));
  const emit = row => proc.stdout.emit('data', JSON.stringify(row) + '\n');
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'prevalidate', task_type: 'local_bash', description: 'Prevalidate round 109', status: 'running' },
  ] });
  emit({ type: 'result', subtype: 'success', result: '', usage: { input_tokens: 0, output_tokens: 0 } });
  const view = await command('load-session', run.sessionId);
  const reply = view.messages.at(-1);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.runResult.subtype, 'empty_response');
  assert.equal(reply.runResult.is_error, true);
  assert.equal(reply.runResult.result, 'Claude returned no reply or tool activity.');
  assert.equal(view.backgroundWork.tasks[0].description, 'Prevalidate round 109');
  assert.equal(view.activity, null);
});
