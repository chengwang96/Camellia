'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchKimiSteer, prepareKimiRuntime } = require('../src/engines/kimi-steer');
const { patchKimiHistory } = require('../src/engines/kimi-native-history');
const { KimiSession } = require('../src/engines/kimi-session');
const { removeTree } = require('./test-fs.cjs');

const source = `
/*
IAgentPromptChannel = createDecorator("agentPromptService")
async submitSteer(payload)
activeTurnId: this.active?.id
*/
const server = testServer;
function createAcpAgentApp(getServer) {
  return agent({ name: "kimi-code-acp" });
}
class NativeSession {
  async preparePromptContent(blocks) {}
}
function runNative() {
\tlet closePromise;
\tconst close = async () => {};
}
`;

async function fixture() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const patched = patchKimiSteer(source);
  assert.ok(patched);
  const calls = { prepared: [], submitted: [] };
  const driver = { turnId: 7, settled: false };
  const acp = { driver, preparePromptContent: async blocks => {
    calls.prepared.push(blocks);
    return [{ type: 'text', text: blocks[0].text }, { type: 'image', attachment: 'native-image' }];
  } };
  const server = { ensureAuthed: async () => {}, getSession: () => acp };
  const loop = {
    snapshot: () => ({ state: 'running', activeTurnId: 7, activePromptId: 'original-prompt' }),
    submit: (...args) => { calls.submitted.push(args); return { id: 'steer-prompt' }; },
    promptHandle: () => ({ state: 'pending' }),
  };
  const agent = { accessor: { get: () => loop } };
  const native = { accessor: { get: () => ({ handleOf: () => agent }) } };
  const RequestError = { invalidParams: (_params, text) => new Error(text) };
  const api = await new AsyncFunction('testServer', 'RequestError$1', 'core', 'getLiveSessionById',
    'IAgentLifecycleService', 'IAgentLoopService', 'IAgentPromptChannel', patched
      + '\nrunNative(); return { steer: camelliaSteer };')(
    server, RequestError, { accessor: {} }, () => native, 'lifecycle', 'loop', 'prompt');
  return { api, server, acp, driver, loop, calls };
}

test('Kimi steer bridge converts attachments and accepts only the current ACP and native turn', async () => {
  const { api, server, driver, loop, calls } = await fixture();
  delete server.ensureAuthed;
  const params = { sessionId: 'session', prompt: [
    { type: 'text', text: 'Correction' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
  ] };
  assert.deepEqual(await api.steer(server, params), { turnId: 7, promptId: 'steer-prompt' });
  assert.deepEqual(calls.prepared, [params.prompt]);
  assert.deepEqual(calls.submitted, [[{
    message: { role: 'user', content: [
      { type: 'text', text: 'Correction' }, { type: 'image', attachment: 'native-image' },
    ] },
    meta: { origin: { kind: 'user' }, tracked: true },
  }, { steerIfActive: true }]]);

  driver.turnId = 8;
  await assert.rejects(api.steer(server, params), /active turn changed|not ready/);
  driver.turnId = 7;
  loop.snapshot = () => ({ state: 'running', activeTurnId: 9, activePromptId: 'other-prompt' });
  await assert.rejects(api.steer(server, params), /active turn changed/);
  loop.snapshot = () => ({ state: 'running', activeTurnId: 7, activePromptId: 'original-prompt' });
  loop.promptHandle = () => ({ state: 'failed' });
  await assert.rejects(api.steer(server, params), /did not accept/);
  assert.equal(calls.prepared.length, 4);
});

test('Kimi steer bridge refuses an unfinished or cancelled prompt without invoking native steering', async () => {
  const { api, server, driver, acp, calls } = await fixture();
  const params = { sessionId: 'session', prompt: [{ type: 'text', text: 'Correction' }] };
  driver.settled = true;
  await assert.rejects(api.steer(server, params), /not ready|already finished/);
  driver.settled = false;
  acp.preparePromptContent = async () => undefined;
  await assert.rejects(api.steer(server, params), /cancelled/);
  assert.equal(calls.submitted.length, 0);
});

test('KimiSession sends inline images and appends portable history only after native confirmation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-steer-session-'));
  t.after(() => removeTree(root));
  const image = path.join(root, 'reference.png'); fs.writeFileSync(image, 'image-bytes');
  const calls = [], history = [];
  const session = Object.assign(Object.create(KimiSession.prototype), {
    spec: { nativeSteer: true }, running: true, dead: false, cancelled: false,
    sessionId: 'kimi-session', promptCapabilities: { image: true },
    request: async (method, params, timeout) => {
      assert.equal(history.length, 0);
      calls.push({ method, params, timeout });
      return { turnId: 12, promptId: 'accepted-prompt' };
    },
    appendHistory: (...args) => history.push(args),
  });
  const attachments = [{ isImage: true, path: image }];
  assert.deepEqual(await session.steerUserMessage('Use this reference', attachments), { turnId: 12, promptId: 'accepted-prompt' });
  assert.equal(calls[0].method, 'session/camellia_steer');
  assert.equal(calls[0].timeout, 0);
  assert.deepEqual(calls[0].params, { sessionId: 'kimi-session', prompt: [
    { type: 'text', text: 'Use this reference' },
    { type: 'image', mimeType: 'image/png', data: Buffer.from('image-bytes').toString('base64') },
  ] });
  assert.deepEqual(history, [['user', 'Use this reference']]);

  session.request = async () => { throw new Error('Native rejection'); };
  await assert.rejects(session.steerUserMessage('Must not appear', attachments), /Native rejection/);
  assert.equal(history.length, 1);
  session.request = async () => ({ turnId: 13 });
  session.promptCapabilities.image = false;
  await assert.rejects(session.steerUserMessage('No image support', attachments), /did not advertise/);
  session.running = false;
  await assert.rejects(session.steerUserMessage('Too late', []), /already finished/);
  assert.equal(history.length, 1);
});

