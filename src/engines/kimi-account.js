'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { AcpSession } = require('./acp-session');
const { kimiEnvironment, managedKimiConfig } = require('./kimi-session');
const { readKimiQuota } = require('./kimi-quota');
const { readJson, writeJson } = require('../shared/json-store');

function parseLoginOutput(text) {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const match = clean.match(/Opening browser for Kimi device login: (https:\/\/[^\s]+)/);
  let verificationUrl = null;
  if (match) {
    try {
      const url = new URL(match[1]);
      if (url.protocol === 'https:' && ['auth.kimi.com', 'auth.kimi.ai', 'www.kimi.com', 'www.kimi.ai', 'kimi.com', 'kimi.ai'].includes(url.hostname)
          && !url.username && !url.password && !url.port) verificationUrl = url.href;
    } catch { /* Incomplete streaming URL. */ }
  }
  const userCode = clean.match(/enter code: ([A-Za-z0-9-]+)/)?.[1] || null;
  const expiresIn = Number(clean.match(/Code expires in (\d+)s\./)?.[1]) || null;
  return { verificationUrl, userCode, expiresIn };
}
function accountModels(config, options = []) {
  const labels = new Map();
  const visit = rows => { for (const row of rows || []) { if (row.value) labels.set(row.value, row.name || row.value); if (row.options) visit(row.options); } };
  visit(options.find(row => row.id === 'model')?.options);
  return Object.entries(config.models).map(([id, model]) => ({ id, name: labels.get(id) || model.display_name || model.model || id,
    isDefault: config.default_model === id, contextWindow: model.max_context_size }));
}

