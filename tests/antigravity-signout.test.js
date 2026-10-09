'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createGoogleAccount, runCli } = require('../src/engines/antigravity/subscription');
const { clearGoogleCredentials } = require('../src/engines/antigravity/credentials');
const { createAntigravity } = require('../src/engines/antigravity');
const { createHarness } = require('./claude-harness.cjs');
const { writeJson, readJson } = require('../src/shared/json-store');

const quota = JSON.stringify({ command: { data: { groups: [{ name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 0.8 }] }] } } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, overrides = {}) {
  const h = createHarness(); t.after(() => h.cleanup());
  const home = h.folder('google'), cliSettingsFile = path.join(h.folder('official-cli'), 'settings.json');
  writeJson(cliSettingsFile, { useG1Credits: true, toolPermission: 'request-review' });
  writeJson(path.join(home, 'google-account.json'), { models: [{ id: 'old-model', name: 'Old model' }], verifiedAt: Date.now(), error: 'invalid_grant' });
  writeJson(path.join(home, 'google-quota.json'), { latest: { windows: [{ label: 'Weekly', usedPercent: 20 }] }, history: [{}], error: 'offline' });
  const account = createGoogleAccount({ home, cliSettingsFile,
    runtime: () => ({ locate: () => ({ file: 'fake-agy' }), ensure: async () => ({ file: 'fake-agy' }) }),
    environment: () => ({}), settings: () => ({}), openLogin: async () => {}, clearCredentials: async () => {}, ...overrides });
  return { h, home, cliSettingsFile, account };
}
function assertSignedOut(account) {
  const state = account.state();
  assert.deepEqual(state.models, []);
  assert.equal(state.verifiedAt, null);
  assert.equal(state.awaitingVerification, false);
  assert.equal(state.signedOut, true);
  assert.equal(state.signingOut, false);
  assert.equal(state.usage.refreshing, false);
  assert.equal(state.usage.latest, null);
  assert.deepEqual(state.usage.history, []);
}

test('expired Google sign-in exits offline without a runtime, preserves settings and stops background refresh', async t => {
  const calls = [];
  const { account, cliSettingsFile } = fixture(t, {
    runtime: () => ({ locate: () => null, ensure: () => assert.fail('Sign-out must not install a runtime') }),
    run: () => assert.fail('Sign-out must not authenticate or check quota'),
    clearCredentials: spec => clearGoogleCredentials({ ...spec, platform: 'win32', execute: async (file, args, options) => { calls.push({ file, args, options }); } }),
  });
  const tokenFile = path.join(path.dirname(cliSettingsFile), 'antigravity-oauth-token');
  writeJson(cliSettingsFile, { useG1Credits: true, modelProvider: 'gemini', toolPermission: 'request-review' });
  const otherFile = path.join(path.dirname(cliSettingsFile), 'other-provider-token');
  fs.writeFileSync(tokenFile, 'isolated fake token'); fs.writeFileSync(otherFile, 'keep');
  await account.signOut();
  assertSignedOut(account);
  assert.equal(fs.existsSync(tokenFile), false);
  assert.equal(fs.readFileSync(otherFile, 'utf8'), 'keep');
  assert.deepEqual(readJson(cliSettingsFile), { useG1Credits: true, modelProvider: 'gemini', toolPermission: 'request-review' });
  assert.match(calls[0].args.at(-1), /clear-credentials\.ps1$/);
  assert.equal(calls[0].options.windowsHide, true);
  await account.refreshUsage({ force: false });
  await account.signOut();
  assertSignedOut(account);
  assert.equal(calls.length, 2);
});

test('sign-out cancels hung quota and model checks and ignores their late success', async t => {
  const pending = [];
  const { account } = fixture(t, { run: (_file, args, options) => {
    const result = deferred(); pending.push({ args, signal: options.signal, ...result }); return result.promise;
  } });
  const usage = account.refreshUsage(), models = account.refresh();
  await nextTurn(); assert.equal(pending.length, 2);
  await account.signOut();
  await Promise.all([usage, models]);
  assert.ok(pending.every(check => check.signal.aborted));
  assertSignedOut(account);
  pending.forEach(check => check.resolve(check.args[0] === 'models' ? 'old-model\tOld model' : quota));
  await nextTurn();
  assertSignedOut(account);
});

test('sign-out interrupts retry backoff rather than starting another attempt', async t => {
  const waiting = deferred(); let calls = 0, sleeps = 0;
  const { account } = fixture(t, { run: async () => { calls++; throw new Error('Unexpected EOF'); },
    sleep: () => { sleeps++; return waiting.promise; } });
  const refresh = account.refresh();
  await nextTurn(); assert.equal(sleeps, 1);
  await account.signOut(); await refresh;
  waiting.resolve(); await nextTurn();
  assert.equal(calls, 1);
  assertSignedOut(account);
});

