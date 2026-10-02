'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InteractiveCli, selection, permissionReply, questionFields, ownedTrajectories, interactiveLaunch } = require('../src/engines/antigravity/cli-interactive.cjs');

test('Unix interactive launch keeps a PTY open and passes native arguments literally', () => {
  const exe = "/Applications/Agent's CLI/agy", args = ['--model', "name'; $(touch injected); 'x"];
  assert.deepEqual(interactiveLaunch(exe, args, 'darwin'), { exe: '/bin/sh',
    args: ['-c', '/bin/cat | exec /usr/bin/script -q /dev/null "$@"', 'camellia-antigravity', exe, ...args], stdin: 'pipe' });
  assert.deepEqual(interactiveLaunch(exe, args, 'win32'), { exe, args, stdin: 'ignore' });
  if (process.platform !== 'win32') {
    const value = "quotes' \" $() `;&\\\n", script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const launch = interactiveLaunch(process.execPath, ['-e', script, value], 'linux');
    const result = require('node:child_process').spawnSync('/bin/sh', ['-c', launch.args[3]], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [value]);
    const mac = interactiveLaunch(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify({pipe:require("node:fs").fstatSync(0).isFIFO(),args:process.argv.slice(1)}))', value], 'darwin');
    // Inspect the descriptor arriving at the BSD script boundary. A Node
    // socketpair is not sufficient even when arguments are quoted correctly.
    mac.args[1] = mac.args[1].replace('/usr/bin/script -q /dev/null ', '');
    const pipe = require('node:child_process').spawnSync(mac.exe, mac.args, { encoding: 'utf8', timeout: 5000 });
    assert.ifError(pipe.error); assert.equal(pipe.status, 0, pipe.stderr);
    assert.deepEqual(JSON.parse(pipe.stdout), { pipe: true, args: [value] });
  }
});

