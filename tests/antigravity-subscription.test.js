'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createHarness } = require('./claude-harness.cjs');
const { createAntigravity, subscriptionSpawnSpec } = require('../src/engines/antigravity');
const { subscriptionEnvironment, systemProxy, parseModels, parseGoogleQuota, groupModels, normalizeSelection, effectiveSelection, loginScript, requireGoogleProvider } = require('../src/engines/antigravity/subscription');
const { createGoogleAccount } = require('../src/engines/antigravity/subscription');
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
  assert.deepEqual(JSON.parse(spec.env.CAMELLIA_ANTIGRAVITY_CLI), { exe: 'official-agy', home: '/profile', model: '', effort: '' });
});

test('Google account model parsing preserves model versions and reasoning variants while removing duplicate rows', () => {
  assert.deepEqual(parseModels('Fetching available models...\ngemini-test-high\tGemini test (High)\r\ngemini-test-low\tGemini test (Low)\ngemini-new-high\tGemini new (High)\ngemini-test-high\tGemini test (High)\n'), [
    { id: 'gemini-test-high', name: 'Gemini test (High)' }, { id: 'gemini-test-low', name: 'Gemini test (Low)' }, { id: 'gemini-new-high', name: 'Gemini new (High)' },
  ]);
  assert.deepEqual(parseModels('Error: Please sign in'), []);
});

test('Google model families collapse reasoning rows into one base model with an effort timeline', () => {
  const rows = [
    { id: 'gemini-test-high', name: 'Gemini test (High)' }, { id: 'gemini-test-medium', name: 'Gemini test (Medium)' },
    { id: 'gemini-test-low', name: 'Gemini test (Low)' }, { id: 'gemini-new-high', name: 'Gemini new (High)' },
    { id: 'gemini-new-low', name: 'Gemini new (Low)' }, { id: 'gemini-pro-high', name: 'Gemini Pro (High)' },
    { id: 'gemini-pro-low', name: 'Gemini Pro (Low)' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ];
  const grouped = groupModels(rows);
  assert.deepEqual(grouped, [
    { id: 'gemini-test', name: 'Gemini test', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high', modelIds: { high: 'gemini-test-high', medium: 'gemini-test-medium', low: 'gemini-test-low' } },
    { id: 'gemini-new', name: 'Gemini new', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high', modelIds: { high: 'gemini-new-high', low: 'gemini-new-low' } },
    { id: 'gemini-pro', name: 'Gemini Pro', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high', modelIds: { high: 'gemini-pro-high', low: 'gemini-pro-low' } },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ]);
  // Grouping is idempotent so a pre-grouping cache upgrades on read.
  assert.deepEqual(groupModels(grouped), grouped);
  assert.deepEqual(normalizeSelection(grouped, 'gemini-test-high', ''), { model: 'gemini-test', thinking: 'high' });
  assert.deepEqual(normalizeSelection(grouped, 'gemini-test', 'medium'), { model: 'gemini-test', thinking: 'medium' });
  assert.deepEqual(normalizeSelection(grouped, 'claude-sonnet-4-6', ''), { model: 'claude-sonnet-4-6', thinking: '' });
  assert.deepEqual(effectiveSelection(grouped, 'gemini-test', ''), { model: 'gemini-test', thinking: 'high' });
  assert.deepEqual(effectiveSelection(grouped, 'gemini-test-low', ''), { model: 'gemini-test', thinking: 'low' });
  assert.deepEqual(effectiveSelection(grouped, 'claude-sonnet-4-6', ''), { model: 'claude-sonnet-4-6', thinking: '' });
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
  const original = { modelProvider: 'gemini', verbosity: 'high', useG1Credits: false, permissions: { deny: ['command(rm *)'] } };
  writeJson(settingsFile, original);
  assert.throws(() => requireGoogleProvider(settingsFile), /API provider/);
  const current = await h.call('engine-settings-get', { engine: 'antigravity' });
  assert.equal(JSON.parse(current.files[0].text).modelProvider, undefined);
  const result = await h.call('engine-settings-save', { engine: 'antigravity', files: current.files,
    common: { agentMode: 'accept-edits' }, desktop: {} });
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

test('the official /quota payload becomes two named limit groups without spending a turn', () => {
  const quota = { status: 'SUCCESS', command: { name: 'quota', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-10-08T18:47:45Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.94, reset_time: '2026-10-01T23:47:45Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-08T18:47:58Z' },
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0, reset_time: '2026-10-01T23:47:58Z' },
    ] },
  ] } } };
  const output = JSON.stringify(quota);
  assert.deepEqual(parseGoogleQuota(output).windows, [
    { id: 'gemini-models:gemini-weekly', label: 'Gemini Models · Weekly', usedPercent: 50, resetsAt: '2026-10-08T18:47:45Z' },
    { id: 'gemini-models:gemini-5h', label: 'Gemini Models · 5-hour', usedPercent: 6, resetsAt: '2026-10-01T23:47:45Z' },
    { id: 'claude-and-gpt-models:3p-weekly', label: 'Claude and GPT models · Weekly', usedPercent: 0, resetsAt: '2026-10-08T18:47:58Z' },
    { id: 'claude-and-gpt-models:3p-5h', label: 'Claude and GPT models · 5-hour', usedPercent: 100, resetsAt: '2026-10-01T23:47:58Z' },
  ]);
  assert.throws(() => parseGoogleQuota('not json'), /unreadable quota response/);
  assert.throws(() => parseGoogleQuota(JSON.stringify({ status: 'SUCCESS' })), /no quota information/);
  assert.throws(() => parseGoogleQuota(JSON.stringify({ command: { data: { groups: [{ name: 'Gemini Models', buckets: [] }] } } })), /no quota windows/);
  for (const remaining_fraction of [null, '', false]) {
    assert.throws(() => parseGoogleQuota(JSON.stringify({ command: { data: { groups: [
      { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction }] },
    ] } } })), /no quota windows/, 'Missing quota must never become an exhausted window');
  }
});

