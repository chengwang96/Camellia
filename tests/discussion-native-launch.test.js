'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCodex } = require('../src/engines/codex');
const { createAntigravity } = require('../src/engines/antigravity');
const { createDiscussionLaunch, getDiscussionLaunch, revokeDiscussionLaunch } = require('../src/engines/discussions/native-launch');
const { installDiscussionGuards } = require('../src/engines/discussions/native-access');
const { DiscussionManager } = require('../src/engines/discussions/manager');
const { removeTree } = require('./test-fs.cjs');

function transport(engine, nativeId) {
  const proc = new EventEmitter(), messages = [];
  Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  let buffer = '';
  const respond = value => proc.stdout.write(JSON.stringify(value) + '\n');
  proc.stdin.on('data', data => {
    buffer += data;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(message);
      if (message.id === undefined) continue;
      let result = {};
      if (message.method === 'initialize') result = engine === 'codex' ? { userAgent: 'fixture' } : { agentCapabilities: {} };
      if (['thread/start', 'thread/resume'].includes(message.method)) result = { thread: { id: message.params.threadId || nativeId } };
      if (['session/new', 'session/resume'].includes(message.method)) result = { sessionId: message.params.sessionId || nativeId };
      if (message.method === 'session/set_config_option') result = { configOptions: [] };
      respond({ id: message.id, result });
    }
  });
  const close = () => {
    if (proc.exitCode !== null) return;
    proc.exitCode = 0; proc.stdout.end(); proc.stderr.end(); proc.emit('exit', 0); proc.emit('close', 0);
  };
  proc.kill = close; proc.stdin.on('finish', close);
  return { proc, messages };
}

function setup(t, engine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-launch-'));
  const home = path.join(root, engine); fs.mkdirSync(home);
  const state = { codex: { connection: 'api', apiModel: 'ordinary-api', subscriptionModel: 'ordinary-subscription',
    proxyUrl: 'http://ordinary.invalid', permissionMode: 'full', thinkingBudget: 'high', contextWindow: 999999 },
  antigravity: { connection: 'api', model: 'ordinary-api', apiModel: 'ordinary-api', subscriptionModel: 'ordinary-subscription',
    proxyUrl: 'http://ordinary.invalid', permissionMode: 'full', thinkingBudget: 'high' },
  subscriptionAccounts: { codex: [{ id: 'default' }, { id: 'account-1' }] }, subscriptionActive: { codex: 'account-1' } };
  if (engine === 'codex') {
    fs.writeFileSync(path.join(home, 'account-state.json'), JSON.stringify({ account: { email: 'fixture@example.invalid' },
      models: [{ id: 'fixture-model' }], rateLimits: { primary: { usedPercent: 100 } } }));
    const backup = path.join(root, 'subscription-accounts', 'codex', 'account-1'); fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'account-state.json'), JSON.stringify({ account: { email: 'backup@example.invalid' },
      models: [{ id: 'fixture-model' }], rateLimits: { primary: { usedPercent: 0 } } }));
  } else fs.writeFileSync(path.join(home, 'google-account.json'), JSON.stringify({
    models: [{ id: 'fixture-model', name: 'Fixture' }], verifiedAt: Date.now(), error: '', awaitingVerification: false }));
  const calls = [], specs = [], tokens = [];
  const unreachable = () => assert.fail('Scoped launch must not consult an ordinary spawn default');
  const options = { dataDir: root, loadConfig: () => state, saveConfig: patch => Object.assign(state, patch),
    getModels: () => ['fixture-model'], getRoute: unreachable, getContextWindow: unreachable,
    runtimes: () => ({ locate: () => ({ file: path.join(root, 'unused-native.exe') }) }),
    environment: unreachable, python: unreachable, node: unreachable,
    cliSettingsFile: path.join(root, 'no-global-cli-settings.json'), onEvent() {}, onGoal() {}, log() {} };
  const driver = engine === 'codex' ? createCodex(options) : createAntigravity(options);
  installDiscussionGuards({ dataDir: root, drivers: { [engine]: driver } });
  t.after(async () => { await driver.shutdown(); removeTree(root); });
  function prepare(connection = 'subscription', extra = {}) {
    const settings = { model: 'fixture-model', connection, permissionMode: 'plan', thinkingBudget: '',
      proxyUrl: '', contextWindow: 12000, ...(connection === 'subscription' ? { subscriptionId: 'default' } : {}), ...extra.settings };
    const identity = { runtimeId: randomUUID() }, nativeId = extra.nativeId || null;
    const launch = {
      buildSpec(context) {
        specs.push(context);
        return { exe: process.execPath, args: ['fixture-only'], cwd: root, env: { SCOPED_TEST: 'true' }, noModes: true };
      },
      spawn(exe, args, opts) {
        const wire = transport(engine, (engine === 'antigravity' && connection === 'subscription' ? 'agy-' : 'native-') + randomUUID());
        calls.push({ exe, args, opts, wire }); return wire.proc;
      }, ...extra.launch,
    };
    const token = createDiscussionLaunch({ engine, identity, cwd: root, nativeId, settings, launch }); tokens.push(token);
    return { conversationId: identity.runtimeId, cwd: root, sessionId: nativeId, settings, discussionLaunch: token };
  }
  async function open(opts) {
    const session = driver.ensureSession(opts); await (session.ready ||= session.open()); return session;
  }
  async function release(opts) { await driver.sessions.release(opts); revokeDiscussionLaunch(opts.discussionLaunch); }
  return { root, home, state, driver, calls, specs, tokens, prepare, open, release };
}

