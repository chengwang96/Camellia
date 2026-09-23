'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { AcpSession } = require('../src/engines/acp-session');

function fixture(t) {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
  });
  const history = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'acp-history-')) };
  t.after(() => fs.rmSync(history.root, { recursive: true, force: true }));
  const session = new AcpSession({ gen: 1, settings: { cwd: os.tmpdir() }, opts: {}, exe: 'fake',
    spec: { args: [], env: {} }, spawn: () => proc, log() {}, history });
  session.start();
  t.after(() => {
    session.kill();
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) stream.destroy();
  });
  return { proc, session };
}

test('Kimi compaction waits for background completion, not the slash command acknowledgement', async context => {
  const { session } = fixture(context), requests = [];
  session.ready = Promise.resolve(); session.sessionId = 'kimi-native'; session.spec.modeEngine = 'kimi';
  session.availableCommands = [{ name: 'compact' }];
  session.request = async (method, params) => { requests.push({ method, params }); return { stopReason: 'end_turn' }; };
  let settled = false;
  const done = session.compact().then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(requests, [{ method: 'session/prompt', params: { sessionId: 'kimi-native', prompt: [{ type: 'text', text: '/compact' }] } }]);
  session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Context compaction started — it runs in the background.' } });
  assert.equal(settled, false);
  session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Compaction completed.\n- Messages compacted: 10\n- Tokens before: 20,000\n- Tokens after: 2,000' } });
  assert.deepEqual(await done, { ok: true });
  assert.equal(session.running, false);
  assert.equal(session.sessionId, 'kimi-native');
});

for (const mode of ['unsupported', 'cancel', 'timeout', 'exit', 'blocked']) test('ACP compaction safely handles ' + mode, async context => {
  const { session } = fixture(context);
  session.ready = Promise.resolve(); session.sessionId = 'kimi-native'; session.spec.modeEngine = 'kimi';
  session.availableCommands = mode === 'unsupported' ? [] : [{ name: 'compact' }];
  let calls = 0;
  session.request = async () => { calls++; return { stopReason: 'end_turn' }; };
  const done = session.compact({ timeoutMs: mode === 'timeout' ? 15 : 1000 });
  const rejected = assert.rejects(done, mode === 'unsupported' ? { code: -32601 } : /stopped|timed out|blocked/i);
  await new Promise(resolve => setImmediate(resolve));
  if (mode === 'cancel') session.interrupt();
  if (mode === 'exit') session.kill();
  if (mode === 'blocked') session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Compaction is blocked by the current turn; retry when the turn is idle.' } });
  await rejected;
  assert.equal(session.running, false);
  if (mode === 'unsupported') assert.equal(calls, 0);
});

test('ACP records command advertisements before session initialization completes', context => {
  const { session } = fixture(context);
  session.receive({ method: 'session/update', params: { sessionId: 'opening', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } } });
  assert.deepEqual(session.availableCommands, [{ name: 'compact' }]);
});

test('Antigravity compaction hook updates are progress, not tools or replies', context => {
  const { session } = fixture(context), events = [];
  session.onEvent = event => events.push(event);
  session.update({ sessionUpdate: 'camellia_compaction', state: 'completed' });
  assert.equal(events[0].type, 'gui:compaction');
  assert.equal(events[0].state, 'completed');
});

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

for (const support of [undefined, false, true]) {
  test('ACP image attachments follow advertised prompt capabilities (' + support + ')', async t => {
    const { session } = fixture(t), prompts = [];
    const image = { isImage: true, path: path.join(os.tmpdir(), 'acp-image-check-' + process.pid + '-' + String(support) + '.png') };
    fs.writeFileSync(image.path, Buffer.from('fake-png'));
    t.after(() => fs.rmSync(image.path, { force: true }));
    session.ready = Promise.resolve();
    session.sessionId = 'dsh-native';
    session.promptCapabilities = { ...(support === true ? { image: true } : {}) };
    session.request = async (method, params) => { if (method === 'session/prompt') prompts.push(params.prompt); return { stopReason: 'end_turn' }; };
    const done = new Promise(resolve => session.onEvent = event => { if (event.type === 'result') resolve(event); });
    session.sendUserMessage('describe this', [image]);
    const result = await done;
    if (support !== true) {
      assert.equal(result.is_error, true);
      assert.match(result.result, /did not advertise inline image prompts/);
      assert.equal(prompts.length, 0);
    } else {
      assert.notEqual(result.is_error, true);
      assert.equal(prompts[0].length, 2);
      assert.equal(prompts[0][1].type, 'image');
      assert.equal(prompts[0][1].mimeType, 'image/png');
    }
  });
}

test('ACP stores inline image capability from the initialize result', async t => {
  const { session } = fixture(t);
  session.opts = {};
  session.onSessionId = () => {};
  session.onEvent = () => {};
  session.request = async method =>
    method === 'initialize' ? { agentCapabilities: { promptCapabilities: { image: true, audio: false, embeddedContext: true } } }
      : { sessionId: 'native-session', configOptions: [] };
  await session.open();
  assert.deepEqual(session.promptCapabilities, { image: true, audio: false, embeddedContext: true });
});