test('Google quota refresh runs /quota, records history, and keeps the last good read on failure', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const home = h.folder('antigravity'); fs.mkdirSync(home, { recursive: true });
  const cliSettingsFile = path.join(home, 'cli.json');
  const calls = [];
  const okOutput = JSON.stringify({ command: { data: { groups: [
    { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.25, reset_time: '2026-10-08T18:47:45Z' }] },
  ] } } });
  const outputs = [okOutput, null];
  const account = createGoogleAccount({ home, cliSettingsFile, runtime: () => ({ locate: () => ({ file: 'official-agy' }) }),
    environment: () => ({ GEMINI_API_KEY: 'fixture' }), settings: () => ({ proxyUrl: '' }), openLogin: async () => {},
    run: async (file, args, options) => { calls.push({ file, args, options });
      const output = outputs.shift(); if (output === null) throw new Error('network down'); return output; } });
  const first = await account.refreshUsage({ force: true });
  assert.deepEqual(calls[0].args, ['-p', '/quota', '--output-format', 'json']);
  assert.equal(calls[0].options.env.GEMINI_API_KEY, undefined);
  assert.deepEqual(first.usage.latest.windows, [{ id: 'gemini-models:gemini-weekly', label: 'Gemini Models · Weekly', usedPercent: 75, resetsAt: '2026-10-08T18:47:45Z' }]);
  assert.equal(first.usage.status, 'ok'); assert.equal(first.usage.history.length, 1);
  // A failed refresh keeps the previous reading but surfaces the refresh error.
  const second = await account.refreshUsage({ force: true });
  assert.equal(second.usage.status, 'stale'); assert.equal(second.usage.latest.windows[0].usedPercent, 75);
  assert.match(second.usage.error, /network down/);
  const third = await account.refreshUsage({ force: false });
  assert.equal(third.usage.error, second.usage.error, 'A fresh reading suppresses the throttled refresh entirely');
  assert.equal(calls.length, 2);
});