for (const engine of ['codex', 'antigravity']) for (const connection of ['api', 'subscription']) {
  test(`${engine} ${connection} discussion launch avoids ordinary settings, routing defaults and global selection writes`, async t => {
    const h = setup(t, engine);
    h.state[engine].connection = connection === 'api' ? 'subscription' : 'api';
    const before = structuredClone(h.state[engine]), activeAccount = structuredClone(h.state.subscriptionActive);
    const opts = h.prepare(connection), session = await h.open(opts);
    assert.deepEqual(h.state[engine], before); assert.deepEqual(h.state.subscriptionActive, activeAccount);
    assert.equal(session.settings.model, 'fixture-model'); assert.equal(session.settings.permissionMode, 'plan');
    assert.equal(session.settings.proxyUrl, ''); assert.equal(session.settings.contextWindow, 12000);
    assert.deepEqual(h.calls[0].opts.env, { SCOPED_TEST: 'true' }); assert.equal(h.calls[0].exe, process.execPath);
    assert.equal(h.specs[0].settings.connection, connection); assert.equal(h.specs[0].runtimeId, opts.conversationId);
    if (connection === 'subscription') assert.equal(session.settings.subscriptionId, 'default');
    if (engine === 'codex') {
      assert.equal(h.state.codexSessionConnections[session.sessionId], connection);
      if (connection === 'subscription') assert.equal(h.state.codexSessionAccounts[session.sessionId], 'default');
      assert.equal(fs.existsSync(path.join(h.home, 'api', 'conversations')), false);
    }
    await h.release(opts);
  });
}

test('native launch tokens cannot be forged, serialized, moved to another runtime or reused after release', async t => {
  const h = setup(t, 'codex'), opts = h.prepare('api');
  for (const patch of [{ discussionLaunch: {} }, { discussionLaunch: structuredClone(opts.discussionLaunch) },
    { conversationId: randomUUID() }, { sessionId: 'other' }, { cwd: os.tmpdir() },
    { settings: { ...opts.settings, permissionMode: 'full' } }, { goalBridge: {} }, { fork: true }]) {
    assert.throws(() => h.driver.ensureSession({ ...opts, ...patch }), /Invalid.*discussion launch/);
  }
  assert.throws(() => getDiscussionLaunch(opts, 'antigravity'), /Invalid/);
  assert.equal(h.calls.length, 0);
  await h.open(opts); await h.release(opts);
  assert.throws(() => h.driver.ensureSession(opts), /expired discussion launch/);
  assert.equal(h.calls.length, 1);
});

