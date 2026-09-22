'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ClaudeSession } = require('../src/engines/claude-session');
const { createHarness } = require('./claude-harness.cjs');
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

test('a user stop normalizes native error results and clears the cancellation watchdog', t => {
  const f = fixture(t); f.session.sendUserMessage('work');
  f.session.emitLine('{"type":"system","subtype":"init"}');
  assert.equal(f.session.interrupt(), true);
  assert.equal(f.session.interrupt(), false);
  f.session.emitLine('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Interrupted"]}');
  assert.equal(f.results[0].subtype, 'stopped');
  assert.equal(f.results[0].is_error, false);
  assert.equal(f.timers.size, 0);
  f.session.sendUserMessage('next'); f.session.emitLine('{"type":"result","subtype":"success"}');
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