test('Google quota refresh deduplicates requests, retains 30 days, and clears old-account data on sign-in', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const home = h.folder('quota-account'), cliSettingsFile = path.join(home, 'cli.json');
  const stamp = Date.now(), output = JSON.stringify({ command: { data: { groups: [
    { name: 'Gemini Models', buckets: [{ id: 'weekly', window: 'weekly', remaining_fraction: 0.8 }] },
  ] } } });
  writeJson(cliSettingsFile, { useG1Credits: false });
  writeJson(path.join(home, 'google-quota.json'), { history: [
    { at: new Date(stamp - 31 * 86400000).toISOString(), windows: [] },
    { at: new Date(stamp - 86400000).toISOString(), windows: [] },
  ] });
  let finish, calls = 0;
  const events = [];
  const account = createGoogleAccount({ home, cliSettingsFile, now: () => stamp,
    runtime: () => ({ locate: () => ({ file: 'official-agy' }), ensure: async () => ({ file: 'official-agy' }) }),
    environment: () => ({}), settings: () => ({}), openLogin: async () => {},
    onChange: () => events.push(account.state().usage.refreshing),
    run: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = account.refreshUsage(), duplicate = account.refreshUsage();
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(account.state().usage.refreshing, true);
  finish(output);
  await Promise.all([first, duplicate]);
  assert.deepEqual(events, [true, false]);
  assert.equal(account.state().usage.history.length, 2);
  assert.equal(account.state().usage.latest.windows[0].usedPercent, 20);
  const oldAccountRefresh = account.refreshUsage();
  await Promise.resolve();
  await account.signIn();
  finish(output);
  await oldAccountRefresh;
  assert.equal(account.state().usage.latest, null);
  assert.deepEqual(account.state().usage.history, []);
  assert.equal(account.state().awaitingVerification, true);
  assert.equal(JSON.parse(fs.readFileSync(cliSettingsFile)).useG1Credits, false);
});

test('Google quota cards, history and targeted/background refresh share the subscription IPC', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const at = new Date().toISOString();
  writeJson(path.join(h.userData, 'antigravity/google-account.json'), {
    models: [{ id: 'gemini-fixture', name: 'Gemini Fixture' }], verifiedAt: Date.now(), error: '',
  });
  const windows = parseGoogleQuota(JSON.stringify({ command: { data: { groups: [
    { name: 'Gemini Models', buckets: [{ id: 'weekly', window: 'weekly', remaining_fraction: 0.75 }] },
    { name: 'Claude and GPT models', buckets: [{ id: 'weekly', window: 'weekly', remaining_fraction: 0.5 }] },
  ] } } })).windows;
  const latest = { at, balances: [], windows };
  writeJson(path.join(h.userData, 'antigravity/google-quota.json'), { status: 'ok', checkedAt: at, latest, history: [latest] });
  const card = (await h.call('antigravity-account-state')).accounts[0];
  assert.equal(card.signedIn, true); assert.equal(card.quotaWindows.length, 2);
  const insights = await h.call('provider-insights');
  assert.equal(insights.subscriptions[0].id, 'antigravity:default');
  assert.deepEqual(insights.subscriptions[0].info.history, [latest]);
  assert.deepEqual(insights.keys, {});
  assert.doesNotMatch(JSON.stringify(insights), /access_token|refresh_token|GEMINI_API_KEY/);
  const actualRefresh = h.api.antigravity.handlers['account-refresh-usage'], calls = [];
  h.api.antigravity.handlers['account-refresh-usage'] = async payload => { calls.push(payload); };
  await h.call('provider-refresh', { apiOnly: true });
  await h.call('provider-refresh', { subscriptionId: 'codex:missing' });
  assert.equal(calls.length, 0);
  await h.call('provider-refresh', { subscriptionId: 'antigravity:default' });
  await h.call('provider-refresh', { force: false });
  assert.deepEqual(calls.map(call => call.force), [true, false]);
  h.api.antigravity.handlers['account-refresh-usage'] = actualRefresh;
  // A recently attempted refresh returns the full card without another CLI
  // call; the successful timestamp survives a newer failed attempt.
  writeJson(path.join(h.userData, 'antigravity/google-quota.json'), { status: 'stale', checkedAt: new Date().toISOString(),
    error: 'network down', latest, history: [latest] });
  const refreshed = await h.call('antigravity-account-refresh-usage', { force: false });
  assert.equal(refreshed.ok, true, refreshed.error);
  assert.equal(refreshed.accounts[0].signedIn, true);
  assert.equal(refreshed.accounts[0].verifiedAt, at);
  assert.equal(refreshed.usage.status, 'stale');
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
