'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createHarness } = require('./claude-harness.cjs');
const { createAntigravity, subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { subscriptionEnvironment, systemProxy, parseModels, loginScript, requireGoogleProvider } = require('../src/engines/antigravity/subscription');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { installAntigravityCli } = require('../src/main/antigravity-cli-runtime');
const { writeJson } = require('../src/shared/json-store');

test('Google subscription strips API auth, preserves unrelated environment and scopes a custom proxy to its process', () => {
  const input = { GEMINI_API_KEY: 'fixture', GOOGLE_API_KEY: 'fixture', GOOGLE_APPLICATION_CREDENTIALS: 'fixture', AGY_ADC_AUTH: 'true',
    GOOGLE_GEMINI_BASE_URL: 'http://other-provider', Path: 'shell-tools', http_proxy: 'http://inherited', unrelated: 'keep' };
  const env = subscriptionEnvironment(input, 'http://proxy.example:8080');
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ADC_AUTH', 'GOOGLE_GEMINI_BASE_URL']) assert.equal(env[key], undefined);
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example:8080'); assert.equal(env.http_proxy, undefined);
  assert.equal(env.Path, input.Path); assert.equal(env.unrelated, 'keep'); assert.equal(input.GEMINI_API_KEY, 'fixture');
  // An enabled Windows system proxy is a legitimate override, so this assertion
  // only holds on machines without one.
  if (!systemProxy()) assert.equal(subscriptionEnvironment(input).http_proxy, input.http_proxy, 'An empty custom proxy preserves environment proxy settings');
  const spec = subscriptionSpawnSpec({ runtime: { file: 'official-agy' }, home: '/profile', env: input });
  assert.equal(spec.env.GEMINI_API_KEY, undefined);
  assert.deepEqual(JSON.parse(spec.env.CAMELLIA_ANTIGRAVITY_CLI), { exe: 'official-agy', home: '/profile' });
});

test('Google account model parsing preserves model versions and reasoning variants while removing duplicate rows', () => {
  assert.deepEqual(parseModels('Fetching available models...\ngemini-test-high\tGemini test (High)\r\ngemini-test-low\tGemini test (Low)\ngemini-new-high\tGemini new (High)\ngemini-test-high\tGemini test (High)\n'), [
    { id: 'gemini-test-high', name: 'Gemini test (High)' }, { id: 'gemini-test-low', name: 'Gemini test (Low)' }, { id: 'gemini-new-high', name: 'Gemini new (High)' },
  ]);
  assert.deepEqual(parseModels('Error: Please sign in'), []);
});

test('API and Google selections survive connection changes and existing sessions retain their authentication source', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  await h.call('antigravity-save-settings', { model: 'api-model' });
  const before = await h.call('engine-settings-get', { engine: 'antigravity' });
  const switched = await h.call('engine-settings-save', { engine: 'antigravity', files: before.files, common: {}, desktop: { connection: 'subscription' } });
  assert.equal(switched.ok, true, switched.error); assert.equal(switched.desktop.model, '');
  assert.equal(switched.scope, 'cli'); assert.ok(switched.files[0].path.startsWith(h.home));
  await h.call('antigravity-save-settings', { model: 'google-model' });
  assert.equal((await h.call('antigravity-get-settings', { sessionId: 'api-session' })).model, 'api-model');
  await h.call('antigravity-save-settings', { connection: 'api' });
  assert.equal((await h.call('antigravity-get-settings')).model, 'api-model');
  const resumed = await h.call('antigravity-get-settings', { sessionId: 'agy-123' });
  assert.equal(resumed.connection, 'subscription'); assert.equal(resumed.model, 'google-model');
  await h.call('antigravity-save-settings', { sessionId: 'agy-123', model: 'another-google-model' });
  assert.equal((await h.call('antigravity-get-settings')).connection, 'api', 'Editing a historical session does not change the default for new sessions');
  await h.call('antigravity-save-settings', { connection: 'subscription' });
  assert.equal((await h.call('antigravity-get-settings')).model, 'another-google-model');
  assert.equal((await h.call('antigravity-save-settings', { connection: 'other' })).ok, false);
  assert.equal((await h.call('antigravity-save-settings', { proxyUrl: 'socks5://not-supported' })).ok, false);
});

