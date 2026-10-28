'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { GrokSession, grokEnvironment, GROK_STARTUP_TIMEOUT_MS } = require('./grok-session');
const { normalizeGrokBilling, normalizeGrokModels } = require('./grok-quota');
const { readJson, writeJson } = require('../shared/json-store');

function parseGrokLoginOutput(text) {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  let verificationUrl = null;
  try {
    const url = new URL(clean.match(/https:\/\/accounts\.x\.ai\/oauth2\/device\?[^\s]+/)?.[0]);
    if (url.protocol === 'https:' && url.hostname === 'accounts.x.ai' && !url.username && !url.password && !url.port) verificationUrl = url.href;
  } catch {}
  const userCode = clean.match(/Confirm this code in your browser:\s*([A-Z0-9-]+)/i)?.[1] || null;
  return { verificationUrl, userCode };
}

function createGrokAccount({ home, runtime, ensureRuntime, environment = () => process.env, getProxyUrl = () => '', isBusy = () => false,
  onChange = () => {}, onModels = () => {}, openExternal = async () => {}, spawnProcess = spawn,
  createClient, now = () => Date.now(), loginTimeoutMs = 15 * 60 * 1000 }) {
  const stateFile = path.join(home, 'account-state.json');
  let saved = readJson(stateFile, { account: null, models: [], verifiedAt: null, usage: null });
  let login = null, refreshing = null, signingOut = null, quotaPending = null, closed = false;
  const clients = new Set();
  const empty = () => ({ account: null, models: [], verifiedAt: null, usage: null });
  const accountEnvironment = () => grokEnvironment(home, environment(), getProxyUrl(), { subscription: true });
  function state() {
    return { ...saved, installed: Boolean(runtime()), loginPending: Boolean(login), refreshing: Boolean(refreshing), signingOut: Boolean(signingOut),
      login: login?.details || null, usage: { ...saved.usage, refreshing: Boolean(quotaPending) } };
  }
  function publish(patch, persist = true) {
    saved = { ...saved, ...patch };
    if (persist) writeJson(stateFile, saved);
    if (!closed) onChange(state());
  }
  function idle() {
    if (closed) throw new Error('Grok account service is shutting down');
    if (isBusy()) throw new Error('Stop the Grok response or goal before changing the account');
  }
  function newClient() {
    const file = runtime()?.file;
    if (!file) throw new Error('Download Grok Build in Settings → Engine Settings first');
    fs.mkdirSync(home, { recursive: true });
    const spec = { args: ['--no-auto-update', 'agent', 'stdio'], env: accountEnvironment() };
    const client = createClient ? createClient(spec) : new GrokSession({ name: 'Grok account', exe: file, spec, settings: { cwd: home }, opts: {},
      spawn: spawnProcess, log: () => {}, onEvent: () => {}, onSessionId: () => {}, onResult: () => {} });
    try { client.start(); clients.add(client); return client; }
    catch (error) { void client.shutdown(); throw error; }
  }
  async function authenticate(client) {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Camellia', version: '1.0.1' } }, GROK_STARTUP_TIMEOUT_MS);
    await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
  }
  async function billing(client) {
    const raw = await client.request('_x.ai/billing', {});
    let topup = null;
    try { topup = await client.request('_x.ai/auto-topup-rule', {}); } catch {}
    return normalizeGrokBilling(raw, topup);
  }
  async function refreshUsage({ force = true } = {}) {
    if (closed || !saved.account || login || signingOut) return state();
    if (quotaPending) { await quotaPending; return state(); }
    if (!force && saved.usage?.checkedAt && now() - Date.parse(saved.usage.checkedAt) < 15 * 60000) return state();
    const account = saved.account;
    quotaPending = (async () => {
      const checkedAt = new Date(now()).toISOString();
      let client;
      try {
        client = newClient(); await authenticate(client);
        const latest = { ...await billing(client), at: checkedAt };
        if (closed || saved.account !== account) return;
        publish({ account: { ...saved.account, plan: latest.plan || saved.account.plan }, usage: { status: 'ok', latest, checkedAt, error: null } });
      } catch {
        if (!closed && saved.account === account) publish({ usage: { ...saved.usage, checkedAt, status: 'error',
          error: 'Could not load Grok quota. Check your connection or refresh your account.' } });
      } finally { if (client) { await client.shutdown(); clients.delete(client); } }
    })().finally(() => { quotaPending = null; if (!closed) onChange(state()); });
    onChange(state());
    await quotaPending;
    return state();
  }
  async function refresh() {
    idle();
    if (signingOut) throw new Error('Wait for Grok sign-out to finish');
    if (login) throw new Error('Complete or cancel Grok sign-in first');
    if (refreshing) { await refreshing; return state(); }
    refreshing = (async () => {
      let client;
      try {
        client = newClient(); await authenticate(client);
        const models = normalizeGrokModels(await client.request('_x.ai/models/list', {}));
        const latest = { ...await billing(client), at: new Date(now()).toISOString() };
        if (closed) return;
        publish({ account: { name: 'Grok', plan: latest.plan || 'Grok' }, models, verifiedAt: new Date(now()).toISOString(),
          usage: { status: 'ok', latest, checkedAt: latest.at, error: null },
          error: models.length ? null : 'Signed in, but no Grok models are available. Retry sign-in or check your subscription.' });
        onModels(models);
      } catch {
        if (!closed) {
          const error = 'Could not verify the Grok subscription. Sign in again, or check your network and account access.';
          publish({ error, usage: { ...saved.usage, status: 'error', checkedAt: new Date(now()).toISOString(), error } });
        }
      } finally { if (client) { await client.shutdown(); clients.delete(client); } }
    })().finally(() => { refreshing = null; if (!closed) onChange(state()); });
    onChange(state());
    await refreshing;
    return state();
  }
  async function signIn() {
    idle();
    if (signingOut) throw new Error('Wait for Grok sign-out to finish');
    if (refreshing) throw new Error('Wait for the Grok account check to finish');
    if (login) return state();
    const attempt = { details: null, proc: null, stopping: false };
    login = attempt; publish({ error: null });
    try {
      await ensureRuntime();
      if (closed || login !== attempt) return state();
      idle();
      fs.mkdirSync(home, { recursive: true });
      const file = runtime()?.file;
      if (!file) throw new Error('Grok runtime is unavailable');
      const proc = spawnProcess(file, ['login', '--device-auth'], { cwd: home,
        env: accountEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      attempt.proc = proc;
      attempt.done = new Promise(resolve => proc.once('close', resolve));
      const decoder = new StringDecoder('utf8'); let output = '';
      const read = data => {
        if (login !== attempt || attempt.stopping) return;
        output = (output + decoder.write(data)).slice(-16384);
        const details = parseGrokLoginOutput(output);
        if (details.verificationUrl && details.userCode) {
          attempt.details = details;
          if (!closed) onChange(state());
        }
      };
      proc.stdout.on('data', read); proc.stderr.on('data', read);
      proc.once('error', () => { if (login === attempt) { login = null; publish({ error: 'Could not start Grok sign-in. Check the installed runtime.' }); } });
      const timer = setTimeout(() => { void cancelLogin('Grok sign-in timed out. Start sign-in again.'); }, loginTimeoutMs);
      proc.once('close', code => {
        clearTimeout(timer);
        if (login !== attempt) return;
        login = null;
        if (attempt.stopping || closed) return;
        if (code === 0) void refresh().catch(() => publish({ error: 'Sign-in finished. Stop the Grok response, then refresh the account.' }));
        else publish({ error: 'Grok sign-in was cancelled or failed. Retry and check your network connection.' });
      });
      return state();
    } catch (error) {
      if (login !== attempt) return state();
      login = null;
      if (error.code === 'DOWNLOAD_CANCELLED') { publish({ error: null }, false); return { ...state(), canceled: true }; }
      publish({ error: 'Could not start Grok sign-in. Check the runtime and network connection.' });
      return state();
    }
  }
  async function cancelLogin(message = null) {
    const attempt = login;
    if (attempt) {
      attempt.stopping = true;
      if (attempt.proc) { attempt.proc.kill(); await attempt.done; }
      if (login === attempt) login = null;
    }
    publish({ error: message }, false); return state();
  }
  async function signOut() {
    idle();
    if (signingOut) { await signingOut; return state(); }
    if (refreshing) throw new Error('Wait for the Grok account check to finish');
    signingOut = (async () => {
      await cancelLogin();
      const file = runtime()?.file;
      if (file) {
        const proc = spawnProcess(file, ['logout'], { cwd: home, env: accountEnvironment(), windowsHide: true, stdio: 'ignore' });
        await new Promise(resolve => {
          const timer = setTimeout(() => { proc.kill(); }, 15000);
          proc.once('error', () => { clearTimeout(timer); resolve(); });
          proc.once('close', () => { clearTimeout(timer); resolve(); });
        });
      }
      if (!closed) {
        try { fs.rmSync(path.join(home, 'auth.json'), { force: true }); } catch {}
        publish({ ...empty(), error: null });
      }
    })().finally(() => { signingOut = null; if (!closed) onChange(state()); });
    onChange(state());
    await signingOut;
    return state();
  }
  return { state, refresh, refreshUsage, signIn, cancelLogin, signOut,
    get active() { return Boolean(login || refreshing || signingOut || quotaPending || clients.size); },
    get changingAccount() { return Boolean(login || refreshing || signingOut); },
    async openLogin() { const url = login?.details?.verificationUrl; if (!url) throw new Error('Start Grok sign-in first'); await openExternal(url); return state(); },
    async shutdown() { closed = true; await cancelLogin(); await Promise.allSettled([...clients].map(client => client.shutdown())); await Promise.allSettled([refreshing, signingOut, quotaPending]); },
  };
}

module.exports = { createGrokAccount, parseGrokLoginOutput };
