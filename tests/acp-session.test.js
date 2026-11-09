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

test('Kimi idle task follow-up streams and saves a result without a new user message', async t => {
  const { session } = fixture(t), events = [];
  session.sessionId = 'kimi-background'; session.spec.modeEngine = 'kimi';
  session.onEvent = event => events.push(event); session.onResult = () => {};
  const receive = update => session.receive({ method: 'session/update', params: { sessionId: session.sessionId, update } });
  receive({ sessionUpdate: 'camellia_background_turn', state: 'started', turnId: 2 });
  assert.equal(session.running, true);
  receive({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'APK verified' } });
  receive({ sessionUpdate: 'camellia_background_turn', state: 'ended', turnId: 2, stopReason: 'end_turn' });
  assert.equal(session.running, false);
  assert.equal(events[0].type, 'gui:background-turn');
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).result, 'APK verified');
  const rows = fs.readFileSync(session.historyFile(), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.type), ['assistant']);
  assert.equal(rows[0].message.content[0].text, 'APK verified');
});

test('Kimi waits for a task follow-up that races the original prompt response', async t => {
  const { session } = fixture(t);
  session.sessionId = 'kimi-background'; session.spec.modeEngine = 'kimi'; session.ready = Promise.resolve();
  session.request = async () => {
    session.update({ sessionUpdate: 'camellia_background_turn', state: 'started', turnId: 2 });
    return { stopReason: 'end_turn' };
  };
  let result;
  session.onResult = event => { result = event; };
  session.sendUserMessage('Build');
  await new Promise(setImmediate);
  assert.equal(result, undefined);
  session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Build verified' } });
  session.update({ sessionUpdate: 'camellia_background_turn', state: 'ended', turnId: 2, stopReason: 'end_turn' });
  await new Promise(setImmediate);
  assert.equal(result.result, 'Build verified');
  assert.equal(result.subtype, 'success');
});

test('Kimi background follow-up cancellation and failures settle the visible run', t => {
  for (const cancelled of [false, true]) {
    const { session } = fixture(t), results = [];
    session.sessionId = 'kimi-background'; session.onResult = event => results.push(event);
    session.update({ sessionUpdate: 'camellia_background_turn', state: 'started', turnId: 2 });
    if (cancelled) session.interrupt();
    session.update({ sessionUpdate: 'camellia_background_turn', state: 'ended', turnId: 2,
      stopReason: cancelled ? 'cancelled' : 'error', error: 'Verification failed' });
    assert.equal(session.running, false);
    assert.equal(results[0].subtype, cancelled ? 'stopped' : 'error');
    assert.equal(results[0].is_error, !cancelled);
    if (!cancelled) assert.equal(results[0].result, 'Verification failed');
  }
});

test('ACP shutdown never signals a failed spawn without a positive child PID', t => {
  const { proc, session } = fixture(t);
  let kills = 0;
  proc.kill = () => { kills++; };
  for (const pid of [undefined, 0, -1]) {
    proc.pid = pid;
    session.kill();
    assert.equal(session.dead, true);
    assert.equal(kills, 0);
  }
  proc.pid = 123;
  session.kill();
  assert.equal(kills, 1);
});

test('ACP replies retain Unicode separators inside JSON strings', async t => {
  const { proc, session } = fixture(t);
  const pending = session.request('session/load', { sessionId: 'saved' }, 1000);
  const id = session.sequence, result = { text: 'Earlier\u2028中文🧪\u2029history' };
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  for (const byte of bytes) proc.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await pending, result);
  assert.equal(session.pending.size, 0);
});

test('Antigravity storage preparation uses a no-prompt handshake and validates both identities', async t => {
  const { session } = fixture(t), requests = [];
  session.spec.modeEngine = 'antigravity'; session.sessionId = '00000000-0000-4000-8000-000000000001';
  let result = { sessionId: session.sessionId, conversationId: '1'.repeat(32) };
  session.request = async (method, params) => { requests.push({ method, params }); return result; };
  assert.equal(await session.prepareNativeStorage(), '1'.repeat(32));
  assert.deepEqual(requests, [{ method: 'session/camellia_prepare', params: { sessionId: session.sessionId } }]);
  result = { ...result, sessionId: 'another' }; await assert.rejects(session.prepareNativeStorage(), /invalid identity/);
  result = { sessionId: session.sessionId, conversationId: '../history' }; await assert.rejects(session.prepareNativeStorage(), /invalid identity/);
  session.sessionId = 'agy-00000000-0000-4000-8000-000000000001';
  result = { sessionId: session.sessionId, conversationId: '00000000-0000-4000-8000-000000000002' };
  assert.equal(await session.prepareNativeStorage(), result.conversationId);
});