test('sign-out prevents a pending runtime preparation from opening a login terminal later', async t => {
  const preparing = deferred(); let opened = 0;
  const { account } = fixture(t, { runtime: () => ({ locate: () => null, ensure: () => preparing.promise }),
    openLogin: async () => { opened++; } });
  const login = account.signIn();
  await account.signOut();
  assert.deepEqual(await login, { canceled: true });
  preparing.resolve({ file: 'fake-agy' }); await nextTurn();
  assert.equal(opened, 0);
  assertSignedOut(account);
});

test('duplicate sign-outs share cleanup and cannot start a new login or check during cleanup', async t => {
  const clearing = deferred(); let calls = 0;
  const { account } = fixture(t, { clearCredentials: () => { calls++; return clearing.promise; }, run: () => assert.fail('A check ran during sign-out') });
  const first = account.signOut(), second = account.signOut();
  await nextTurn(); assert.equal(calls, 1); assert.equal(account.state().signingOut, true);
  await account.refresh(); await account.refreshUsage();
  assert.deepEqual(await account.signIn(), { canceled: true });
  clearing.resolve(); await Promise.all([first, second]);
  assertSignedOut(account);
});

test('keyring cleanup failures are reported and can be retried without reviving the account', async t => {
  let calls = 0;
  const { account } = fixture(t, { clearCredentials: async () => { if (++calls === 1) throw new Error('keyring locked'); } });
  await assert.rejects(account.signOut(), /keyring locked/);
  assertSignedOut(account);
  assert.equal(account.state().error, 'keyring locked');
  await account.signOut(); assert.equal(calls, 2);
  assert.equal(account.state().error, '');
});

test('Google credential deletion uses the exact macOS and Linux keyring account and accepts an absent macOS item', async t => {
  const { cliSettingsFile } = fixture(t);
  const calls = [];
  const execute = async (file, args) => { calls.push({ file, args }); };
  await clearGoogleCredentials({ cliSettingsFile, platform: 'darwin', execute });
  await clearGoogleCredentials({ cliSettingsFile, platform: 'linux', execute });
  assert.deepEqual(calls, [
    { file: '/usr/bin/security', args: ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity'] },
    { file: 'secret-tool', args: ['clear', 'service', 'gemini', 'username', 'antigravity'] },
  ]);
  await clearGoogleCredentials({ cliSettingsFile, platform: 'darwin', execute: async () => { throw Object.assign(new Error('absent'), { code: 44 }); } });
  await assert.rejects(clearGoogleCredentials({ cliSettingsFile, platform: 'darwin', execute: async () => { throw Object.assign(new Error('locked'), { code: 36 }); } }), /Could not clear Google credentials/);
});

test('Antigravity sign-out stops active subscription sessions without blocking on busy work or stopping API sessions', async t => {
  const { h, cliSettingsFile } = fixture(t);
  let cleanups = 0;
  const service = createAntigravity({ dataDir: h.folder('service'), cliSettingsFile, loadConfig: () => ({}), saveConfig() {},
    runtimes: () => ({ locate: () => null }), environment: () => ({}), clearCredentials: async () => { cleanups++; },
    isBusy: () => true, onEvent() {}, onGoal() {}, log() {} });
  const subscription = { settings: { connection: 'subscription' }, running: true, kill() { this.dead = true; } };
  const api = { settings: { connection: 'api' }, running: true, kill() { assert.fail('API session stopped'); } };
  service.sessions.legacy = subscription;
  service.sessions.set({ conversationId: 'api-conversation' }, api);
  const result = await service.handlers['sign-out']();
  assert.equal(result.ok, true); assert.equal(result.signedOut, true);
  assert.equal(subscription.dead, true); assert.equal(subscription.cancelled, true);
  assert.equal(api.dead, undefined); assert.equal(cleanups, 1);
});

test('Antigravity sign-out IPC bypasses runtime preparation checks', async t => {
  let calls = 0;
  const h = createHarness(undefined, { clearGoogleCredentials: async () => { calls++; } });
  t.after(() => h.cleanup());
  const result = await h.call('antigravity-sign-out');
  assert.equal(result.ok, true); assert.equal(calls, 1);
});

test('aborting a real account probe terminates its child without waiting for its timeout', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const pending = runCli(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: process.env, timeout: 60000, signal: controller.signal });
  controller.abort(new DOMException('signed out', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
});