test('unknown Kimi native layouts do not receive a steer bridge', t => {
  assert.equal(patchKimiSteer(source.replace('async submitSteer(payload)', 'async changedSteer(payload)')), null);
  assert.equal(patchKimiSteer(source + '\n// session/camellia_steer\n'), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-unknown-runtime-'));
  t.after(() => removeTree(root));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@moonshot-ai/kimi-code', version: '2.5.0' }));
  const runtime = path.join(root, 'dist', 'main.mjs'); fs.writeFileSync(runtime, source);
  assert.deepEqual(prepareKimiRuntime(runtime), { file: runtime, nativeHistory: false, nativeSteer: false });
});

const pinnedRuntime = path.resolve(process.env.CAMELLIA_TEST_KIMI_RUNTIME
  || path.join(__dirname, '../runtimes/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'));
test('the selected Kimi runtime supports independent and composed steer bridges', { skip: !fs.existsSync(pinnedRuntime) }, () => {
  const native = fs.readFileSync(pinnedRuntime, 'utf8');
  assert.ok(patchKimiSteer(native));
  const history = patchKimiHistory(native);
  assert.ok(history);
  const combined = patchKimiSteer(history);
  assert.ok(combined.includes('session/camellia_steer'));
  assert.ok(combined.includes('session/camellia_fork_undo'));
});

test('verified Kimi upgrades load queue, error, history and steer adapters through runtime preparation', { skip: !fs.existsSync(pinnedRuntime) }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-verified-runtime-'));
  t.after(() => removeTree(root));
  const native = fs.readFileSync(pinnedRuntime, 'utf8');
  for (const version of ['2.4.0', '2.4.1', '2.5.1', '2.5.2']) {
    const directory = path.join(root, version);
    fs.mkdirSync(path.join(directory, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@moonshot-ai/kimi-code', version }));
    const runtime = path.join(directory, 'dist/main.mjs');
    fs.writeFileSync(runtime, native);
    const prepared = prepareKimiRuntime(runtime);
    assert.equal(prepared.nativeHistory, true, `Kimi ${version} must retain the history and queued-prompt adapter`);
    assert.equal(prepared.nativeSteer, true, `Kimi ${version} must retain immediate instructions`);
    assert.equal(prepared.nativeBackgroundTasks, true, `Kimi ${version} must expose native background task controls`);
    assert.notEqual(prepared.file, runtime);
    const patched = fs.readFileSync(prepared.file, 'utf8');
    assert.match(patched, /camelliaQueuedPrompt/);
    assert.match(patched, /Kimi turn failed/);
    assert.match(patched, /session\/camellia_steer/);
    assert.match(patched, /session\/camellia_fork_undo/);
    assert.equal(fs.readFileSync(runtime, 'utf8'), native);
  }
});
