'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ClaudeSession } = require('../src/engines/claude-session');
const { createHarness } = require('./claude-harness.cjs');
const path = require('node:path');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');

function fixture(t) {
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false });
  const writes = [], events = [], results = [], timers = new Map();
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: line => writes.push(JSON.parse(line)) });
  proc.kill = () => { proc.killed = true; };
  const session = new ClaudeSession({ gen: 1, settings: { cwd: 'test' }, opts: {}, exe: 'fake', spec: { args: [], cwd: 'test' },
    spawn: () => proc, onEvent: ev => events.push(ev), onResult: ev => results.push(ev),
    setTimer: fn => { timers.set(1, fn); return 1; }, clearTimer: id => timers.delete(id) });
  session.start();
  t.after(() => session.kill());
  return { session, proc, writes, events, results, timers };
}

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
