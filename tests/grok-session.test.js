'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('smol-toml');
const { GrokSession, grokSpawnSpec, grokConnectionSettings, updateGrokConnectionSettings } = require('../src/engines/grok-session');
const { removeTree } = require('./test-fs.cjs');

test('Grok API spawn uses the shared OpenAI-compatible route and an isolated home', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-grok-spec-'));
  t.after(() => removeTree(home));
  const spec = grokSpawnSpec({ runtime: '/fixture/grok', home, model: 'model-exact', route: { baseUrl: 'http://127.0.0.1:17890', authToken: 'proxy-managed' },
    contextWindow: 200000, env: { XAI_API_KEY: 'parent-secret', PATH: 'fixture' } });
  assert.deepEqual(spec.args, ['--model', 'camellia', '--no-auto-update', 'agent', 'stdio']);
  assert.equal(spec.env.XAI_API_KEY, undefined);
  assert.equal(spec.env.GROK_HOME, process.platform === 'win32' ? fs.realpathSync.native(home) : home);
  const config = TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  assert.equal(config.models.default, 'camellia');
  assert.equal(config.models.session_summary, 'camellia');
  assert.equal(config.model.camellia.model, 'model-exact');
  assert.equal(config.model.camellia.base_url, 'http://127.0.0.1:17890/v1');
  assert.equal(config.model.camellia.api_backend, 'messages');
  assert.equal(config.model.camellia.context_window, 200000);
  assert.equal(config.model.camellia.vision, true);
  assert.equal(spec.modelValue, 'camellia');
});

test('Grok subscription sessions apply native MCP settings without adding an API route', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-grok-subscription-'));
  t.after(() => removeTree(home));
  fs.writeFileSync(path.join(home, 'config.toml'), 'theme = "dark"\n');
  const mcp = { fixture: { command: 'node', args: ['fixture.js'] } };
  const spec = grokSpawnSpec({ home, model: 'grok-4.7', connection: 'subscription', route: null,
    config: { mcp_servers: mcp }, proxyUrl: 'http://127.0.0.1:7897', env: { XAI_API_KEY: 'parent-secret' } });
  const config = TOML.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.equal(config.mcp_servers.fixture.command, 'node');
  assert.deepEqual(config.mcp_servers.fixture.args, ['fixture.js']);
  assert.equal(config.model?.camellia, undefined);
  assert.equal(spec.authMethod, 'cached_token');
  assert.equal(spec.modelValue, 'grok-4.7');
  assert.equal(spec.env.XAI_API_KEY, undefined);
  assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:7897/');
});

test('Grok sessions honor the central network transport over legacy proxy settings', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-grok-network-'));
  t.after(() => removeTree(home));
  const { networkEnvironment } = require('../src/main/network-settings');
  const route = { baseUrl: 'http://127.0.0.1:17890', authToken: 'proxy-managed' };
  const automatic = networkEnvironment({ https_proxy: 'http://old.invalid:1234' }, {
    mode: 'auto', url: 'http://127.0.0.1:54321/', subscriptionProxy: 'http://127.0.0.1:7890/' });
  const api = grokSpawnSpec({ home: path.join(home, 'api'), model: 'model-exact', route, env: automatic });
  assert.equal(api.env.HTTPS_PROXY, 'http://127.0.0.1:54321/');
  const subscription = grokSpawnSpec({ home: path.join(home, 'subscription'), model: 'grok-4.7', connection: 'subscription',
    route: null, env: automatic, proxyUrl: 'http://legacy.invalid:7897' });
  assert.equal(subscription.env.HTTP_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(subscription.env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(subscription.env.NO_PROXY, 'localhost,127.0.0.1,::1');
  const system = networkEnvironment({}, { mode: 'system', url: 'http://127.0.0.1:7890/' });
  const systemSubscription = grokSpawnSpec({ home: path.join(home, 'system'), model: 'grok-4.7', connection: 'subscription',
    route: null, env: system, proxyUrl: '' });
  assert.equal(systemSubscription.env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(systemSubscription.env.NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('Grok opens and resumes native sessions with authentication, model, effort and permission', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-grok-session-'));
  t.after(() => removeTree(home));
  const sessionId = '00000000-0000-4000-8000-000000000001', calls = [];
  const session = new GrokSession({ gen: 1, settings: { cwd: home, model: 'grok-4.7', thinkingBudget: 'high', permissionMode: 'full' },
    opts: { sessionId }, exe: '/fixture/grok', spec: { args: [], env: {}, authMethod: 'cached_token' },
    spawn: () => assert.fail('no process expected'), log() {}, history: { root: home, find: () => null },
    onEvent() {}, onSessionId() {}, onResult() {} });
  session.starting = Promise.resolve();
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'session/load') return { sessionId, configOptions: [] };
    return {};
  };
  await session.open();
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'authenticate', 'session/load', 'session/set_model', 'session/set_config_option', 'session/set_mode']);
  assert.equal(calls[1].params.methodId, 'cached_token');
  assert.deepEqual(calls[3].params, { sessionId, modelId: 'grok-4.7' });
  assert.deepEqual(calls[4].params, { sessionId, configId: 'reasoning_effort', value: 'high' });
  assert.deepEqual(calls[5].params, { sessionId, modeId: 'bypassPermissions' });
});

test('Grok loads the source before forking and keeps the returned child session ID', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-grok-fork-'));
  t.after(() => removeTree(home));
  const sourceId = '00000000-0000-4000-8000-000000000001', childId = '00000000-0000-4000-8000-000000000002', calls = [];
  const session = new GrokSession({ gen: 1, settings: { cwd: home }, opts: { sessionId: sourceId, fork: true },
    exe: '/fixture/grok', spec: { args: [], env: {} }, spawn: () => assert.fail('no process expected'), log() {},
    history: { root: home, find: () => null }, onEvent() {}, onSessionId() {}, onResult() {} });
  session.starting = Promise.resolve();
  session.cwd = home;
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'session/load') return { sessionId: sourceId };
    if (method === '_x.ai/session/fork') return { newSessionId: childId, parentSessionId: sourceId };
    return {};
  };
  await session.open();
  assert.equal(session.sessionId, childId);
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'session/load', '_x.ai/session/fork', 'session/load']);
  assert.equal(calls[3].params.sessionId, childId);
  assert.deepEqual(calls[2].params.sourceSessionId, sourceId);
  assert.equal(calls[2].params.sourceCwd, home);
  assert.equal(calls[2].params.newCwd, home);
});

test('Grok connection settings keep API and subscription models separate', () => {
  const config = { grok: { connection: 'subscription', apiModel: 'api-model', subscriptionModel: 'grok-4.7', permissionMode: 'auto' } };
  assert.equal(grokConnectionSettings(config).model, 'grok-4.7');
  assert.equal(grokConnectionSettings(config, 'session-id').connection, 'api');
  const updated = updateGrokConnectionSettings(config, { connection: 'api', model: 'next-api', permissionMode: 'full' });
  assert.equal(updated.apiModel, 'next-api');
  assert.equal(updated.subscriptionModel, 'grok-4.7');
  assert.equal(updated.permissionMode, 'full');
  assert.equal(updateGrokConnectionSettings(config, { permissionMode: 'bypassPermissions' }).permissionMode, 'bypassPermissions');
});
