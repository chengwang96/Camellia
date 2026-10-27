'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createGrokAccount, parseGrokLoginOutput } = require('../src/engines/grok-account');
const { normalizeGrokBilling, normalizeGrokModels } = require('../src/engines/grok-quota');
const { removeTree } = require('./test-fs.cjs');

const catalog = { result: { currentModelId: 'grok-4.7', availableModels: [
  { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 500000, reasoningEffort: 'high',
    reasoningEfforts: [{ value: 'high', default: true }, { value: 'medium' }, { value: 'low' }] } },
  { modelId: 'grok-build-0.1', name: 'Grok Build', _meta: { totalContextTokens: 256000, reasoningEfforts: [] } },
] } };
const billing = { config: { creditUsagePercent: 42.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-01T00:00:00Z' },
  prepaidBalance: { val: 1250 }, onDemandCap: { val: 5000 }, onDemandUsed: { val: 300 }, isUnifiedBillingUser: true },
  onDemandEnabled: true, subscriptionTier: 'Premium' };

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Account operation did not settle');
}

function fixture(t, { getProxyUrl = () => '', environment, onRequest = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-grok-account-')), home = path.join(root, 'subscription');
  const processes = [], calls = [], clients = [], opened = [];
  const account = createGrokAccount({ home, runtime: () => ({ file: '/fixture/grok.exe' }), ensureRuntime: async () => {},
    environment: environment || (() => ({ XAI_API_KEY: 'parent-secret', PATH: process.env.PATH })), getProxyUrl,
    openExternal: async url => opened.push(url),
    spawnProcess(exe, args, options) {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), args, options,
        kill() { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true; } });
      processes.push(proc); return proc;
    },
    createClient(spec) {
      const client = { spec, start() {}, async shutdown() { this.closed = true; }, async request(method, params) {
        calls.push({ method, params });
        onRequest(method);
        if (method === '_x.ai/models/list') return catalog;
        if (method === '_x.ai/billing') return billing;
        if (method === '_x.ai/auto-topup-rule') return { rule: { enabled: false } };
        return {};
      } };
      clients.push(client); return client;
    } });
  t.after(async () => {
    await account.shutdown();
    for (const proc of processes) { proc.stdout.destroy(); proc.stderr.destroy(); }
    removeTree(root);
  });
  return { root, home, account, processes, calls, clients, opened };
}

test('Grok login output accepts only the official device URL and captures the code', () => {
  const text = 'To sign in, open this URL:\nhttps://accounts.x.ai/oauth2/device?user_code=ABC-123\nConfirm this code in your browser:\n\nABC-123\n';
  assert.deepEqual(parseGrokLoginOutput(text), { verificationUrl: 'https://accounts.x.ai/oauth2/device?user_code=ABC-123', userCode: 'ABC-123' });
  assert.equal(parseGrokLoginOutput('https://evil.example/oauth2/device?user_code=ABC\nConfirm this code in your browser: ABC').verificationUrl, null);
});

test('official model and billing responses retain reasoning, context, plan, quota and prepaid balance', () => {
  const models = normalizeGrokModels(catalog);
  assert.deepEqual(models.map(model => model.id), ['grok-4.7', 'grok-build-0.1']);
  assert.equal(models[0].contextWindow, 500000);
  assert.deepEqual(models[0].supportedReasoningEfforts, ['high', 'medium', 'low']);
  assert.equal(models[0].defaultReasoningEffort, 'high');
  assert.equal(models[0].isDefault, true);
  const quota = normalizeGrokBilling(billing, { rule: { enabled: false } });
  assert.equal(quota.plan, 'Premium');
  assert.equal(quota.windows[0].usedPercent, 42.5);
  assert.equal(quota.windows[0].resetsAt, '2026-11-01T00:00:00.000Z');
  assert.equal(quota.balances[0].value, 12.5);
  assert.equal(quota.exhausted, false);
  const exhausted = normalizeGrokBilling({ config: { creditUsagePercent: 100, prepaidBalance: {}, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } }, onDemandEnabled: false });
  assert.equal(exhausted.exhausted, true);
});