test('ACP adapters can translate a discovered boolean control to the native option spelling', async context => {
  const { session } = fixture(context), requests = [];
  session.settings.model = 'kimi-k2.6'; session.settings.thinkingBudget = 'none';
  session.spec.noModes = true; session.spec.thinkingId = 'reasoning_effort'; session.spec.thinkingValue = 'off';
  session.onSessionId = () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    return method === 'session/new' ? { sessionId: '00000000-0000-4000-8000-000000000001' } : { configOptions: [] };
  };
  await session.open();
  assert.equal(requests.find(request => request.params.configId === 'reasoning_effort').params.value, 'off');
});

test('Kimi sends a selected effort to the native thinking control', async t => {
  const { session } = fixture(t), requests = [];
  session.settings.model = 'kimi-code/k3.1-pro'; session.settings.thinkingBudget = 'max';
  session.spec.noModes = true; session.onSessionId = () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    return method === 'session/new' ? { sessionId: '00000000-0000-4000-8000-000000000001' } : { configOptions: [] };
  };
  await session.open();
  assert.deepEqual(requests.find(request => request.params.configId === 'thinking').params,
    { sessionId: '00000000-0000-4000-8000-000000000001', configId: 'thinking', value: 'max' });
});

test('Kimi empty turns are visible errors while text, tools and cancellation retain their outcomes', async t => {
  for (const kind of ['empty', 'whitespace', 'thinking', 'queued', 'text', 'tool', 'cancelled', 'refusal']) {
    const { session } = fixture(t);
    session.ready = Promise.resolve(); session.sessionId = 'kimi-fixture'; session.spec.modeEngine = 'kimi';
    session.request = async () => {
      if (['whitespace', 'text', 'thinking'].includes(kind)) session.update({
        sessionUpdate: kind === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: kind === 'whitespace' ? ' \n' : 'Working' },
      });
      if (kind === 'tool') session.update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', status: 'completed' });
      if (kind === 'queued') session.update({ sessionUpdate: 'agent_message_chunk', _meta: { camelliaQueuedPrompt: true },
        content: { type: 'text', text: 'This request is queued.' } });
      return { stopReason: ['cancelled', 'refusal'].includes(kind) ? kind : 'end_turn' };
    };
    const done = new Promise(resolve => { session.onResult = resolve; });
    session.sendUserMessage('Continue'); const result = await done;
    if (['empty', 'whitespace', 'thinking', 'queued'].includes(kind)) {
      assert.equal(result.subtype, 'empty_response'); assert.equal(result.is_error, true);
      assert.match(result.result, /Kimi returned no reply/);
      assert.doesNotMatch(result.result, /background|may not have started/);
    } else {
      assert.equal(result.subtype, kind === 'cancelled' ? 'stopped' : kind === 'refusal' ? 'refusal' : 'success');
      assert.equal(result.is_error, kind === 'refusal');
    }
  }
});

test('Kimi queue and idle background notices remain status events rather than reply text', async t => {
  const { session } = fixture(t), events = [];
  session.ready = Promise.resolve(); session.sessionId = 'kimi-fixture'; session.spec.modeEngine = 'kimi';
  session.onEvent = event => events.push(event);
  session.running = false; session.replayEvents = [];
  const background = { sessionUpdate: 'camellia_background_task', terminated: false,
    task: { id: 'bash-eval', description: 'Evaluation', kind: 'process', status: 'running' } };
  session.receive({ method: 'session/update', params: { sessionId: session.sessionId, update: background } });
  assert.equal(session.backgroundTasks.size, 1);
  session.request = async () => {
    session.update({ sessionUpdate: 'agent_message_chunk', _meta: { camelliaQueuedPrompt: true },
      content: { type: 'text', text: 'Kimi is finishing background work; this request is queued.' } });
    session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Actual answer' } });
    session.receive({ method: 'session/update', params: { sessionId: session.sessionId,
      update: { ...background, terminated: true, task: { ...background.task, status: 'completed' } } } });
    return { stopReason: 'end_turn' };
  };
  const done = new Promise(resolve => { session.onResult = resolve; });
  session.sendUserMessage('Continue');
  const result = await done;
  assert.equal(result.subtype, 'success');
  assert.equal(result.result, 'Actual answer');
  assert.equal(session.backgroundTasks.size, 0);
  assert.equal(events.filter(event => event.type === 'gui:prompt-queue').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'gui:background-work').map(event => event.tasks.length), [1, 0]);
  assert.equal(events.some(event => event.event?.delta?.text?.includes('finishing background work')), false);
});