for (const engine of ['codex', 'antigravity']) {
  test(`${engine} ordinary continuation remains excluded after the discussion pool slot is released`, async t => {
    const h = setup(t, engine), opts = h.prepare('api'), session = await h.open(opts);
    const manager = new DiscussionManager({ dir: path.join(h.root, 'discussions') }), group = manager.create({ cwd: h.root });
    manager.addMember(group.id, { name: 'Member', engine, connection: 'api', model: 'fixture-model' });
    manager.store.update(group.id, state => Object.assign(state.participants[0].session,
      { runtimeId: opts.conversationId, nativeId: session.sessionId }));
    await h.release(opts);
    assert.equal(h.driver.sessions.sessions.size, 0);
    for (const request of [{ sessionId: session.sessionId }, { conversationId: opts.conversationId },
      { conversationId: randomUUID(), sessionId: session.sessionId, fork: true }]) {
      assert.throws(() => h.driver.ensureSession({ cwd: h.root, ...request }), /owned by a discussion/);
    }
    assert.equal(h.calls.length, 1);
  });

  test(`${engine} ordinary, cleanup and global shutdown paths retain discussion ownership until the owner releases it`, async t => {
    const h = setup(t, engine), opts = h.prepare(), session = await h.open(opts);
    assert.throws(() => h.driver.ensureSession({ conversationId: opts.conversationId, cwd: h.root }), /owned by a discussion/);
    assert.throws(() => h.driver.ensureSession({ sessionId: session.sessionId, cwd: h.root }), /owned by a discussion/);
    assert.throws(() => h.driver.ensureSession({ conversationId: randomUUID(), sessionId: session.sessionId, cwd: h.root }), /owned by a discussion/);
    await assert.rejects(h.driver.sessions.release({ conversationId: opts.conversationId }), /released by their owner/);
    await h.driver.shutdown();
    assert.equal(session.dead, true); assert.equal(h.driver.sessions.get(opts), session);
    assert.throws(() => h.driver.ensureSession({ conversationId: opts.conversationId, cwd: h.root }), /owned by a discussion/);
    await h.release(opts); assert.equal(h.driver.sessions.get(opts), null);
    assert.equal(h.calls.length, 1);
  });
}

test('Codex discussion continuation requires the recorded connection and account and never switches accounts for quota', async t => {
  const h = setup(t, 'codex'), opts = h.prepare(), session = await h.open(opts), nativeId = session.sessionId;
  assert.equal(session.settings.subscriptionId, 'default'); await h.release(opts);
  for (const request of [h.prepare('api', { nativeId }),
    h.prepare('subscription', { nativeId, settings: { subscriptionId: 'account-1' } }),
    h.prepare('subscription', { settings: { subscriptionId: 'deleted-account' } })]) {
    assert.throws(() => h.driver.ensureSession(request), /not verified/);
  }
  assert.equal(h.calls.length, 1);
  const next = h.prepare('subscription', { nativeId }); await h.open(next);
  assert.ok(h.calls[1].wire.messages.some(message => message.method === 'thread/resume'));
  assert.equal(h.specs[1].settings.subscriptionId, 'default'); await h.release(next);
});

test('Antigravity discussions require the one verified subscription account and preserve the native connection', async t => {
  const h = setup(t, 'antigravity');
  assert.throws(() => h.driver.ensureSession(h.prepare('subscription', { settings: { subscriptionId: 'account-1' } })), /not verified/);
  assert.throws(() => h.driver.ensureSession(h.prepare('api', { nativeId: 'agy-existing' })), /connection is not verified/);
  assert.throws(() => h.driver.ensureSession(h.prepare('subscription', { nativeId: 'api-existing' })), /connection is not verified/);
  fs.writeFileSync(path.join(h.home, 'google-account.json'), JSON.stringify({ models: [{ id: 'fixture-model' }], awaitingVerification: true }));
  assert.throws(() => h.driver.ensureSession(h.prepare()), /account is not verified/);
  assert.equal(h.calls.length, 0); assert.equal(h.specs.length, 0);
});

test('incomplete policy settings and invalid or asynchronous spawn specifications fail before any process is created', async t => {
  const h = setup(t, 'codex');
  for (const key of ['permissionMode', 'thinkingBudget', 'proxyUrl', 'contextWindow']) {
    assert.throws(() => h.prepare('api', { settings: { [key]: undefined } }), /explicit settings/);
  }
  assert.throws(() => h.prepare('api', { launch: { spawn: null } }), /scoped process launcher/);
  for (const bad of [null, {}, { exe: 'relative', args: [], cwd: h.root, env: {} },
    { exe: process.execPath, args: [], cwd: os.tmpdir(), env: {} },
    { exe: process.execPath, args: [], cwd: h.root },
    { exe: process.execPath, args: [null], cwd: h.root, env: {} }]) {
    assert.throws(() => h.driver.ensureSession(h.prepare('api', { launch: { buildSpec: () => bad } })), /Invalid discussion spawn/);
  }
  assert.throws(() => h.driver.ensureSession(h.prepare('api', { launch: { buildSpec: async () => { throw new Error('late rejection'); } } })), /synchronous/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0); assert.equal(h.driver.sessions.sessions.size, 0);
});
