'use strict';
const { removeTree } = require('./test-fs.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter, once } = require('node:events');
const TOML = require('smol-toml');
const { CodexSession } = require('../src/engines/codex-session');
const { CodexClient, codexSpawnSpec } = require('../src/engines/codex-client');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { createCodex } = require('../src/engines/codex');
const { createEngineSettings } = require('../src/engines/engine-settings');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-codex-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('camellia-codex-test-')); removeTree(root); });
  return root;
}
function transport() {
  const proc = new EventEmitter(); Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const messages = [], requests = new EventEmitter(); let buffer = '';
  const send = message => proc.stdout.write(JSON.stringify(message) + '\n');
  proc.stdin.on('data', data => {
    buffer += data;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); messages.push(message); requests.emit('message', message);
      if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-fixture' } } });
      if (message.method === 'turn/start') send({ id: message.id, result: { turn: { id: 'turn-fixture' } } });
      if (message.method === 'turn/interrupt') {
        send({ id: message.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'interrupted' } } });
      }
    }
  });
  const exit = () => { proc.exitCode = 0; proc.stdout.end(); proc.stderr.end(); proc.emit('close', 0); };
  proc.kill = exit; proc.stdin.on('finish', exit);
  return { proc, send, messages, requests };
}

test('Codex transport initializes before turns, relays approval and question answers, and reports process failure once', async t => {
  const root = temporary(t), wire = transport(), events = [];
  const session = new CodexSession({ gen: 1, settings: { cwd: root, model: 'fixture', connection: 'api', permissionMode: 'default' },
    opts: {}, spec: { permissions: { approvalPolicy: 'never', sandbox: 'workspace-write' } }, spawn: () => wire.proc, log() {}, history: new ClaudeHistory(path.join(root, 'history')),
    onEvent: e => events.push(e), onSessionId() {}, onResult() {} });
  session.start(); session.sendUserMessage('Do this task'); await session.ready;
  // Let turn/start complete before injecting server-originated interactions.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.messages[0].method, 'initialize'); assert.equal(wire.messages[1].method, 'initialized');
  const thread = wire.messages.find(m => m.method === 'thread/start').params;
  assert.equal(thread.approvalPolicy, 'never'); assert.equal(thread.sandbox, 'workspace-write');
  wire.send({ id: 20, method: 'item/commandExecution/requestApproval', params: { threadId: session.sessionId, command: 'fixture command' } });
  assert.equal(session.answerPermission('20', false), true);
  assert.deepEqual(wire.messages.find(m => m.id === 20).result, { decision: 'decline' });
  wire.send({ id: 21, method: 'item/tool/requestUserInput', params: { threadId: session.sessionId, questions: [{ id: 'format', question: 'Output format?' }] } });
  assert.equal(session.answerPermission('21', true, { format: 'CSV' }), true);
  assert.deepEqual(wire.messages.find(m => m.id === 21).result, { answers: { format: { answers: ['CSV'] } } });
  wire.send({ method: 'item/agentMessage/delta', params: { threadId: session.sessionId, itemId: 'reply', delta: 'Partial answer' } });
  const live = await session.liveState(); assert.equal(live.prompt, 'Do this task');
  assert.equal(live.events.filter(e => e.type === 'gui:permission').length, 0, 'Answered prompts must not reappear after navigation');
  wire.proc.emit('close', 1); wire.proc.emit('close', 1);
  assert.equal(events.filter(e => e.type === 'result').length, 1); assert.equal(events.at(-1).is_error, true);
  assert.equal(session.running, false);
});