test('Unified Google settings preserve native CLI settings and back up before selecting account authentication', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  await h.call('antigravity-save-settings', { connection: 'subscription' });
  const settingsFile = path.join(h.home, '.gemini/antigravity-cli/settings.json');
  const original = { modelProvider: 'gemini', verbosity: 'high', permissions: { deny: ['command(rm *)'] } };
  writeJson(settingsFile, original);
  assert.throws(() => requireGoogleProvider(settingsFile), /API provider/);
  const current = await h.call('engine-settings-get', { engine: 'antigravity' });
  assert.equal(JSON.parse(current.files[0].text).modelProvider, undefined);
  const result = await h.call('engine-settings-save', { engine: 'antigravity', files: current.files,
    common: { agentMode: 'accept-edits', useG1Credits: false }, desktop: {} });
  assert.equal(result.ok, true, result.error);
  const native = JSON.parse(fs.readFileSync(settingsFile));
  assert.equal(native.modelProvider, undefined); assert.equal(native.useG1Credits, false);
  assert.deepEqual(native.permissions, original.permissions); assert.equal(native.verbosity, 'high');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile + '.workbench.bak')), original);
  assert.equal((await h.call('antigravity-get-settings')).permissionMode, 'acceptEdits');
  requireGoogleProvider(settingsFile);
});

test('Missing Google sign-in and unavailable models never consult the shared API router', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  let config = { antigravity: { connection: 'subscription', model: 'not-in-account', cwd: h.folder('project') } };
  const service = createAntigravity({ dataDir: h.userData, cliSettingsFile: path.join(h.home, '.gemini/antigravity-cli/settings.json'),
    loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; },
    getRoute: () => assert.fail('A Google session must not use an API route'), getModels: () => assert.fail('A Google session must not list API models'),
    runtimes: () => ({ locate: () => null }), onEvent() {}, onGoal() {}, log() {} });
  await assert.rejects(service.handlers.send({ prompt: 'fixture' }), /Google account model list/);
  writeJson(path.join(h.userData, 'antigravity/google-account.json'), { models: [{ id: 'not-in-account', name: 'Now available' }] });
  await assert.rejects(service.handlers.send({ prompt: 'fixture' }), /Prepare Antigravity/);
});

test('Official CLI login scripts quote executable paths and do not contain account tokens', t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const file = path.join(h.folder('login'), 'launch');
  const exe = "/Applications/Alice's $(example)/agy";
  loginScript(file, { platform: 'darwin', exe, proxyUrl: 'http://proxy.example:8080' });
  const shell = fs.readFileSync(file, 'utf8');
  assert.ok(shell.includes("exec '/Applications/Alice'\\''s $(example)/agy'"));
  assert.match(shell, /unset GEMINI_API_KEY/); assert.match(shell, /HTTPS_PROXY='http:\/\/proxy.example:8080'/);
  loginScript(file, { platform: 'win32', exe });
  assert.equal(fs.readFileSync(file, 'utf8').charCodeAt(0), 0xfeff, 'Windows PowerShell can read non-ASCII paths');
  assert.ok(fs.readFileSync(file, 'utf8').includes("& '/Applications/Alice''s $(example)/agy'"));
});

test('Google runtime download verifies its checksum and installs the CLI independently of the SDK', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const source = h.folder('source'), dir = h.folder('target');
  const payload = Buffer.from('official-runtime-fixture');
  const manifest = { cli: { version: 'fixture', platforms: { [process.platform + '-' + process.arch]: {
    url: 'http://local-fixture/cli', sha512: createHash('sha512').update(payload).digest('hex'),
  } } } };
  writeJson(path.join(source, 'runtime.json'), manifest);
  const options = { source, dir, report() {}, connection: { fetch: async () => new Response(payload) },
    run: async () => fs.writeFileSync(path.join(dir, 'cli/antigravity'), payload) };
  const found = await installAntigravityCli(options);
  assert.equal(found.mode, 'subscription'); assert.deepEqual(fs.readFileSync(found.file), payload);
  assert.equal(fs.existsSync(path.join(dir, 'python')), false);
  options.dir = h.folder('bad-target');
  options.connection.fetch = async () => new Response('corrupted');
  await assert.rejects(installAntigravityCli(options), /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(options.dir, 'cli/installed.json')), false);
  const manager = createRuntimeManager({ root: h.root, installRoot: h.userData, runtimeMode: () => 'subscription' });
  const target = path.join(h.root, 'runtimes/antigravity/cli');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(path.join(dir, 'cli'), target, { recursive: true });
  assert.equal(manager.locate('antigravity').mode, 'subscription');
  assert.equal(manager.locate('antigravity', 'api'), null);
  assert.equal(manager.state().find(row => row.id === 'antigravity').status, 'ready');
});