test('Kimi read-only background snapshots settle missed ends and recover from unavailable status reads', async t => {
  const { session } = fixture(t), calls = [], events = [];
  session.sessionId = 'kimi-fixture'; session.spec.modeEngine = 'kimi'; session.spec.nativeBackgroundTasks = true;
  session.onEvent = event => events.push(event);
  const start = id => session.update({ sessionUpdate: 'camellia_background_task', task: { id, status: 'running' } });
  start('done'); start('waiting');
  session.request = async (method, params) => { calls.push({ method, params }); return { tasks: [
    { id: 'done', status: 'completed' }, { id: 'waiting', status: 'running' },
  ] }; };
  await session.backgroundMonitor.check();
  assert.deepEqual([...session.backgroundTasks.keys()], ['waiting']);
  assert.equal(calls[0].method, 'session/camellia_read_background');
  assert.equal(calls[0].params.sessionId, session.sessionId);
  session.request = async () => { throw new Error('Disconnected'); };
  await session.backgroundMonitor.check();
  assert.equal(session.backgroundTasks.get('waiting').status, 'unknown');
  assert.equal(events.at(-1).tasks[0].canStop, true);
  session.request = async () => ({ tasks: [] });
  await session.backgroundMonitor.check();
  assert.equal(session.backgroundTasks.size, 0);
  assert.equal(session.backgroundMonitor.timer, null);
  assert.equal(session.running, false);
});

test('Kimi JSON-RPC provider errors reach the result chip instead of the empty-response fallback', async t => {
  for (const partial of [false, true]) {
    const { session, proc } = fixture(t), events = [];
    session.ready = Promise.resolve(); session.sessionId = 'kimi-fixture'; session.spec.modeEngine = 'kimi';
    session.onEvent = event => events.push(event);
    const done = new Promise(resolve => { session.onResult = resolve; });
    session.sendUserMessage('Continue');
    await new Promise(resolve => setImmediate(resolve));
    const request = JSON.parse(proc.stdin.read().toString());
    if (partial) session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial reply' } });
    const message = "Internal error: 429 You've reached your 5-hour usage limit.";
    proc.stdout.write(JSON.stringify({ id: request.id, error: { code: -32603, message,
      data: { code: 'provider.api_error', statusCode: 429, retryable: false } } }) + '\n');
    const result = await done;
    assert.equal(result.subtype, 'error');
    assert.equal(result.is_error, true);
    assert.equal(result.result, message);
    assert.equal(events.findLast(event => event.type === 'result').result, message);
    assert.equal(session.dead, true);
  }
});

test('native preparation refuses a busy, closed or unrelated ACP engine', async t => {
  const { session } = fixture(t); let requests = 0;
  session.sessionId = 'existing'; session.request = async () => { requests++; };
  await assert.rejects(session.prepareNativeStorage(), /unavailable/);
  session.spec.modeEngine = 'antigravity'; session.running = true;
  await assert.rejects(session.prepareNativeStorage(), /unavailable/);
  session.running = false; session.dead = true;
  await assert.rejects(session.prepareNativeStorage(), /unavailable/);
  assert.equal(requests, 0);
});