test('Codex publishes live context usage with cache accounting and the native context limit', async t => {
  const root = temporary(t), wire = transport(), events = [];
  const session = new CodexSession({ gen: 1, settings: { cwd: root, model: 'fixture', connection: 'api' }, opts: {}, spec: {},
    spawn: () => wire.proc, log() {}, history: new ClaudeHistory(path.join(root, 'history')), onEvent: event => events.push(event), onSessionId() {}, onResult() {} });
  session.start(); session.sendUserMessage('Report usage'); await session.ready;
  await new Promise(resolve => setImmediate(resolve));
  const tokenUsage = { last: { inputTokens: 45000, cachedInputTokens: 5000, outputTokens: 100 }, modelContextWindow: 128000 };
  wire.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'unrelated', tokenUsage } });
  assert.equal(events.some(event => event.type === 'gui:usage'), false);
  wire.send({ method: 'thread/tokenUsage/updated', params: { threadId: session.sessionId, tokenUsage } });
  const usage = { input_tokens: 40000, cache_read_input_tokens: 5000, output_tokens: 100, context_window: 128000 };
  assert.deepEqual(events.at(-1).usage, usage);
  assert.equal(events.at(-1).type, 'gui:usage');
  assert.deepEqual((await session.liveState()).events.at(-1).usage, usage);
  wire.send({ method: 'turn/completed', params: { threadId: session.sessionId, turn: { status: 'completed' } } });
  assert.deepEqual(events.at(-1).usage, usage);
  await session.shutdown();
});

test('cancel during Codex initialization stops before sending a turn and closes the process', async t => {
  const root = temporary(t), wire = transport(), events = [];
  const session = new CodexSession({ gen: 2, settings: { cwd: root, model: 'fixture', connection: 'api' }, opts: {}, spec: {},
    spawn: () => wire.proc, log() {}, history: new ClaudeHistory(path.join(root, 'history')), onEvent: e => events.push(e), onSessionId() {}, onResult() {} });
  session.start(); session.sendUserMessage('Cancel me'); session.interrupt(); await session.ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.messages.some(m => m.method === 'turn/start'), false);
  assert.equal(events.at(-1).subtype, 'stopped'); await session.shutdown();
});

test('Codex keeps configuration, auth storage and remembered connections inside Camellia', async t => {
  const root = temporary(t), home = path.join(root, 'codex'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ model_provider: 'personal', cli_auth_credentials_store: 'keyring',
    mcp_servers: { fixture: { command: 'fixture' } }, model_reasoning_effort: 'high' }));
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'Write clear reports.');
  const native = { file: path.join(root, 'native/bin/codex') };
  const env = { PATH: '/fixture', CODEX_HOME: '/personal', OPENAI_API_KEY: 'personal-secret', OPENAI_BASE_URL: 'https://personal.invalid', CAMELLIA_CODEX_API_KEY: 'old' };
  const api = codexSpawnSpec({ runtime: native, home: path.join(home, 'api'), configHome: home, connection: 'api', route: { baseUrl: 'http://127.0.0.1:8788' }, env });
  const subscription = codexSpawnSpec({ runtime: native, home: path.join(home, 'subscription'), configHome: home, env });
  assert.equal(subscription.env.OPENAI_API_KEY, undefined); assert.equal(subscription.env.OPENAI_BASE_URL, undefined);
  assert.equal(subscription.env.CAMELLIA_CODEX_API_KEY, undefined); assert.equal(env.CODEX_HOME, '/personal');
  assert.equal(api.env.CAMELLIA_CODEX_API_KEY, 'proxy-managed'); assert.equal(subscription.env.CODEX_HOME, path.join(home, 'subscription'));
  const config = TOML.parse(fs.readFileSync(path.join(home, 'subscription/config.toml'), 'utf8'));
  assert.equal(config.cli_auth_credentials_store, 'file'); assert.equal(config.model_provider, 'openai');
  assert.equal(config.mcp_servers.fixture.command, 'fixture'); assert.equal(fs.readFileSync(path.join(home, 'subscription/AGENTS.md'), 'utf8'), 'Write clear reports.');
  assert.equal(TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).model_provider, 'personal', 'Generated connection configuration cannot overwrite the editable document');
  let desktop = { codex: { connection: 'api', apiModel: 'api-model', subscriptionModel: 'account-model' }, codexSessionConnections: { nativeThread: 'subscription' } };
  const engine = createCodex({ dataDir: root, loadConfig: () => desktop, saveConfig: patch => { desktop = { ...desktop, ...patch }; }, runtimes: () => ({ locate: () => null }) });
  assert.equal(engine.settings('nativeThread').connection, 'subscription'); assert.equal(engine.settings('nativeThread').model, 'account-model');
  engine.saveSettings({ sessionId: 'nativeThread', model: 'another-account-model' });
  assert.equal(engine.settings().model, 'api-model'); assert.equal(engine.settings('nativeThread').model, 'another-account-model');
  engine.saveSettings({ sessionId: 'nativeThread', connection: 'api', model: 'picked-api-model' });
  assert.equal(engine.settings().connection, 'api'); assert.equal(engine.settings().apiModel, 'picked-api-model');
  assert.equal(engine.settings().subscriptionModel, 'another-account-model');
  assert.equal(engine.settings('nativeThread').connection, 'subscription');
  const settings = createEngineSettings({ home: root, codexHome: home, getDesktop: () => engine.settings(), saveDesktop: (_, value) => engine.saveSettings(value) });
  const state = settings.get('codex'); assert.equal(state.scope, 'app'); assert.ok(!state.files[0].text.includes('personal'));
  settings.save('codex', { files: state.files, common: { model_reasoning_effort: 'medium', approval_policy: 'never', sandbox_mode: 'workspace-write' }, desktop: {} });
  assert.equal(engine.settings().thinkingBudget, 'medium'); assert.ok(fs.existsSync(path.join(home, 'config.toml.workbench.bak')));
  assert.equal(engine.settings().permissionMode, 'default');
  const updated = codexSpawnSpec({ runtime: native, home: path.join(home, 'subscription'), configHome: home, env });
  assert.deepEqual(updated.permissions, { approvalPolicy: 'never', sandbox: 'workspace-write' });
});

