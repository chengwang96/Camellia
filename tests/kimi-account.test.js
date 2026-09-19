'use strict';
const { removeTree } = require('./test-fs.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const TOML = require('smol-toml');
const { createKimiAccount, parseLoginOutput } = require('../src/engines/kimi-account');
const { kimiSpawnSpec, kimiEnvironment, kimiConnectionSettings, updateKimiConnectionSettings } = require('../src/engines/kimi-session');

function managedConfig(region = 'mainland-cn') {
  const suffix = region === 'global' ? 'ai' : 'com';
  const oauth = { storage: 'file', key: 'oauth/kimi-code', oauth_host: `https://auth.kimi.${suffix}` };
  return { default_model: 'kimi-code/coding', thinking: { enabled: true },
    providers: { 'managed:kimi-code': { type: 'kimi', base_url: `https://api.kimi.${suffix}/coding`, api_key: '', oauth } },
    models: {
      'kimi-code/coding': { provider: 'managed:kimi-code', model: 'coding', display_name: 'Kimi Coding', max_context_size: 262144, capabilities: ['thinking', 'image_in'] },
      'kimi-code/fast': { provider: 'managed:kimi-code', model: 'fast', max_context_size: 131072 },
    },
    services: { moonshot_search: { base_url: `https://api.kimi.${suffix}/coding/search`, api_key: '', oauth } },
  };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Account operation did not settle');
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-kimi-account-'));
  const home = path.join(root, 'subscription'), processes = [], calls = [], events = [], clients = [], opened = [];
  const put = (config = managedConfig()) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify(config)); };
  const account = createKimiAccount({ home, runtime: () => ({ file: '/fixture/kimi.mjs' }), ensureRuntime: async () => {}, node: () => process.execPath,
    environment: () => ({ KIMI_API_KEY: 'secret-parent-key', KIMI_MODEL_NAME: 'api-model', PATH: process.env.PATH }),
    onChange: state => events.push(structuredClone(state)), openExternal: async url => opened.push(url),
    queryQuota: async () => ({ balances: [], windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 25, resetsAt: '2026-09-24T00:00:00Z' }], modelUsage: [] }),
    spawnProcess(exe, args, options) {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exe, args, options,
        kill() { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true; } });
      processes.push(proc); return proc;
    },
    createClient(spec) {
      const client = { spec, start() {}, async shutdown() { this.closed = true; },
        async request(method, params) {
          calls.push({ method, params });
          if (method === 'session/new') return { sessionId: 'empty-probe', configOptions: [{ id: 'model', options: [{ value: 'kimi-code/fast', name: 'Fast account model' }] }] };
          if (method === 'logout') fs.writeFileSync(path.join(home, 'config.toml'), '');
          return {};
        },
      };
      clients.push(client); return client;
    }, ...extra });
  t.after(async () => {
    await account.shutdown();
    for (const proc of processes) { proc.stdout.destroy(); proc.stderr.destroy(); }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-kimi-account-'));
    removeTree(root);
  });
  return { root, home, account, put, processes, calls, events, clients, opened };
}

