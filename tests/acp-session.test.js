'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const os = require('node:os');
const { AcpSession } = require('../src/engines/acp-session');

function fixture(t) {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
  });
  const session = new AcpSession({ gen: 1, settings: { cwd: os.tmpdir() }, opts: {}, exe: 'fake',
    spec: { args: [], env: {} }, spawn: () => proc, log() {} });
  session.start();
  t.after(() => {
    session.kill();
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) stream.destroy();
  });
  return { proc, session };
}

test('ACP consumes a final reply after process exit before closing the transport', async t => {
  const { proc, session } = fixture(t);
  const reply = session.request('session/prompt', {}).then(value => ({ value }), error => ({ error }));
  const id = JSON.parse(proc.stdin.read().toString()).id;
  proc.emit('exit', 0);
  const ended = once(proc.stdout, 'end');
  // The last frame can arrive without a newline while stdout drains.
  proc.stdout.end(JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }));
  await ended;
  proc.emit('close', 0);
  const result = await reply;
  assert.equal(result.error, undefined);
  assert.equal(result.value.stopReason, 'end_turn');
  assert.equal(session.pending.size, 0);
});

test('ACP sends the conversation-scoped goal MCP server on creation and resume', async t => {
  for (const sourceId of [undefined, 'saved-session']) {
    const { session } = fixture(t);
    const requests = [];
    session.opts = { sessionId: sourceId, goalBridge: { config: { command: process.execPath, args: ['goal-mcp-stdio.js'], env: { CAMELLIA_GOAL_TOKEN: 'private' } } } };
    session.onSessionId = () => {};
    session.onEvent = () => {};
    session.request = async (method, params) => { requests.push({ method, params }); return { sessionId: sourceId || 'new-session', configOptions: [] }; };
    await session.open();
    const request = requests.find(entry => entry.method === (sourceId ? 'session/resume' : 'session/new'));
    assert.deepEqual(request.params.mcpServers, [{ name: 'camellia_goals', command: process.execPath, args: ['goal-mcp-stdio.js'], env: [{ name: 'CAMELLIA_GOAL_TOKEN', value: 'private' }] }]);
  }
});

test('ACP rejects unfinished requests when the process closes without a reply', async t => {
  const { proc, session } = fixture(t);
  const rejected = assert.rejects(session.request('initialize', {}), /process exited \(1\)/);
  proc.emit('close', 1);
  await rejected;
  assert.equal(session.dead, true);
  assert.equal(session.pending.size, 0);
});

test('ACP partial updates retain arguments and correctly mark native nonzero shell exits', t => {
  const { session } = fixture(t), events = [];
  session.onEvent = event => events.push(event);
  session.update({ sessionUpdate: 'tool_call', toolCallId: 'pwsh-1', title: 'pwsh', rawInput: { command: 'exit 7' }, status: 'in_progress' });
  session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'pwsh-1', content: [{ type: 'content', content: { type: 'text', text: 'output\n[exit code: 7]' } }] });
  session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'pwsh-1', status: 'completed' });
  const tool = events.at(-1);
  assert.equal(tool.name, 'pwsh'); assert.equal(tool.input.command, 'exit 7');
  assert.equal(tool.output, 'output\n[exit code: 7]');
  assert.equal(tool.status, 'failed'); assert.equal(tool.is_error, true);
});