for (const host of ['127.0.0.1', '::1']) test('interactive startup connects to a loopback listener on ' + host, () => {
  // Run the native bridge's loopback handshake in an isolated process, with
  // a broken proxy to verify that local IPC never follows the network proxy.
  const result = require('node:child_process').spawnSync(process.execPath,
    [require.resolve('./antigravity-loopback-fixture.cjs'), host], { encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', NO_PROXY: '', no_proxy: '',
        HTTP_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function fixture() {
  const messages = [], calls = [];
  const bridge = new InteractiveCli({}, message => messages.push(message));
  bridge.session = { id: 'agy-fixture', conversationId: 'root' };
  const turn = bridge.turn = { controller: new AbortController(), sent: new Map(), tools: new Map(), permissions: new Set(), usage: {} };
  bridge.rpc = async (method, params) => { calls.push({ method, params }); return {}; };
  return { bridge, turn, messages, calls };
}
function waiting(overrides = {}) {
  return { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_WAITING',
    metadata: { toolCall: { name: 'write_to_file', argumentsJson: '{"TargetFile":"fixture.txt"}' } },
    requestedInteraction: { permission: { resource: { action: 'write_file', target: 'fixture.txt' } } }, ...overrides };
}

test('interactive model selection pins the requested model and available effort', () => {
  const catalog = [{ modelId: 'gemini-high', modelOrAlias: { model: 'HIGH' } }, { modelId: 'other', modelOrAlias: { model: 'OTHER' } }];
  assert.equal(selection(catalog, 'gemini', 'high').modelOrAlias.model, 'HIGH');
  assert.throws(() => selection(catalog, 'gemini', 'invalid'), /invalid model selection/);
  assert.throws(() => selection(catalog, 'missing'), /invalid model selection/);
});

test('native approval resumes only its original trajectory step, once', async () => {
  const { bridge, turn, messages, calls } = fixture();
  bridge.step(turn, { trajectoryId: 'trajectory' }, waiting(), 2);
  bridge.step(turn, { trajectoryId: 'trajectory' }, waiting(), 2);
  const requests = messages.filter(message => message.method === 'session/request_permission');
  assert.equal(requests.length, 1); assert.equal(calls.length, 0);
  assert.deepEqual(requests[0].params.toolCall.rawInput, { TargetFile: 'fixture.txt' });
  const reply = { id: requests[0].id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } };
  await bridge.reply(reply); await bridge.reply(reply);
  assert.deepEqual(calls, [{ method: 'HandleCascadeUserInteraction', params: { cascadeId: 'root',
    interaction: { trajectoryId: 'trajectory', stepIndex: 2, permission: { allow: true, scope: 'PERMISSION_SCOPE_ONCE' } } } }]);
});

test('denied, cancelled and unknown approval outcomes never grant permission', async () => {
  for (const outcome of [{ outcome: 'selected', optionId: 'deny' }, { outcome: 'cancelled' }, { outcome: 'selected', optionId: 'allow-always' }]) {
    const { bridge, turn, messages, calls } = fixture();
    bridge.step(turn, { trajectoryId: 'trajectory' }, waiting(), 2);
    await bridge.reply({ id: messages.at(-1).id, result: { outcome } });
    assert.equal(calls[0].params.interaction.permission.allow, false);
    assert.equal(calls[0].params.interaction.permission.scope, 'PERMISSION_SCOPE_ONCE');
  }
});

test('stopped or superseded turns cannot consume a late approval', async () => {
  for (const stopped of [false, true]) {
    const { bridge, turn, messages, calls } = fixture();
    bridge.step(turn, { trajectoryId: 'trajectory' }, waiting(), 2);
    if (stopped) await bridge.cancel(); else bridge.turn = { controller: new AbortController() };
    await bridge.reply({ id: messages.at(-1).id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    assert.ok(!calls.some(call => call.method === 'HandleCascadeUserInteraction'));
  }
});

test('cancelling an in-flight denial does not break the reusable connection', async () => {
  const { bridge, turn, messages } = fixture();
  bridge.step(turn, { trajectoryId: 'trajectory' }, waiting(), 2);
  bridge.rpc = async (method, _params, signal) => {
    if (method === 'HandleCascadeUserInteraction') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const pending = bridge.reply({ id: messages.at(-1).id, result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
  await bridge.cancel(); await pending;
  assert.equal(bridge.closed, false);
});

test('native tool errors are visible and a planner failure cannot look like success', () => {
  const { bridge, turn, messages } = fixture();
  bridge.step(turn, { trajectoryId: 'trajectory' }, waiting({ status: 'CORTEX_STEP_STATUS_ERROR',
    requestedInteraction: undefined, error: { shortError: 'user denied permission' } }), 2);
  assert.equal(messages.at(-1).params.update.status, 'failed');
  assert.match(messages.at(-1).params.update.content[0].content.text, /user denied/);
  assert.equal(turn.error, undefined, 'The model can recover after a tool failure');
  bridge.step(turn, { trajectoryId: 'trajectory' }, { type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_ERROR', error: { shortError: 'Model unavailable' } }, 3);
  assert.equal(turn.error, 'Model unavailable');
});

test('only owned subtrajectories are inspected and their replies stay out of the public answer', async () => {
  const summaries = { root: {}, child: { trajectoryMetadata: { rootConversationId: 'root' } }, unrelated: { trajectoryMetadata: { rootConversationId: 'other' } } };
  assert.deepEqual(ownedTrajectories(summaries, 'root').map(([id]) => id), ['root', 'child']);
  const { bridge, turn, messages, calls } = fixture();
  bridge.step(turn, { trajectoryId: 'child-trajectory' }, waiting({ plannerResponse: { response: 'Private child response' } }), 3, 'child');
  assert.ok(!messages.some(message => message.params.update?.sessionUpdate === 'agent_message_chunk'));
  await bridge.reply({ id: messages.at(-1).id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.equal(calls[0].params.cascadeId, 'child'); assert.equal(calls[0].params.interaction.trajectoryId, 'child-trajectory');
});

test('native questions retain option IDs, typed answers, multiple selections and cancellation', () => {
  const request = { askQuestion: { questions: [{ question: 'Which language?', isMultiSelect: true, options: [{ id: 'py', text: 'Python' }, { id: 'js', text: 'JavaScript' }] }] } };
  assert.deepEqual(questionFields(request), [{ id: 'agy-question-0', question: 'Which language?', multiSelect: true, options: [{ label: 'Python' }, { label: 'JavaScript' }] }]);
  const result = permissionReply(request, true, { 'agy-question-0': ['Python', 'Rust'] }).askQuestion;
  assert.equal(result.cancelled, false); assert.deepEqual(result.responses[0].selectedOptionIds, ['py']);
  assert.equal(result.responses[0].writeInResponse, 'Rust');
  assert.deepEqual(permissionReply(request, false), { askQuestion: { cancelled: true, responses: [] } });
  assert.throws(() => permissionReply({ unknownInteraction: {} }, true), /unsupported interaction/);
});

test('streaming text and per-turn usage do not duplicate repeated native polls', () => {
  const { bridge, turn, messages } = fixture();
  for (const response of ['Hi', 'Hi there', 'Hi there']) bridge.step(turn, { trajectoryId: 'trajectory' }, {
    plannerResponse: { response }, metadata: { modelUsage: { inputTokens: '12', outputTokens: '7' } }, status: 'CORTEX_STEP_STATUS_DONE',
  }, 1);
  assert.equal(messages.filter(message => message.params.update.sessionUpdate === 'agent_message_chunk').map(message => message.params.update.content.text).join(''), 'Hi there');
  assert.equal(turn.usage.input_tokens, 12); assert.equal(turn.usage.output_tokens, 7);
});

test('prepared interactive sessions reject a different identity before native work', async () => {
  const { bridge, calls } = fixture();
  await assert.rejects(bridge.handle('session/prompt', { sessionId: 'wrong', prompt: [] }), /identity mismatch/);
  await assert.rejects(bridge.handle('session/set_mode', { sessionId: 'wrong', modeId: 'bypassPermissions' }), /identity mismatch/);
  await assert.rejects(bridge.handle('session/new', { cwd: process.cwd() }), /already initialized/);
  assert.equal(calls.length, 0);
});