test('official device login handles split output, verifies the account and deletes only its empty probe', async t => {
  const f = fixture(t, { region: () => 'global' });
  assert.equal(f.account.active, false);
  assert.equal((await f.account.signIn()).loginPending, true);
  await f.account.signIn(); assert.equal(f.processes.length, 1, 'Repeated sign-in does not spawn another flow');
  const proc = f.processes[0];
  assert.deepEqual(proc.args.slice(1), ['login', '--region', 'global']);
  assert.equal(proc.options.windowsHide, true);
  assert.equal(proc.options.env.KIMI_API_KEY, undefined);
  assert.equal(proc.options.env.KIMI_CODE_HOME, f.home);
  proc.stderr.write('Opening browser for Kimi device login: https://auth.kimi.ai/device?user_code=ABC-123\nIf the browser did not open, paste the URL above and enter co');
  assert.equal(f.account.state().login, null);
  proc.stderr.write('de: ABC-123\nCode expires in 600s.\nWaiting for authorization to complete…\n');
  const details = f.account.state().login;
  assert.equal(details.userCode, 'ABC-123');
  proc.stderr.write('Further status\n'); assert.equal(f.account.state().login.expiresAt, details.expiresAt);
  await f.account.openLogin(); assert.deepEqual(f.opened, [details.verificationUrl]);
  f.put(managedConfig('global'));
  proc.emit('close', 0);
  await until(() => !f.account.active);
  const state = f.account.state();
  assert.equal(state.loginPending, false); assert.equal(state.login, null); assert.equal(state.error, null);
  assert.equal(state.account.region, 'global');
  assert.deepEqual(state.models.map(model => [model.id, model.name]), [['kimi-code/coding', 'Kimi Coding'], ['kimi-code/fast', 'Fast account model']]);
  assert.equal(state.models[0].contextWindow, 262144);
  assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'authenticate', 'session/new', 'session/delete']);
  assert.deepEqual(f.calls[1].params, { methodId: 'login' });
  assert.deepEqual(f.calls[3].params, { sessionId: 'empty-probe' });
  assert.ok(f.clients.every(client => client.closed));
  const publicState = fs.readFileSync(path.join(f.home, 'account-state.json'), 'utf8');
  assert.doesNotMatch(publicState, /ABC-123|verificationUrl|secret-parent-key|oauth/);
});

test('cancel and timeout terminate the login process and clear the temporary code', async t => {
  for (const timed of [false, true]) {
    const f = fixture(t, { loginTimeoutMs: timed ? 20 : 15000 });
    await f.account.signIn();
    f.processes[0].stderr.write('Opening browser for Kimi device login: https://auth.kimi.com/device\nenter code: CANCEL-ME\n');
    if (timed) await until(() => !f.account.active); else await f.account.cancelLogin();
    assert.equal(f.processes[0].killed, true);
    assert.equal(f.account.state().login, null);
    assert.equal(f.calls.length, 0, 'Canceled login does not verify or call a model');
    assert.equal(Boolean(f.account.state().error), timed);
    await assert.rejects(f.account.openLogin(), /Start Kimi sign-in/);
  }
});

test('canceling while the runtime is prepared prevents a late login or browser launch', async t => {
  let ready;
  const f = fixture(t, { ensureRuntime: () => new Promise(resolve => { ready = resolve; }) });
  const starting = f.account.signIn();
  await f.account.cancelLogin(); ready(); await starting;
  assert.equal(f.account.state().loginPending, false); assert.equal(f.processes.length, 0);
});

test('download cancellation, process failure and shutdown leave no pending login', async t => {
  const download = fixture(t, { ensureRuntime: async () => { throw Object.assign(new Error('cancel'), { code: 'DOWNLOAD_CANCELLED' }); } });
  assert.equal((await download.account.signIn()).canceled, true);
  assert.equal(download.events.at(-1).loginPending, false);
  const failed = fixture(t);
  await failed.account.signIn();
  failed.processes[0].stderr.write('secret-token-must-not-leak'); failed.processes[0].emit('close', 1);
  assert.equal(failed.account.active, false);
  assert.doesNotMatch(JSON.stringify(failed.events), /secret-token/);
  const closed = fixture(t); await closed.account.signIn(); await closed.account.shutdown();
  assert.equal(closed.processes[0].killed, true); assert.equal(closed.account.active, false);
});

test('an API-only config cannot count as a signed-in subscription', async t => {
  const f = fixture(t);
  f.put({ providers: { workbench: { type: 'openai', api_key: 'fake', base_url: 'http://localhost:8888/v1' } }, models: {} });
  const state = await f.account.refresh();
  assert.equal(state.account, null); assert.deepEqual(state.models, []); assert.match(state.error, /Sign in again/);
  assert.equal(f.clients.length, 0);
});

