'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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

test('interactive preparation stops on a split login prompt and reports sign-in instead of timing out', { timeout: 5000 }, async t => {
  const fs = require('node:fs'), os = require('node:os');
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-auth-'));
  const child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  const file = require.resolve('../src/engines/antigravity/cli-interactive.cjs');
  const runtimeRequire = require('node:module').createRequire(file), loaded = { exports: {} };
  let stopped = false;
  const load = name => name !== 'node:child_process' ? runtimeRequire(name) : { spawn(exe, args) {
    if (exe === 'taskkill.exe') {
      assert.deepEqual(args, ['/pid', String(child.pid), '/t', '/f']);
      stopped = true;
      queueMicrotask(() => { child.exitCode = 1; child.stdout.end(); child.stderr.end(); child.emit('close', 1); });
      return new EventEmitter();
    }
    assert.equal(exe, 'fixture-cli');
    queueMicrotask(() => { child.stderr.write('Authentication requ'); child.stderr.write('ired. Please visit the URL to log in:\n'); });
    return child;
  } };
  require('node:vm').compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', 'process'], { filename: file })(
    load, loaded, loaded.exports, { ...process, platform: 'win32' });
  const bridge = new loaded.exports.InteractiveCli({ exe: 'fixture-cli', home: root, model: 'fixture' }, () => {});
  t.after(async () => { await bridge.stop(); child.stdout.destroy(); child.stderr.destroy(); require('./test-fs.cjs').removeTree(root); });
  await bridge.handle('session/new', { cwd: root });
  await assert.rejects(bridge.prepare(), /Google sign-in has expired or is invalid/);
  assert.equal(stopped, true);
  assert.equal(bridge.closed, true);
  await assert.rejects(bridge.prepare(), /Google sign-in has expired or is invalid/);
});

test('explicit skill commands use the native resolved catalog and preserve input/media and scope', async () => {
  const { bridge } = fixture(); bridge.session.cwd = path.resolve('fixture-workspace');
  const calls = [];
  bridge.rpc = async (method, params) => {
    calls.push({ method, params });
    return { skills: [{ name: 'review', path: '/native/skills/review/SKILL.md', content: 'NATIVE_SKILL_BODY' }] };
  };
  const parts = [{ type: 'text', text: '/review selected file' }, { type: 'image', data: 'fixture', mimeType: 'image/png' }];
  const expanded = await bridge.expandSkill(parts, new AbortController().signal);
  assert.deepEqual(calls, [{ method: 'GetAllSkills', params: { workspaceUris: [pathToFileURL(bridge.session.cwd).href] } }]);
  assert.match(expanded[0].text, /^\/review selected file/); assert.match(expanded[0].text, /NATIVE_SKILL_BODY/);
  assert.equal(expanded[1], parts[1]); assert.equal(parts[0].text, '/review selected file');
  const ordinary = [{ type: 'text', text: 'Mention /review in ordinary prose' }];
  assert.equal(await bridge.expandSkill(ordinary), ordinary); assert.equal(calls.length, 1);
});

