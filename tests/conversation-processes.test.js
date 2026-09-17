'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness } = require('./claude-harness.cjs');

test('main-process Claude conversations retain separate processes, route overlays and event destinations', async t => {
  const h = createHarness(); t.after(() => h.cleanup()); h.configureApi();
  h.api.sharedConversations.prepare = async () => {};
  const send = prompt => h.call('conversation-command', { engine: 'claude', action: 'send', payload: { prompt } });
  const a = await send('Conversation A'), b = await send('Conversation B');
  assert.equal(a.ok, true, a.error); assert.equal(b.ok, true, b.error);
  const [pa, pb] = h.processes;
  assert.equal(h.api.claudeSessions.sessions.size, 2);
  assert.equal(pa.killed, false); assert.equal(pb.killed, false);
  const overlay = proc => proc.args[proc.args.indexOf('--settings') + 1];
  assert.notEqual(overlay(pa), overlay(pb));
  assert.equal(JSON.parse(fs.readFileSync(overlay(pa))).env.ANTHROPIC_MODEL, 'test-model');
  assert.equal(h.api.sharedConversations.active.size, 2);
  h.finishTurn(pb);
  assert.equal(h.api.sharedConversations.active.has(a.sessionId), true);
  assert.equal(h.api.sharedConversations.active.has(b.sessionId), false);
  h.finishTurn(pa);
  const results = h.events.filter(e => e.channel === 'dsh:conversation-event' && e.data.type === 'result');
  assert.deepEqual(results.map(e => e.data.session_id), [b.sessionId, a.sessionId]);
  const continued = await h.call('conversation-command', { engine: 'claude', action: 'send', payload: { sessionId: a.sessionId, prompt: 'Continue A' } });
  assert.equal(continued.ok, true, continued.error);
  assert.equal(h.processes.length, 2, 'returning to a conversation reuses its own process');
  h.finishTurn(pa);
});

test('native message_delta after an assistant does not throw or strand the remaining stdout events', async t => {
  const h = createHarness(); t.after(() => h.cleanup()); h.configureApi();
  h.api.sharedConversations.prepare = async () => {};
  const run = await h.call('conversation-command', { engine: 'claude', action: 'send', payload: { prompt: 'Check files' } });
  const proc = h.processes.at(-1);
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Checked' }] } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'File contents' }] } },
    { type: 'result', subtype: 'success', result: 'Checked' },
  ];
  assert.doesNotThrow(() => proc.stdout.emit('data', Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')));
  assert.equal(h.api.sharedConversations.active.size, 0);
  const events = h.events.filter(e => e.channel === 'dsh:conversation-event' && e.data.session_id === run.sessionId).map(e => e.data);
  assert.equal(events.filter(e => e.type === 'result').length, 1);
  assert.ok(events.some(e => e.type === 'user'), 'the tool result in the same stdout chunk must reach the UI');
});

test('main launches Allow all with a stable mode and normal approvals retain their native command', async t => {
  const h = createHarness(); t.after(() => h.cleanup()); h.configureApi();
  h.api.sharedConversations.prepare = async () => {};
  await h.call('conversation-command', { engine: 'claude', action: 'save-settings', payload: { permissionMode: 'bypassPermissions' } });
  const run = await h.call('conversation-command', { engine: 'claude', action: 'send', payload: { prompt: 'Work' } });
  const proc = h.processes.at(-1);
  assert.equal(proc.args[proc.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(proc.args[proc.args.indexOf('--disallowedTools') + 1], 'EnterPlanMode');
  h.finishTurn(proc);
  await h.call('conversation-command', { engine: 'claude', action: 'save-settings', payload: { sessionId: run.sessionId, permissionMode: 'default' } });
  const normal = await h.call('conversation-command', { engine: 'claude', action: 'send', payload: { sessionId: run.sessionId, prompt: 'Next' } });
  const next = h.processes.at(-1), input = { command: 'echo fixture', description: 'Read-only fixture' };
  assert.equal(next.args.includes('--disallowedTools'), false);
  next.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'control_request', request_id: 'approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input } }) + '\n'));
  const answer = await h.call('conversation-command', { engine: 'claude', action: 'control-respond', payload: { sessionId: normal.sessionId, runId: normal.runId, requestId: 'approval', allow: true } });
  assert.equal(answer.ok, true);
  assert.deepEqual(next.messages.at(-1).response.response.updatedInput, input);
  h.finishTurn(next);
});