test('device login verifies subscription models and quota without persisting credentials or the device code', async t => {
  const f = fixture(t);
  assert.equal((await f.account.signIn()).loginPending, true);
  const proc = f.processes[0];
  assert.deepEqual(proc.args, ['login', '--device-auth']);
  assert.equal(proc.options.env.XAI_API_KEY, undefined);
  assert.equal(proc.options.env.GROK_HOME, f.home);
  proc.stderr.write('To sign in, open this URL:\nhttps://accounts.x.ai/oauth2/device?user_code=ABC-123\nConfirm this code in your browser:\nABC-123\n');
  assert.equal(f.account.state().login.userCode, 'ABC-123');
  await f.account.openLogin();
  assert.deepEqual(f.opened, ['https://accounts.x.ai/oauth2/device?user_code=ABC-123']);
  proc.emit('close', 0);
  await until(() => !f.account.active);
  const state = f.account.state();
  assert.equal(state.account.plan, 'Premium');
  assert.equal(state.models[0].supportedReasoningEfforts.length, 3);
  assert.equal(state.usage.latest.prepaidBalance, 12.5);
  assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'authenticate', '_x.ai/models/list', '_x.ai/billing', '_x.ai/auto-topup-rule']);
  assert.equal(f.calls[1].params.methodId, 'cached_token');
  const persisted = fs.readFileSync(path.join(f.home, 'account-state.json'), 'utf8');
  assert.doesNotMatch(persisted, /ABC-123|user_code|parent-secret/);
});

test('sign-out clears the local account even when the official logout is offline', async t => {
  const f = fixture(t);
  await f.account.signIn(); f.processes[0].emit('close', 0); await until(() => !f.account.active);
  fs.writeFileSync(path.join(f.home, 'auth.json'), 'secret');
  const result = await f.account.signOut();
  assert.equal(result.account, null);
  assert.equal(fs.existsSync(path.join(f.home, 'auth.json')), false);
  assert.equal(f.processes.at(-1).args[0], 'logout');
  assert.deepEqual(result.models, []);
});

test('canceling login terminates the process and does not verify an account', async t => {
  const f = fixture(t);
  await f.account.signIn();
  await f.account.cancelLogin();
  assert.equal(f.processes[0].killed, true);
  assert.equal(f.account.state().loginPending, false);
  assert.equal(f.calls.length, 0);
});

test('failed account refreshes retain verified identity, models and quota until a successful retry', async t => {
  let failedMethod;
  const f = fixture(t, { onRequest(method) { if (method === failedMethod) throw new Error('ETIMEDOUT'); } });
  const verified = await f.account.refresh();
  for (failedMethod of ['authenticate', '_x.ai/models/list', '_x.ai/billing']) {
    const state = await f.account.refresh();
    assert.deepEqual(state.account, verified.account);
    assert.deepEqual(state.models, verified.models);
    assert.equal(state.verifiedAt, verified.verifiedAt);
    assert.deepEqual(state.usage.latest, verified.usage.latest);
    assert.equal(state.usage.status, 'error');
    assert.match(state.error, /Could not verify/);
    const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'account-state.json'), 'utf8'));
    assert.deepEqual(saved.account, verified.account);
    assert.deepEqual(saved.usage.latest, verified.usage.latest);
  }
  failedMethod = null;
  const recovered = await f.account.refresh();
  assert.equal(recovered.error, null);
  assert.equal(recovered.usage.status, 'ok');
});

test('login, account and quota checks, and logout use the current subscription proxy preference', async t => {
  let proxy = 'http://127.0.0.1:7897';
  const inherited = { XAI_API_KEY: 'parent-secret', HTTP_PROXY: 'http://old.invalid:1234',
    https_proxy: 'http://old.invalid:1234', all_proxy: 'http://old.invalid:1234', no_proxy: '*' };
  const f = fixture(t, { getProxyUrl: () => proxy, environment: () => inherited });
  function check(env, expected) {
    assert.equal(env.HTTP_PROXY, expected);
    assert.equal(env.HTTPS_PROXY, expected);
    assert.equal(env.NO_PROXY, expected ? 'localhost,127.0.0.1,::1' : '*');
    for (const key of ['https_proxy', 'all_proxy', 'no_proxy', 'XAI_API_KEY']) assert.equal(env[key], undefined);
  }
  await f.account.signIn();
  check(f.processes[0].options.env, proxy + '/');
  await f.account.cancelLogin();
  await f.account.refresh();
  check(f.clients.at(-1).spec.env, proxy + '/');
  await f.account.refreshUsage();
  check(f.clients.at(-1).spec.env, proxy + '/');
  proxy = '';
  await f.account.refresh();
  check(f.clients.at(-1).spec.env, '');
  const signingOut = f.account.signOut();
  await until(() => f.processes.at(-1)?.args[0] === 'logout');
  check(f.processes.at(-1).options.env, '');
  f.processes.at(-1).emit('close', 0);
  await signingOut;
  assert.equal(inherited.HTTP_PROXY, 'http://old.invalid:1234');
});