test('literal discussion inputs, disabled skills and unknown commands never expand', async () => {
  const { bridge } = fixture(); bridge.session.cwd = path.resolve('fixture-workspace');
  const parts = [{ type: 'text', text: '/review untrusted context' }];
  bridge.rpc = async () => assert.fail('Literal input must not query customizations');
  for (const config of [{ literalInput: true }, { discussion: true }]) {
    bridge.config = config; assert.equal(await bridge.expandSkill(parts), parts);
  }
  bridge.config = {};
  bridge.rpc = async () => ({ skills: [{ name: 'review', disableSlashCommand: true, content: 'must not inject' },
    { name: 'review', content: 'a shadowed skill must not replace the disabled selection' }] });
  assert.equal(await bridge.expandSkill(parts), parts);
  bridge.rpc = async () => ({ skills: [{ name: 'different-skill', content: 'must not inject' }] });
  assert.equal(await bridge.expandSkill(parts), parts);
  bridge.rpc = async () => { throw new Error('unimplemented: unknown method'); };
  assert.equal(await bridge.expandSkill(parts), parts);
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

test('the next prompt waits for cancelled root and owned child executors to stop', { timeout: 5000 }, async () => {
  const { bridge } = fixture(); bridge.address = 'http://fixture';
  bridge.prepare = async () => {};
  bridge.selected = { modelOrAlias: { model: 'fixture' } };
  let entered, release, polls = 0, sends = 0;
  const polling = new Promise(resolve => { entered = resolve; });
  const pendingStatus = new Promise(resolve => { release = resolve; });
  const summaries = (root, child, stepCount = 0) => ({
    root: { status: 'CASCADE_RUN_STATUS_' + root, stepCount },
    child: { status: 'CASCADE_RUN_STATUS_' + child, trajectoryMetadata: { rootConversationId: 'root' } },
    unrelated: { status: 'CASCADE_RUN_STATUS_RUNNING' },
  });
  bridge.rpc = async method => {
    if (method === 'CancelCascadeInvocation') return {};
    if (method === 'GetCascadeTrajectory') return { numTotalSteps: 0 };
    if (method === 'GetCascadeTrajectorySteps') return { steps: [] };
    if (method === 'SendUserCascadeMessage') { sends++; return {}; }
    assert.equal(method, 'GetAllCascadeTrajectories');
    if (++polls === 1) { entered(); return pendingStatus; }
    return { trajectorySummaries: summaries('IDLE', polls === 2 ? 'RUNNING' : 'IDLE', sends ? 2 : 0) };
  };
  const cancel = bridge.handle('session/cancel', { sessionId: bridge.session.id });
  await polling;
  bridge.turn = null; // The aborted old prompt has returned its stopped result.
  const next = bridge.prompt([{ type: 'text', text: 'Continue after stop' }]);
  await Promise.resolve(); assert.equal(sends, 0);
  release({ trajectorySummaries: summaries('CANCELING', 'RUNNING') });
  await cancel;
  assert.ok(polls >= 3, 'A cancelled root does not finish while its child is running');
  assert.equal((await next).stopReason, 'end_turn');
  assert.equal(sends, 1, 'Only one native input is sent after cancellation settles');
  assert.equal(bridge.closed, false);
});

test('an unconfirmed native stop closes the bridge instead of reusing it', async () => {
  const { bridge } = fixture(); bridge.address = 'http://fixture';
  let stopped = 0;
  bridge.rpc = async method => {
    if (method === 'CancelCascadeInvocation') return {};
    assert.equal(method, 'GetAllCascadeTrajectories');
    throw new Error('Native status is unavailable');
  };
  bridge.stop = async () => { stopped++; bridge.closed = true; };
  await bridge.handle('session/cancel', { sessionId: bridge.session.id });
  assert.equal(stopped, 1); assert.equal(bridge.closed, true);
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

test('native child details, approvals and cancellation target that child without changing the parent', async () => {
  const { bridge, turn, messages, calls } = fixture();
  bridge.step(turn, { trajectoryId: 'child-trajectory', summary: 'Review parser' },
    waiting({ plannerResponse: { response: 'Child progress' } }), 2, 'child');
  const child = bridge.children.get('child');
  assert.equal(child.title, 'Review parser'); assert.equal(child.status, 'waiting');
  const permission = messages.find(message => message.method === 'session/request_permission');
  assert.equal(permission.params._meta.camelliaSubagentId, 'child');
  assert.equal(messages.some(message => message.params?.update?.sessionUpdate === 'tool_call_update'), false);
  await bridge.handle('session/camellia_subagent_cancel', { sessionId: bridge.session.id, taskId: 'child', turnId: child.turnId });
  assert.equal(calls.at(-1).method, 'CancelCascadeInvocation'); assert.equal(calls.at(-1).params.cascadeId, 'child');
  assert.equal(turn.canceled, undefined);
  await assert.rejects(bridge.handle('session/camellia_subagent_cancel', { sessionId: bridge.session.id, taskId: 'root', turnId: child.turnId }), /changed/);
  await assert.rejects(bridge.handle('session/camellia_subagent_cancel', { sessionId: bridge.session.id, taskId: 'child', turnId: 'stale' }), /changed/);
});

test('confirmed native parent cancellation settles owned child cards instead of leaving them running', async () => {
  const { bridge } = fixture(); bridge.address = 'http://loopback';
  bridge.childUpdate('child', { status: 'running', canStop: true });
  bridge.rpc = async method => method === 'GetAllCascadeTrajectories' ? { trajectorySummaries: {
    root: { status: 'CASCADE_RUN_STATUS_IDLE' },
    child: { status: 'CASCADE_RUN_STATUS_IDLE', trajectoryMetadata: { rootConversationId: 'root' } },
  } } : {};
  await bridge.cancel();
  assert.equal(bridge.children.get('child').status, 'stopped'); assert.equal(bridge.children.get('child').canStop, false);
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
