'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { patchKimiHistory } = require('../src/engines/kimi-native-history');
const { patchKimiAcpTurns } = require('../src/engines/kimi-acp-turns');

const runtime = path.resolve(__dirname, '../runtimes/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs');
const source = fs.existsSync(runtime) ? fs.readFileSync(runtime, 'utf8') : null;
let NativeSession;
async function fixture() {
  if (!NativeSession) {
    const patched = patchKimiHistory(source);
    assert.ok(patched);
    const start = patched.indexOf('AcpSession = class {') + 'AcpSession = '.length;
    const end = patched.indexOf('\n\t};\n}));', start) + '\n\t};'.length;
    NativeSession = vm.runInNewContext('(' + patched.slice(start, end).trim().replace(/;$/, '') + ')', {
      globalThis: { crypto: require('node:crypto') }, DEFAULT_MODE_ID: 'manual',
      looseObject: () => ({}), literal: () => ({}), string: () => ({}),
      AcpInteractionBridge: class {}, log: { warn() {} }, isAuthError: error => error?.code === 'provider.auth',
      RequestError$1: {
        internalError: (data, message) => Object.assign(new Error(message), { code: -32603, data }),
        authRequired: (_, message) => Object.assign(new Error(message), { code: -32000 }),
        invalidRequest: (_, message) => new Error(message),
      },
      mapPromptLaunchError: error => error,
      turnEndReasonToStopReason: (reason, error) => reason === 'cancelled' ? 'cancelled'
        : reason === 'blocked' || error?.code === 'provider.filtered' ? 'refusal' : 'end_turn',
      assistantDeltaToSessionUpdate: (sessionId, event) => ({ sessionId, update: { content: { text: event.delta } } }),
    });
  }
  const listeners = new Map(), updates = [], submissions = [], cancellations = [];
  const events = { on(type, callback) { listeners.set(type, callback); return { dispose() {} }; } };
  const agent = { events, getModel: async () => 'fixture', getThinking: async () => 'off',
    prompt: async input => { submissions.push(input); }, cancel: async input => { cancellations.push(input); } };
  const session = { agent: () => agent, events: { on: () => ({ dispose() {} }) }, skills: { list: async () => [] } };
  const native = new NativeSession({ sessionUpdate: async row => updates.push(row) }, { session: () => session },
    'fixture', { onTerminalCreated: () => () => {} });
  native.emitUsageUpdate = () => {};
  await native.init();
  return { native, agent, submissions, cancellations, updates, emit: (type, event) => listeners.get(type)({ type, ...event }) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Kimi queued prompt waits for its own turn and forwards its reply, ignoring a background turn', { skip: !source }, async () => {
  const h = await fixture();
  let finished = false;
  const result = h.native.driveTurn([{ type: 'text', text: 'Continue the goal' }]).then(value => { finished = true; return value; });
  await settle();
  const promptId = h.submissions[0].promptId;
  h.emit('turn.started', { turnId: 4 });
  h.emit('assistant.delta', { turnId: 4, delta: 'Background output' });
  h.emit('turn.ended', { turnId: 4, reason: 'completed' });
  h.emit('prompt.completed', { promptId: 'another-prompt', reason: 'completed' });
  await settle();
  assert.equal(finished, false); assert.equal(h.updates.length, 1);
  assert.match(h.updates[0].update.content.text, /request is queued/);
  h.emit('turn.started', { turnId: 5, promptId });
  h.emit('assistant.delta', { turnId: 5, delta: 'Verified the output.\n<goal:complete>' });
  h.emit('turn.ended', { turnId: 5, reason: 'completed' });
  assert.equal((await result).stopReason, 'end_turn');
  assert.equal(h.updates[1].update.content.text, 'Verified the output.\n<goal:complete>');
  assert.equal(h.native.driver, undefined);
});

test('Kimi forwards background task lifecycle without exposing command lines', { skip: !source }, async () => {
  const h = await fixture();
  const info = { taskId: 'bash-eval', description: 'Governed policy evaluation', kind: 'process', status: 'running', command: 'private command' };
  h.emit('task.started', { info });
  assert.deepEqual({ ...h.updates[0].update, task: { ...h.updates[0].update.task } }, { sessionUpdate: 'camellia_background_task', terminated: false,
    task: { id: 'bash-eval', description: 'Governed policy evaluation', kind: 'process', status: 'running' } });
  assert.equal(h.updates[0].update.task.command, undefined);
  h.emit('task.terminated', { info: { ...info, status: 'completed' } });
  assert.deepEqual({ ...h.updates[1].update, task: { ...h.updates[1].update.task } }, { sessionUpdate: 'camellia_background_task', terminated: true,
    task: { id: 'bash-eval', description: 'Governed policy evaluation', kind: 'process', status: 'completed' } });
});