test('Codex API metadata adds native patch support without overriding known models, reasoning, or user catalogs', t => {
  const root = temporary(t), home = path.join(root, 'profile');
  const options = { runtime: { file: path.join(root, 'native/bin/codex') }, home, connection: 'api',
    model: 'kimi-k3', route: { baseUrl: 'http://127.0.0.1:8788' } };
  codexSpawnSpec(options);
  const read = () => TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  const first = read(), catalog = JSON.parse(fs.readFileSync(first.model_catalog_json, 'utf8'));
  const model = catalog.models.find(m => m.slug === 'kimi-k3');
  assert.equal(model.apply_patch_tool_type, 'freeform');
  assert.equal(model.default_reasoning_level, null); assert.equal(first.model_reasoning_effort, undefined);
  assert.equal(model.model_messages.instructions_template, fs.readFileSync(path.join(__dirname, '../src/engines/codex-metadata/fallback-prompt.md'), 'utf8'));
  codexSpawnSpec({ ...options, contextWindow: 65536 });
  const tuned = JSON.parse(fs.readFileSync(read().model_catalog_json, 'utf8'));
  assert.equal(tuned.models.find(m => m.slug === 'kimi-k3').context_window, 65536);
  assert.equal(tuned.models.find(m => m.slug === 'kimi-k3').max_context_window, 65536);
  codexSpawnSpec({ ...options, model: 'deepseek-v4.1-flash' });
  const next = JSON.parse(fs.readFileSync(read().model_catalog_json, 'utf8'));
  assert.ok(next.models.some(m => m.slug === 'deepseek-v4.1-flash'));
  assert.ok(!next.models.some(m => m.slug === 'kimi-k3'));
  for (const native of ['gpt-5.5', 'openai/gpt-5.5-2026']) {
    codexSpawnSpec({ ...options, model: native }); assert.equal(read().model_catalog_json, undefined);
  }
  codexSpawnSpec(options);
  codexSpawnSpec({ ...options, connection: 'subscription' }); assert.equal(read().model_catalog_json, undefined);
  const own = path.join(root, 'user-models.json');
  fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ model_catalog_json: own, model_reasoning_effort: 'high' }));
  codexSpawnSpec(options); assert.equal(read().model_catalog_json, own); assert.equal(read().model_reasoning_effort, 'high');
  assert.equal(require('../runtimes/codex/package.json').dependencies['@openai/codex'], '0.154.0', 'Review native metadata when upgrading Codex');
});