// Kimi's official CLI owns the device flow, refresh tokens and logout. Only
// public model metadata and the temporary authorization link reach the UI.
function createKimiAccount({ home, runtime, ensureRuntime, node, environment = () => process.env, region = () => 'mainland-cn',
  isBusy = () => false, onChange = () => {}, onModels = () => {}, openExternal = async () => {}, spawnProcess = spawn,
  createClient, queryQuota = readKimiQuota, now = () => Date.now(), loginTimeoutMs = 15 * 60 * 1000 }) {
  const stateFile = path.join(home, 'account-state.json');
  let saved = readJson(stateFile, { account: null, models: [], verifiedAt: null });
  let login = null, refreshing = null, signingOut = null, closed = false;
  let quotaPending = null, quotaController = null;
  const clients = new Set();
  const empty = () => ({ account: null, models: [], verifiedAt: null, usage: null });
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
    if (closed) throw new Error('Kimi account service is shutting down');
    if (isBusy()) throw new Error('Stop the Kimi response or goal before changing the account');
  }
  function newClient() {
    const file = runtime()?.file;
    if (!file) throw new Error('Download Kimi Code in Settings → Runtime first');
    fs.mkdirSync(home, { recursive: true });
    const spec = { args: [file, 'acp'], env: kimiEnvironment(home, environment()) };
    const client = createClient ? createClient(spec) : new AcpSession({ name: 'Kimi account', exe: node(), spec, settings: { cwd: home }, opts: {},
      spawn: spawnProcess, log: () => {}, onEvent: () => {}, onSessionId: () => {}, onResult: () => {} });
    try { client.start(); clients.add(client); return client; }
    catch (error) { void client.shutdown(); throw error; }
  }
  async function initialize(client) {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Camellia', version: '0.1.0' } });
  }
  async function refreshUsage({ force = true } = {}) {
    if (closed || !saved.account || login || signingOut) return state();
    if (quotaPending) { await quotaPending; return state(); }
    if (!force && saved.usage?.checkedAt && now() - Date.parse(saved.usage.checkedAt) < 15 * 60000) return state();
    const account = saved.account;
    const controller = new AbortController(); quotaController = controller;
    const task = (async () => {
      const checkedAt = new Date(now()).toISOString();
      try {
        managedKimiConfig(home);
        const file = runtime()?.file;
        if (!file) throw new Error('Download Kimi Code in Settings → Runtime first');
        const result = await queryQuota({ home, file, node: node(), environment: environment(), signal: controller.signal });
        if (closed || saved.account !== account || controller.signal.aborted) return;
        const latest = { ...result, at: checkedAt }, history = [...(saved.usage?.history || [])];
        const sample = { at: checkedAt, balances: result.balances, windows: result.windows };
        const bucket = value => Math.floor(Date.parse(value) / (15 * 60000));
        if (history.length && bucket(history.at(-1).at) === bucket(checkedAt)) history[history.length - 1] = sample;
        else history.push(sample);
        publish({ usage: { status: 'ok', latest, checkedAt, error: null,
          history: history.filter(row => Date.parse(row.at) >= now() - 30 * 86400000).slice(-3000) } });
      } catch {
        if (!closed && saved.account === account && !controller.signal.aborted) publish({ usage: { ...saved.usage, checkedAt, status: 'error',
          error: 'Could not load Kimi quota. Check your connection or refresh your account.' } });
      }
    })();
    quotaPending = task; onChange(state());
    try { await task; } finally { quotaPending = null; quotaController = null; if (!closed) onChange(state()); }
    return state();
  }
  async function refresh() {
    idle();
    if (signingOut) throw new Error('Wait for Kimi sign-out to finish');
    if (login) throw new Error('Complete or cancel Kimi sign-in first');
    if (refreshing) { await refreshing; return state(); }
    const task = (async () => {
      let client, probeId;
      try {
        // Never treat a configured API provider as a signed-in subscription.
        managedKimiConfig(home);
        client = newClient(); await initialize(client);
        await client.request('authenticate', { methodId: 'login' });
        const probeDir = path.join(home, 'account-check'); fs.mkdirSync(probeDir, { recursive: true });
        const probe = await client.request('session/new', { cwd: probeDir, mcpServers: [] });
        probeId = probe.sessionId;
        const config = managedKimiConfig(home), models = accountModels(config, probe.configOptions);
        const host = new URL(config.providers['managed:kimi-code'].base_url).hostname;
        publish({ account: { name: 'Kimi Code', region: host.endsWith('.ai') ? 'global' : 'mainland-cn' }, models,
          verifiedAt: new Date().toISOString(), error: models.length ? null : 'Signed in, but no models are available. Retry sign-in or check your subscription.' });
        onModels(models);
      } catch (error) {
        publish({ ...empty(), error: 'Could not verify the Kimi subscription. Sign in again, or check your network and account access.' });
      } finally {
        if (client) {
          if (probeId) { try { await client.request('session/delete', { sessionId: probeId }, 5000); } catch { /* isolated empty probe */ } }
          await client.shutdown(); clients.delete(client);
        }
      }
      return state();
    })();
    refreshing = task; onChange(state());
    try { await task; } finally { if (refreshing === task) refreshing = null; if (!closed) onChange(state()); }
    await refreshUsage();
    return state();
  }
  async function signIn() {
    idle();
    if (signingOut) throw new Error('Wait for Kimi sign-out to finish');
    if (refreshing) throw new Error('Wait for the Kimi account check to finish');
    if (login) return state();
    const attempt = { details: null, proc: null, stopping: false };
    quotaController?.abort();
    login = attempt; publish({ error: null, usage: null });
    try {
      await ensureRuntime();
      if (closed || login !== attempt) return state();
      idle();
      fs.mkdirSync(home, { recursive: true });
      const file = runtime()?.file;
      if (!file) throw new Error('Kimi runtime is unavailable');
      const proc = spawnProcess(node(), [file, 'login', '--region', region()], { cwd: home,
        env: kimiEnvironment(home, environment()), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      attempt.proc = proc;
      attempt.done = new Promise(resolve => proc.once('close', resolve));
      const decoder = new StringDecoder('utf8'); let output = '';
      proc.stderr.on('data', data => {
        if (login !== attempt || attempt.stopping) return;
        output = (output + decoder.write(data)).slice(-16384);
        let details; try { details = parseLoginOutput(output); } catch { return; }
        if (details.verificationUrl && details.userCode) {
          attempt.details = { verificationUrl: details.verificationUrl, userCode: details.userCode,
            expiresAt: attempt.details?.expiresAt || (details.expiresIn ? Date.now() + details.expiresIn * 1000 : null) };
          if (!closed) onChange(state());
        }
      });
      // Drain stdout but never log either stream: OAuth output can contain secrets.
      proc.stdout.on('data', () => {});
      proc.once('error', () => { if (login === attempt) { login = null; publish({ error: 'Could not start Kimi sign-in. Check the installed runtime.' }); } });
      const timer = setTimeout(() => { void cancelLogin('Kimi sign-in timed out. Start sign-in again.'); }, loginTimeoutMs);
      proc.once('close', code => {
        clearTimeout(timer);
        if (login !== attempt) return;
        login = null;
        if (attempt.stopping || closed) return;
        if (code === 0) void refresh().catch(() => publish({ error: 'Sign-in finished. Stop the Kimi response, then refresh the account to load its models.' }));
        else publish({ error: 'Kimi sign-in was cancelled or failed. Retry and check the selected login region.' });
      });
      return state();
    } catch (error) {
      if (login !== attempt) return state();
      login = null;
      if (error.code === 'DOWNLOAD_CANCELLED') { publish({ error: null }, false); return { ...state(), canceled: true }; }
      publish({ error: 'Could not start Kimi sign-in. Check the runtime and network connection.' });
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
    if (refreshing) throw new Error('Wait for the Kimi account check to finish');
    quotaController?.abort();
    const task = (async () => {
      let client;
      try {
        await cancelLogin();
        if (closed) return;
        client = newClient(); await initialize(client); await client.request('logout', {});
        publish({ ...empty(), error: null });
      } catch { publish({ error: 'Could not sign out of Kimi. Retry after checking the runtime.' }); }
      finally { if (client) { await client.shutdown(); clients.delete(client); } }
    })();
    signingOut = task; onChange(state());
    try { await task; } finally { signingOut = null; if (!closed) onChange(state()); }
    return state();
  }
  return { state, refresh, refreshUsage, signIn, cancelLogin, signOut,
    get active() { return Boolean(login || refreshing || signingOut || quotaPending || clients.size); },
    async openLogin() { const url = login?.details?.verificationUrl; if (!url) throw new Error('Start Kimi sign-in first'); await openExternal(url); return state(); },
    async shutdown() { closed = true; quotaController?.abort(); await cancelLogin(); await Promise.allSettled([...clients].map(client => client.shutdown())); await Promise.allSettled([refreshing, signingOut, quotaPending]); },
  };
}
module.exports = { createKimiAccount, parseLoginOutput, accountModels };