test('Kimi matches turn events even before the prompt launch acknowledgement', { skip: !source }, async () => {
  const h = await fixture(); let acknowledge;
  h.agent.prompt = input => { h.submissions.push(input); return new Promise(resolve => { acknowledge = resolve; }); };
  const result = h.native.driveTurn([]);
  h.emit('turn.started', { promptId: h.submissions[0].promptId, turnId: 8 });
  h.emit('assistant.delta', { turnId: 8, delta: 'Fast reply' });
  h.emit('turn.ended', { turnId: 8, reason: 'completed' });
  assert.equal((await result).stopReason, 'end_turn');
  acknowledge({ turn_id: 8 }); await settle();
  assert.equal(h.updates.length, 1); assert.equal(h.native.driver, undefined);
});

test('Kimi cancels the queued prompt without cancelling unrelated background work', { skip: !source }, async () => {
  for (const beforeAcknowledgement of [false, true]) {
    const h = await fixture(); let acknowledge, accepted = !beforeAcknowledgement;
    if (beforeAcknowledgement) h.agent.prompt = input => { h.submissions.push(input); return new Promise(resolve => { acknowledge = resolve; }); };
    const result = h.native.driveTurn([]);
    const promptId = h.submissions[0].promptId, cancelled = [];
    h.native.camelliaCancelPrompt = id => {
      if (!accepted) throw new Error('Not submitted yet');
      cancelled.push(id); h.emit('prompt.aborted', { promptId: id });
    };
    if (!beforeAcknowledgement) await settle();
    h.native.cancel();
    if (beforeAcknowledgement) { accepted = true; acknowledge(undefined); }
    assert.equal((await result).stopReason, 'cancelled');
    assert.deepEqual(cancelled, [promptId]); assert.equal(h.cancellations.length, 0);
  }
});

test('Kimi settles hook-blocked and aborted prompts without mistaking them for completed work', { skip: !source }, async () => {
  for (const reason of ['blocked', 'aborted', 'failed']) {
    const h = await fixture();
    const result = h.native.driveTurn([]);
    h.emit(reason === 'aborted' ? 'prompt.aborted' : 'prompt.completed', { promptId: h.submissions[0].promptId, reason });
    if (reason === 'failed') await assert.rejects(result, /without launching/);
    else assert.equal((await result).stopReason, reason === 'blocked' ? 'refusal' : 'cancelled');
    assert.equal(h.native.driver, undefined);
  }
});

test('Kimi queue adapter refuses changed runtime contracts', { skip: !source }, () => {
  assert.equal(patchKimiAcpTurns(source.replace('driveLaunch(launch) {', 'driveLaunch(changed) {')), null);
});

test('Kimi queue adapter supports the async ACP server registration contract', { skip: !source }, () => {
  const modern = patchKimiAcpTurns(source.replace('getServer().prompt(ctx.params, ctx.signal)', '(await getServer()).prompt(ctx.params, ctx.signal)'));
  assert.ok(modern.includes('(await getServer()).camelliaPrompt(ctx.params, ctx.signal)'));
});

test('Kimi propagates failed turns through ACP with the provider reason, even after partial output', { skip: !source }, async () => {
  for (const partial of [false, true]) {
    const h = await fixture();
    const result = h.native.driveTurn([]);
    const error = { code: 'provider.api_error', message: "429 You've reached your 5-hour usage limit.",
      details: { statusCode: 429 }, retryable: false };
    const rejected = assert.rejects(result, failure => {
      assert.equal(failure.code, -32603);
      assert.match(failure.message, /429.*5-hour usage limit/);
      assert.equal(failure.data.code, error.code);
      assert.equal(failure.data.statusCode, 429);
      assert.equal(failure.data.retryable, false);
      return true;
    });
    h.emit('turn.started', { promptId: h.submissions[0].promptId, turnId: 2 });
    h.emit('turn.ended', { turnId: 1, reason: 'failed', error: { message: 'Unrelated background error' } });
    if (partial) h.emit('assistant.delta', { turnId: 2, delta: 'Partial reply' });
    h.emit('turn.ended', { turnId: 2, reason: 'failed', error });
    await rejected;
    assert.equal(h.native.driver, undefined);
  }
});

test('Kimi retains authentication, refusal and cancellation outcomes and reports unspecified failures', { skip: !source }, async () => {
  for (const kind of ['auth', 'filtered', 'cancelled', 'failed']) {
    const h = await fixture();
    const result = h.native.driveTurn([]);
    const checked = kind === 'auth' ? assert.rejects(result, { code: -32000, message: 'Sign in again' })
      : kind === 'failed' ? assert.rejects(result, /Kimi turn failed/) : result;
    h.emit('turn.started', { promptId: h.submissions[0].promptId, turnId: 0 });
    h.emit('turn.ended', { turnId: 0, reason: kind === 'cancelled' ? 'cancelled' : 'failed',
      error: kind === 'auth' ? { code: 'provider.auth', message: 'Sign in again' }
        : kind === 'filtered' ? { code: 'provider.filtered', message: 'Filtered' } : undefined });
    const value = await checked;
    if (kind === 'filtered' || kind === 'cancelled') assert.equal(value.stopReason, kind === 'filtered' ? 'refusal' : 'cancelled');
    assert.equal(h.native.driver, undefined);
  }
});