test('failed native authentication clears stale account models without exposing native error details', async t => {
  let client;
  const f = fixture(t, { createClient: () => (client = { start() {}, async shutdown() { this.closed = true; },
    async request(method) { if (method === 'authenticate') throw new Error('native failure secret-token'); return {}; },
  }) });
  f.put(); const state = await f.account.refresh();
  assert.equal(state.account, null); assert.deepEqual(state.models, []); assert.equal(client.closed, true);
  assert.doesNotMatch(JSON.stringify(f.events), /secret-token/);
});

test('sign out uses native logout, clears metadata and keeps the API profile intact', async t => {
  const f = fixture(t); f.put();
  const apiHome = path.join(f.root, 'api'); fs.mkdirSync(apiHome); fs.writeFileSync(path.join(apiHome, 'config.toml'), 'api profile');
  await f.account.refresh();
  const state = await f.account.signOut();
  assert.equal(state.account, null); assert.deepEqual(state.models, []);
  assert.equal(state.usage.latest, undefined);
  assert.deepEqual(f.calls.slice(-2).map(call => call.method), ['initialize', 'logout']);
  assert.equal(fs.readFileSync(path.join(apiHome, 'config.toml'), 'utf8'), 'api profile');
});

test('subscription quota persists, coalesces observations and retains the last success on a query failure', async t => {
  let clock = Date.parse('2026-09-17T01:00:00Z'), fail = false, calls = 0;
  const f = fixture(t, { now: () => clock, queryQuota: async () => {
    calls++; if (fail) throw new Error('private-native-token');
    return { balances: [], windows: [{ id: 'five-hour', label: '5-hour', usedPercent: calls * 10, resetsAt: '2026-09-17T05:00:00Z' }], modelUsage: [] };
  } });
  f.put(); await f.account.refresh();
  assert.equal(f.account.state().usage.latest.windows[0].usedPercent, 10);
  await f.account.refreshUsage({ force: false }); assert.equal(calls, 1);
  await f.account.refreshUsage(); assert.equal(f.account.state().usage.history.length, 1);
  clock += 16 * 60000; await f.account.refreshUsage({ force: false });
  assert.equal(f.account.state().usage.history.length, 2);
  fail = true; await f.account.refreshUsage();
  const state = f.account.state();
  assert.ok(state.account, 'Quota failure does not sign out the account');
  assert.equal(state.usage.status, 'error'); assert.equal(state.usage.latest.windows[0].usedPercent, 30);
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'account-state.json')));
  assert.equal(saved.usage.history.length, 2);
  assert.doesNotMatch(JSON.stringify(f.events), /private-native-token/);
});

test('quota queries work during a conversation, share one request, and cannot restore signed-out data', async t => {
  let finish, busy = false;
  const f = fixture(t, { isBusy: () => busy }); f.put(); await f.account.refresh();
  busy = true; await f.account.refreshUsage();
  assert.equal(f.account.state().usage.status, 'ok');
  busy = false;
  const g = fixture(t, { queryQuota: () => new Promise(resolve => { finish = resolve; }) });
  g.put(); const refreshing = g.account.refresh(); await until(() => finish);
  const concurrent = g.account.refreshUsage();
  const signedOut = await g.account.signOut(); assert.equal(signedOut.account, null);
  finish({ balances: [], windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 50 }], modelUsage: [] });
  await Promise.all([refreshing, concurrent]);
  assert.equal(g.account.state().account, null); assert.equal(g.account.state().usage.latest, undefined);
});

test('active Kimi work blocks account changes before any child process starts', async t => {
  const f = fixture(t, { isBusy: () => true });
  await assert.rejects(f.account.signIn(), /Stop the Kimi/);
  await assert.rejects(f.account.signOut(), /Stop the Kimi/);
  await assert.rejects(f.account.refresh(), /Stop the Kimi/);
  assert.equal(f.processes.length + f.clients.length, 0);
});

test('sign out cannot race with another login or account refresh', async t => {
  let finish;
  const f = fixture(t, { createClient: () => ({ start() {}, async shutdown() {}, async request(method) {
    if (method === 'logout') await new Promise(resolve => { finish = resolve; }); return {};
  } }) });
  const signingOut = f.account.signOut(); await until(() => finish);
  assert.equal(f.account.state().signingOut, true);
  await assert.rejects(f.account.signIn(), /sign-out/); await assert.rejects(f.account.refresh(), /sign-out/);
  finish(); await signingOut; assert.equal(f.account.state().signingOut, false);
});