for (const engine of ['kimi', 'dsh', 'antigravity']) test(`${engine} ACP approval reaches the UI and resolves once`, context => {
  const { session, proc } = fixture(context), events = [];
  session.spec.modeEngine = engine;
  session.sessionId = 'native-session'; session.running = true;
  session.replayEvents = [];
  session.onEvent = event => events.push(event);
  const request = { id: 71, method: 'session/request_permission', params: { sessionId: session.sessionId,
    toolCall: { title: 'Write', rawInput: { path: 'test.txt' } },
    options: [{ kind: 'allow_once', optionId: 'yes', name: 'Allow once' }, { kind: 'reject_once', optionId: 'no', name: 'Deny' }] } };
  session.receive(request);
  assert.equal(events.at(-1).type, 'gui:permission');
  assert.deepEqual(events.at(-1).input, { path: 'test.txt' });
  assert.equal(session.answerPermission('71', true), true);
  assert.equal(JSON.parse(proc.stdin.read().toString()).result.outcome.optionId, 'yes');
  assert.equal(session.answerPermission('71', true), false);
  session.receive({ ...request, id: 72 });
  assert.equal(session.answerPermission('72', false), true);
  assert.equal(JSON.parse(proc.stdin.read().toString()).result.outcome.optionId, 'no');
  session.cancelled = true;
  const count = events.length;
  session.receive({ ...request, id: 73 });
  assert.equal(events.length, count);
  assert.equal(JSON.parse(proc.stdin.read().toString()).result.outcome.outcome, 'cancelled');
});

test('Antigravity question answers use the existing permission channel and retain typed input', context => {
  const { session, proc } = fixture(context), events = [];
  session.sessionId = 'native'; session.running = true; session.replayEvents = []; session.onEvent = event => events.push(event);
  const questions = [{ id: 'agy-question-0', question: 'Language?', options: [{ label: 'Python' }] }];
  session.receive({ id: 'question', method: 'session/request_permission', params: { sessionId: 'native', questions,
    toolCall: { title: 'ask_question' }, options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }] } });
  assert.deepEqual(events.at(-1).questions, questions);
  assert.equal(session.answerPermission('question', true, { 'agy-question-0': 'Rust' }), true);
  assert.deepEqual(JSON.parse(proc.stdin.read().toString()).result, { outcome: { outcome: 'selected', optionId: 'allow' }, input: { 'agy-question-0': 'Rust' } });
});

test('Antigravity headless denial is a failed tool and does not create a pending permission', context => {
  const { session } = fixture(context), events = [];
  session.onEvent = event => events.push(event);
  session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'denied-1', status: 'failed', permissionBlocked: true,
    content: [{ type: 'content', content: { type: 'text', text: 'Native action already denied' } }] });
  assert.equal(events.at(-1).permissionBlocked, true);
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(session.permissions.size, 0);
});

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

test('a native denial that arrives after the turn still reaches the UI', context => {
  const { session } = fixture(context), events = [];
  session.sessionId = 'native-session'; session.running = true;
  session.onEvent = event => events.push(event);
  const notice = { sessionUpdate: 'tool_call_update', toolCallId: 'permission-1', title: 'Antigravity CLI permission blocked',
    status: 'failed', permissionBlocked: true, content: [{ type: 'content', content: { type: 'text', text: 'headless mode cannot prompt for' } }] };
  // The notice rides stderr, so on some platforms it lands after the result that
  // clears `running`. Dropping it would hide a real refusal from the user.
  session.running = false;
  session.receive({ method: 'session/update', params: { sessionId: session.sessionId, update: notice } });
  assert.equal(events.length, 1, 'a late denial must not be swallowed');
  assert.equal(events[0].permissionBlocked, true);
  assert.equal(events[0].status, 'failed');
});

