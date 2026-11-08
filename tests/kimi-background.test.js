'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { patchKimiBackground } = require('../src/engines/kimi-background');
const { KimiSession } = require('../src/engines/kimi-session');

test('Kimi background control only calls the native stop API for the requested loaded session', async () => {
  const source = 'const native = { stopTask: async (input) => {} };\nfunction createAcpAgentApp(getServer) { return agent({ name: "kimi-code-acp" }); }';
  const patched = patchKimiBackground(source);
  assert.ok(patched.includes('session/camellia_stop_background'));
  const start = patched.indexOf('function camelliaBackgroundParams');
  const end = patched.indexOf('function createAcpAgentApp');
  const api = vm.runInNewContext(patched.slice(start, end) + '\n({ validate: camelliaBackgroundParams, stop: camelliaStopBackground })', {
    RequestError$1: { invalidParams: (_params, message) => new Error(message) },
  });
  for (const bad of [null, {}, { sessionId: 'one', taskIds: [] }, { sessionId: 'one', taskIds: [1] }])
    assert.throws(() => api.validate(bad), /required/);
  const calls = [], server = { getSession: id => id === 'one', klient: { session: id => {
    assert.equal(id, 'one');
    return { agent: name => { assert.equal(name, 'main'); return { stopTask: async ({ taskId, reason }) => { calls.push({ taskId, reason }); } }; } };
  } } };
  await api.stop(server, api.validate({ sessionId: 'one', taskIds: ['process', 'agent'] }));
  assert.deepEqual(calls, [{ taskId: 'process', reason: 'User initiated stop' }, { taskId: 'agent', reason: 'User initiated stop' }]);
  await assert.rejects(api.stop(server, { sessionId: 'two', taskIds: ['another-task'] }), /must be loaded/);
  assert.equal(calls.length, 2);
  assert.equal(patchKimiBackground(source.replace('stopTask: async', 'changed: async')), null);
});

test('Kimi background stops keep the parent and task state until native termination, and propagate failures', async () => {
  const calls = [], tasks = new Map([['first', {}], ['new-task', {}]]);
  const session = Object.assign(Object.create(KimiSession.prototype), { spec: { nativeBackgroundTasks: true },
    dead: false, running: true, sessionId: 'one', backgroundTasks: tasks,
    request: async (method, params) => { calls.push({ method, params }); },
  });
  await session.stopBackgroundTasks(['first', 'already-ended']);
  assert.deepEqual(calls, [{ method: 'session/camellia_stop_background', params: { sessionId: 'one', taskIds: ['first'] } }]);
  assert.equal(session.running, true); assert.equal(tasks.size, 2);
  session.request = async () => { throw new Error('Native task could not stop'); };
  await assert.rejects(session.stopBackgroundTasks(['first']), /could not stop/);
  assert.equal(tasks.size, 2);
  session.spec.nativeBackgroundTasks = false;
  await assert.rejects(session.stopBackgroundTasks(['first']), /unavailable/);
});