test('only official device login links can be reopened', () => {
  for (const url of ['https://attacker.invalid/device', 'https://auth.kimi.com.attacker.invalid/', 'https://user:password@auth.kimi.com/', 'https://[']) {
    assert.equal(parseLoginOutput(`Opening browser for Kimi device login: ${url}\nenter code: ABC`).verificationUrl, null);
  }
});

test('subscription spawn keeps official account models and search without API overrides', t => {
  const f = fixture(t); f.put();
  const env = { KIMI_MODEL_PROVIDER: 'workbench', KIMI_API_KEY: 'external-key', KIMI_CODE_API_KEY: 'external-key',
    KIMI_OAUTH_HOST: 'https://override.invalid', KIMI_WEB_SEARCH_API_KEY: 'search-key', KIMI_WEB_FETCH_BASE_URL: 'https://override.invalid', CUSTOM_VAR: 'keep' };
  const spec = kimiSpawnSpec({ home: f.home, runtime: 'fixture', connection: 'subscription', model: 'kimi-code/coding', env,
    route: { baseUrl: 'http://localhost:8888', authToken: 'api-token' }, config: { loop_control: { max_steps_per_turn: 500 },
      secondary_model: { provider: 'external' }, services: { moonshot_search: { base_url: 'https://override.invalid', api_key: 'search-key' } },
      providers: { external: { api_key: 'external-key' } }, models: { external: {} } } });
  const config = TOML.parse(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'));
  assert.deepEqual(Object.keys(config.providers), ['managed:kimi-code']);
  assert.deepEqual(Object.keys(config.models), ['kimi-code/coding', 'kimi-code/fast']);
  assert.equal(config.services.moonshot_search.oauth.key, 'oauth/kimi-code');
  assert.equal(config.services.moonshot_search.base_url, 'https://api.kimi.com/coding/search');
  assert.equal(config.models['kimi-code/coding'].max_context_size, 262144);
  assert.equal(config.loop_control.max_steps_per_turn, 500); assert.equal(config.secondary_model, undefined);
  assert.doesNotMatch(JSON.stringify(config) + JSON.stringify(spec), /external-key|search-key|api-token|override\.invalid/);
  assert.equal(spec.env.CUSTOM_VAR, 'keep'); assert.equal(env.KIMI_API_KEY, 'external-key');
  assert.throws(() => kimiSpawnSpec({ home: f.home, connection: 'subscription', model: 'api-model' }), /not available/);
});

test('API default, account model and existing native connection survive setting changes', () => {
  const config = { kimi: { model: 'api-original' }, kimiSessionConnections: { 'native-subscription': 'subscription' } };
  config.kimi = updateKimiConnectionSettings(config, { connection: 'subscription', model: 'kimi-code/coding' });
  assert.equal(kimiConnectionSettings(config).model, 'kimi-code/coding');
  assert.equal(kimiConnectionSettings(config, 'old-api-session').model, 'api-original');
  config.kimi = updateKimiConnectionSettings(config, { connection: 'api', model: 'api-new' });
  config.kimi = updateKimiConnectionSettings(config, { sessionId: 'native-subscription', model: 'kimi-code/fast' });
  assert.equal(kimiConnectionSettings(config).model, 'api-new');
  assert.equal(kimiConnectionSettings(config, 'native-subscription').model, 'kimi-code/fast');
  assert.equal(kimiConnectionSettings(config, 'native-subscription').connection, 'subscription');
  assert.equal(kimiConnectionSettings(config, 'old-api-session').connection, 'api');
  assert.throws(() => updateKimiConnectionSettings(config, { region: 'invalid' }), /Invalid Kimi login region/);
  assert.equal(kimiEnvironment('/isolated', { kimi_api_key: 'windows-inherited' }).kimi_api_key, undefined);
});