test('only denials and background lifecycle updates are admitted after a turn, and never for a cancelled one', context => {
  const { session } = fixture(context), events = [];
  session.sessionId = 'native-session'; session.running = false;
  session.onEvent = event => events.push(event);
  const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stray text' } };
  session.receive({ method: 'session/update', params: { sessionId: session.sessionId, update } });
  assert.deepEqual(events, [], 'an ordinary late update stays out');
  session.cancelled = true;
  session.receive({ method: 'session/update', params: { sessionId: session.sessionId,
    update: { ...update, sessionUpdate: 'tool_call_update', permissionBlocked: true, status: 'failed' } } });
  assert.deepEqual(events, [], 'a cancelled turn does not report a denial');
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

test('ACP automatically continues output-token truncation with native progress intact', async t => {
  const { proc, session } = fixture(t), prompts = [], events = [];
  session.ready = Promise.resolve(); session.sessionId = 'dsh-native'; session.spec.modeEngine = 'dsh';
  session.onEvent = event => events.push(event);
  proc.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line);
      assert.equal(request.method, 'session/prompt'); prompts.push(request.params);
      const notify = update => proc.stdout.write(JSON.stringify({ method: 'session/update',
        params: { sessionId: session.sessionId, update } }) + '\n');
      if (prompts.length === 1) {
        notify({ sessionUpdate: 'tool_call', toolCallId: 'extract', title: 'pwsh', status: 'completed' });
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First ' } });
      } else {
        assert.equal(session.tools.get('extract').status, 'completed');
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second' } });
      }
      proc.stdout.write(JSON.stringify({ id: request.id,
        result: { stopReason: prompts.length === 1 ? 'max_tokens' : 'end_turn' } }) + '\n');
    }
  });
  const done = new Promise(resolve => { session.onResult = resolve; });
  session.sendUserMessage('Audit all links');
  const result = await done;
  assert.equal(result.subtype, 'success'); assert.equal(result.is_error, false);
  assert.equal(result.result, 'First Second'); assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].prompt, [{ type: 'text', text: 'Audit all links' }]);
  assert.equal(prompts[1].sessionId, 'dsh-native');
  assert.match(prompts[1].prompt[0].text, /output token limit/);
  assert.match(prompts[1].prompt[0].text, /without restarting or duplicating completed work/);
  assert.equal(events.filter(event => event.type === 'result').length, 1);
  assert.equal(session.dead, false);
  const history = fs.readFileSync(session.historyFile(), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(history.filter(row => row.type === 'user').length, 1);
});

test('ACP rejects inconsistent output-token responses without hiding earlier progress', async t => {
  const { session } = fixture(t); let calls = 0;
  session.ready = Promise.resolve(); session.sessionId = 'dsh-native'; session.spec.modeEngine = 'dsh';
  session.spec.maxOutputTokens = 32768;
  session.request = async () => {
    calls++;
    session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading files.' } });
    session.update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read', status: 'completed' });
    session.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I' } });
    return { stopReason: 'max_tokens' };
  };
  const done = new Promise(resolve => { session.onResult = resolve; });
  session.sendUserMessage('Continue'); const result = await done;
  assert.equal(calls, 1);
  assert.equal(result.subtype, 'error'); assert.equal(result.is_error, true);
  assert.match(result.result, /1 character of output.*32768 tokens.*response is inconsistent/);
  assert.doesNotMatch(result.result, /Reading files/);
  assert.equal(session.text, 'Reading files.');
});

test('ACP bounds output-token continuation and leaves other stop reasons untouched', async t => {
  for (const stopReason of ['max_tokens', 'refusal', 'max_turn_requests']) {
    const { session } = fixture(t); let calls = 0;
    session.ready = Promise.resolve(); session.sessionId = 'dsh-native'; session.spec.modeEngine = 'dsh';
    session.request = async () => {
      calls++;
      session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: stopReason } });
      return { stopReason };
    };
    const done = new Promise(resolve => { session.onResult = resolve; });
    session.sendUserMessage('Continue'); const result = await done;
    assert.equal(calls, stopReason === 'max_tokens' ? 4 : 1);
    assert.equal(result.subtype, stopReason); assert.equal(result.is_error, true);
    const message = { max_tokens: 'after 3 automatic continuations', refusal: 'refused the request',
      max_turn_requests: 'native turn-request limit' }[stopReason];
    assert.match(result.result, new RegExp(message));
  }
});

test('ACP cancellation wins over output-token recovery', async t => {
  const { session } = fixture(t); let calls = 0;
  session.ready = Promise.resolve(); session.sessionId = 'dsh-native'; session.spec.modeEngine = 'dsh';
  session.request = async () => { calls++; session.cancelled = true; return { stopReason: 'max_tokens' }; };
  const done = new Promise(resolve => { session.onResult = resolve; });
  session.sendUserMessage('Continue'); const result = await done;
  assert.equal(calls, 1); assert.equal(result.subtype, 'stopped'); assert.equal(result.is_error, false);
});
