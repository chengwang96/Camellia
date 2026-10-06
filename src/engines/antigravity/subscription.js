'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { readJson, writeJson } = require('../../shared/json-store');

// A blank proxy setting means "use the Windows system proxy", so Google
// sign-in also works on networks where oauth2.googleapis.com is unreachable
// directly. Returns '' on other platforms or when no system proxy is enabled.
function systemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/reg.exe');
    const out = execFileSync(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return '';
    const server = (out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i) || [])[1] || '';
    if (!server) return '';
    if (!server.includes('=')) return 'http://' + server.replace(/^https?:\/\//, '');
    const entries = Object.fromEntries(server.split(';').map(part => part.split('=')));
    const picked = entries.https || entries.http || '';
    return picked ? 'http://' + picked.replace(/^https?:\/\//, '') : '';
  } catch { return ''; }
}

// Google account authentication belongs to the official CLI. Never convert its
// OAuth credentials into API keys or fall back to a paid API provider.
const API_ENV = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ADC_AUTH'];
function subscriptionEnvironment(env, proxyUrl = '') {
  const next = { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  for (const key of Object.keys(next)) if (API_ENV.includes(key.toUpperCase())) delete next[key];
  const managedNetwork = env.CAMELLIA_NETWORK_MODE !== undefined;
  const proxy = managedNetwork
    ? (env.CAMELLIA_SUBSCRIPTION_PROXY ?? env.CAMELLIA_NETWORK_PROXY ?? '')
    : proxyUrl || systemProxy();
  if (managedNetwork || proxy) {
    for (const key of Object.keys(next)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete next[key];
    Object.assign(next, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: '', NO_PROXY: proxy ? 'localhost,127.0.0.1,::1' : '*' });
  }
  return next;
}

function parseModels(output) {
  const models = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([\w.-]+)\t(.+)$/);
    if (match) models.set(match[1], { id: match[1], name: match[2].trim() });
  }
  return [...models.values()];
}

// The Google CLI exposes every reasoning effort as its own model
// (gemini-3.8-flash-high, gemini-3.8-flash-medium, ...). Camellia follows the
// CLI's own /model picker: one base model with a reasoning-effort timeline.
// Only levels the CLI documents are recognized, so names such as
// "Claude Sonnet 4.6 (Thinking)" stay whole.
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_RANK = new Map(EFFORT_LEVELS.map((level, index) => [level, index]));

function effortSplit(id, name) {
  const match = String(id || '').match(/^(.*?)[-_]([a-z]+)$/i);
  if (!match) return null;
  const effort = match[2].toLowerCase();
  if (!EFFORT_RANK.has(effort) || !match[1]) return null;
  // A "(Medium)" style suffix must agree with the ID; otherwise this is a
  // different model that merely ends in the same word.
  const suffix = String(name || '').match(/^(.*?)\s*[(\[]\s*([a-z]+)\s*[)\]]\s*$/i);
  if (suffix && suffix[2].toLowerCase() !== effort) return null;
  return { id: match[1], name: (suffix ? suffix[1] : String(name || '')).trim() || match[1], effort };
}

// Collapse the per-effort catalog rows into base models that carry their
// levels. Families with a single row keep their original identity, so Claude,
// GPT-OSS and any future un-suffixed model are untouched.
function groupModels(models) {
  const rows = (models || []).map(model => ({ model, split: effortSplit(model.id, model.name) }));
  const families = new Map();
  for (const { model, split } of rows) {
    if (!split) continue;
    const key = split.id.toLowerCase();
    const family = families.get(key) || { id: split.id, name: split.name, variants: new Map() };
    if (!family.variants.has(split.effort)) family.variants.set(split.effort, model.id);
    families.set(key, family);
  }
  const grouped = new Set([...families.entries()].filter(([, family]) => family.variants.size > 1).map(([key]) => key));
  const output = [], seen = new Set();
  for (const { model, split } of rows) {
    const key = split ? split.id.toLowerCase() : '';
    if (!key || !grouped.has(key)) { output.push(model); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    const family = families.get(key);
    // The CLI lists the strongest effort first; keep it as the family default
    // and present the picker in ascending order.
    const catalogOrder = [...family.variants.keys()];
    output.push({ id: family.id, name: family.name,
      supportedReasoningEfforts: catalogOrder.slice().sort((a, b) => EFFORT_RANK.get(a) - EFFORT_RANK.get(b))
        .map(reasoningEffort => ({ reasoningEffort })),
      defaultReasoningEffort: catalogOrder[0],
      modelIds: Object.fromEntries(family.variants) });
  }
  return output;
}

function matchFamily(models, id) {
  return (models || []).find(entry => entry.id === id || entry.modelIds && Object.values(entry.modelIds).includes(id)) || null;
}

// Map a saved ID onto its base family, keeping any explicit level. A legacy
// concrete ID (gemini-3.8-flash-high) implies its own level.
function normalizeSelection(models, model, thinking) {
  const id = String(model || ''), family = matchFamily(models, id);
  if (!family) return { model: id, thinking: thinking || '' };
  const implied = family.modelIds ? Object.keys(family.modelIds).find(level => family.modelIds[level] === id) : '';
  return { model: family.id, thinking: thinking || implied || '' };
}

// The value actually handed to the CLI: an unset level falls back to the
// family's default, because these base models require an explicit effort. A
// level the family does not offer (stale when switching between families) is
// likewise replaced, so the CLI never receives an unsupported --effort.
function effectiveSelection(models, model, thinking) {
  const value = normalizeSelection(models, model, thinking);
  const family = matchFamily(models, value.model);
  if (family) {
    const supported = (family.supportedReasoningEfforts || []).map(level => level.reasoningEffort || level);
    if (!value.thinking || !supported.includes(value.thinking)) value.thinking = family.defaultReasoningEffort || '';
  }
  return value;
}

function runCli(file, args, { env, cwd, timeout = 45000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => {
      proc.kill();
      const error = new Error('Google account check timed out. Check the network connection and retry.');
      // A stalled run is the signature of the CLI waiting on its own sign-in
      // page, so callers must not launch it again.
      error.timedOut = true;
      reject(error);
    }, timeout);
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(describeCliFailure(errors, output, code)));
      else resolve(output);
    });
  });
}

// A background check can fail for a transient reason while the Google login is
// still valid, so it retries a few times before the failure reaches the account
// card. Two outcomes must never be retried, because the CLI opens its own
// sign-in page for them and each retry would open another one: a stalled run,
// and a credential the CLI already rejected. Everything else (a dropped
// connection, a proxy hiccup) is retried with a short backoff.
const CLI_ATTEMPTS = 3;
const CLI_RETRY_DELAY_MS = 1500;
function retryableCliFailure(error) {
  if (!error || error.timedOut || isProfilePictureFailure(error)) return false;
  return !/sign-in has expired|no valid auth|not authenticated|authentication (?:failed|required|failed or timed out)|unauthorized|invalid_grant/i.test(String(error.message || ''));
}
async function runCliWithRetry(run, file, args, options, { attempts = CLI_ATTEMPTS, delay = CLI_RETRY_DELAY_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await run(file, args, options); }
    catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryableCliFailure(error)) break;
      await sleep(delay * attempt);
    }
  }
  throw lastError;
}

// A headless run that cannot use the stored credential stops instead of
// opening a browser. Report that as a normal sign-in problem so the account
// card offers the same "sign in again" guidance as any rejected credential.
function describeCliFailure(errors, output, code) {
  const text = (errors || '').trim() || (output || '').trim();
  if (/headless auth|no valid auth/i.test(text)) return 'Google sign-in has expired or is invalid. Sign in again and retry.';
  return text || `Antigravity CLI exited (${code})`;
}

function isProfilePictureFailure(error) {
  return /profile picture/i.test(String(error || ''));
}

// Background quota and model checks ask the CLI for its non-interactive print
// mode. The flag is only a hint: the official CLI still opens its own sign-in
// page when silent auth fails, so this does not by itself suppress the browser.
// The retry above and the deliberate absence of auto-refresh escalation are what
// keep an unattended refresh from interrupting the user. The explicit "Sign in"
// button still launches the CLI interactively.
function headlessEnvironment(env) {
  return { ...env, AGY_CLI_NONINTERACTIVE_HEADLESS: 'true' };
}

// The official CLI owns the Google credential, so quota is read through its
// documented non-interactive `/quota` command instead of the account API. The
// command runs zero turns and spends no allowance; it only reloads the same
// summary the CLI's own status line shows.
const WINDOW_LABELS = { weekly: 'Weekly', '5h': '5-hour', fiveHour: '5-hour', five_hour: '5-hour', daily: 'Daily' };
function windowLabel(window, fallback = 'Usage') {
  if (!window) return fallback;
  return WINDOW_LABELS[window] || String(window).replace(/_/g, ' ');
}
function normalizeGoogleQuota(groups) {
  const windows = [];
  for (const group of groups || []) {
    // Keep each model group's independent windows distinct in quota history.
    const groupId = String(group.name || 'group').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
    for (const bucket of group.buckets || []) {
      const remaining = bucket.remaining_fraction;
      if (!Number.isFinite(remaining)) continue;
      // Round off float32 noise from the CLI's remaining_fraction.
      const usedPercent = Math.round(Math.max(0, Math.min(100, (1 - remaining) * 100)) * 100) / 100;
      windows.push({ id: groupId + ':' + (bucket.id || bucket.window || windows.length),
        label: (group.name ? group.name + ' · ' : '') + windowLabel(bucket.window, bucket.name || 'Usage'),
        usedPercent, resetsAt: bucket.reset_time || null });
    }
  }
  if (!windows.length) throw new Error('The Google account returned no quota windows.');
  return { balances: [], windows, modelUsage: [] };
}
function parseGoogleQuota(output) {
  if (isProfilePictureFailure(output)) throw new Error('Google account profile picture unavailable.');
  let parsed;
  try { parsed = JSON.parse(String(output).trim()); } catch { throw new Error('The official CLI returned an unreadable quota response.'); }
  const groups = parsed?.command?.data?.groups;
  if (!Array.isArray(groups)) throw new Error('The Google account returned no quota information.');
  return normalizeGoogleQuota(groups);
}

function requireGoogleProvider(settingsFile) {
  const value = readJson(settingsFile, {});
  if (value.modelProvider && value.modelProvider !== 'antigravity') {
    throw new Error('The official CLI is configured for an API provider. Use “Sign in with Google” in Antigravity settings to switch it to your Google account.');
  }
}

function loginScript(file, { platform, exe, proxyUrl = '', networkMode }) {
  const quote = value => platform === 'win32' ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'";
  const effective = networkMode ? proxyUrl : proxyUrl || systemProxy();
  const proxy = effective ? { HTTP_PROXY: effective, HTTPS_PROXY: effective, ALL_PROXY: '', NO_PROXY: 'localhost,127.0.0.1,::1' }
    : networkMode ? { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' } : {};
  const lines = platform === 'win32'
    ? ["$Host.UI.RawUI.WindowTitle = 'Camellia — Google sign-in'", ...API_ENV.map(key => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`),
      "$env:AGY_CLI_DISABLE_AUTO_UPDATE = 'true'", ...Object.entries(proxy).map(([key, value]) => `$env:${key} = ${quote(value)}`),
      `& ${quote(exe)}`, "Read-Host 'Return to Camellia and refresh the Google account. Press Enter to close'" ]
    : ['#!/bin/sh', 'unset ' + API_ENV.join(' '), 'export AGY_CLI_DISABLE_AUTO_UPDATE=true',
      ...Object.entries(proxy).map(([key, value]) => `export ${key}=${quote(value)}`), `exec ${quote(exe)}`];
  // Windows PowerShell 5.1 needs a BOM for non-ASCII installation paths.
  fs.writeFileSync(file, (platform === 'win32' ? '\uFEFF' : '') + lines.join('\n') + '\n', { mode: 0o700 });
}

function createGoogleAccount({ home, cliSettingsFile, runtime, environment, settings, openLogin, run = runCli, now = Date.now, onChange = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const cacheFile = path.join(home, 'google-account.json');
  const usageFile = path.join(home, 'google-quota.json');
  let quotaPending = null;
  let accountVersion = 0;
  const readUsage = () => readJson(usageFile, { latest: null, history: [], checkedAt: null, status: null, error: null });
  const writeUsage = patch => { const next = { ...readUsage(), ...patch }; writeJson(usageFile, next); return next; };
  const state = () => {
    const cached = { models: [], verifiedAt: null, error: '', ...readJson(cacheFile, {}) };
    if (isProfilePictureFailure(cached.error)) cached.error = '';
    const checkedAt = new Date(cached.verifiedAt).getTime();
    // A failed refresh records its error but keeps the last good catalog, so a
    // signed-in account never degrades into "no models": the composer would lose
    // its list even though the CLI still knows it. Such a cache reads as an
    // error above a still-usable model list rather than as an unverified account.
    const verification = cached.error ? (cached.models.length && Number.isFinite(checkedAt) ? 'stale-error' : 'error') : cached.awaitingVerification ? 'pending'
      : !cached.models.length || !cached.verifiedAt || !Number.isFinite(checkedAt) ? 'unverified'
      : now() - checkedAt >= 24 * 60 * 60 * 1000 ? 'stale' : 'verified';
    // Grouping is idempotent, so a cache written before families existed is
    // upgraded on read instead of waiting for the next manual refresh.
    const usage = readUsage();
    if (isProfilePictureFailure(usage.error)) {
      usage.error = null;
      if (!usage.latest) usage.status = null;
    }
    return { ...cached, models: groupModels(cached.models), verification, usage: { ...usage, refreshing: Boolean(quotaPending) },
      installed: Boolean(runtime().locate('antigravity', 'subscription')) };
  };
  async function refreshUsage({ force = true } = {}) {
    if (quotaPending) { await quotaPending; return state(); }
    // The CLI reloads quota on its own, so a very recent reading is reused.
    if (!force && readUsage().checkedAt && now() - Date.parse(readUsage().checkedAt) < 3 * 60000) return state();
    const version = accountVersion;
    const request = Promise.resolve().then(async () => {
      const checkedAt = new Date(now()).toISOString();
      try {
        const found = runtime().locate('antigravity', 'subscription');
        if (!found) throw new Error('Download the Antigravity Google subscription runtime first.');
        requireGoogleProvider(cliSettingsFile);
        fs.mkdirSync(home, { recursive: true });
        // The structured command response never starts an agent turn.
        const output = await runCliWithRetry(run, found.file, ['-p', '/quota', '--output-format', 'json'], { env: headlessEnvironment(subscriptionEnvironment(environment(), settings().proxyUrl)), cwd: home }, { sleep });
        const result = parseGoogleQuota(output);
        if (version !== accountVersion) return;
        const latest = { ...result, at: checkedAt }, previous = readUsage();
        const history = [...(previous.history || []), { at: checkedAt, balances: result.balances, windows: result.windows }]
          .filter(sample => Date.parse(sample.at) >= now() - 30 * 86400000).slice(-3000);
        writeUsage({ status: 'ok', latest, history, checkedAt, error: null });
      } catch (error) {
        if (version !== accountVersion) return;
        const previous = readUsage();
        if (isProfilePictureFailure(error)) {
          writeUsage({ status: previous.latest ? 'stale' : null, latest: previous.latest, history: previous.history,
            checkedAt: previous.checkedAt, error: null });
          return;
        }
        // Keep the last successful reading visible; the error explains the failure.
        writeUsage({ status: previous.latest ? 'stale' : 'error', latest: previous.latest, history: previous.history,
          checkedAt, error: error.message || 'Could not load Google quota. Check the connection and retry.' });
      }
    });
    quotaPending = request;
    onChange();
    try { await request; } finally {
      if (quotaPending === request) quotaPending = null;
      onChange();
    }
    return state();
  }
  async function refresh() {
    fs.mkdirSync(home, { recursive: true });
    try {
      const found = runtime().locate('antigravity', 'subscription');
      if (!found) throw new Error('Download the Antigravity Google subscription runtime first.');
      requireGoogleProvider(cliSettingsFile);
      const output = await runCliWithRetry(run, found.file, ['models'], { env: headlessEnvironment(subscriptionEnvironment(environment(), settings().proxyUrl)), cwd: home }, { sleep });
      const models = groupModels(parseModels(output));
      if (!models.length) {
        if (isProfilePictureFailure(output)) throw new Error('Google account profile picture unavailable.');
        throw new Error('The Google account returned no available models.');
      }
      writeJson(cacheFile, { models, verifiedAt: now(), error: '', awaitingVerification: false });
    } catch (error) {
      // Keep the models and verification time the account already proved. Only a
      // successful refresh replaces the catalog; a transient network or CLI
      // failure must not wipe it, or every retry would look identical to a
      // signed-out account and the saved model would become unselectable.
      const previous = readJson(cacheFile, {});
      if (isProfilePictureFailure(error)) {
        writeJson(cacheFile, { models: previous.models || [], verifiedAt: previous.verifiedAt ?? null,
          error: '', awaitingVerification: false });
        onChange();
        return state();
      }
      writeJson(cacheFile, { models: previous.models || [], verifiedAt: previous.verifiedAt ?? null,
        error: error.message, awaitingVerification: false });
      onChange();
      throw error;
    }
    // Models and quota come from the same sign-in; a successful check also
    // refreshes the two limit groups shown on the account.
    await refreshUsage();
    return state();
  }
  async function signIn() {
    const found = await runtime().ensure('antigravity', 'subscription');
    const config = readJson(cliSettingsFile, {});
    // Returning the CLI to its default provider enables its official Google
    // sign-in. Preserve all other preferences, including the user's credit choice.
    if (config.modelProvider) {
      if (!fs.existsSync(cliSettingsFile + '.workbench.bak')) fs.copyFileSync(cliSettingsFile, cliSettingsFile + '.workbench.bak');
      delete config.modelProvider;
      writeJson(cliSettingsFile, config);
    }
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, process.platform === 'win32' ? 'google-sign-in.ps1' : 'google-sign-in.command');
    const env = environment();
    loginScript(file, { platform: process.platform, exe: found.file,
      proxyUrl: env.CAMELLIA_NETWORK_MODE ? env.CAMELLIA_SUBSCRIPTION_PROXY ?? env.CAMELLIA_NETWORK_PROXY : settings().proxyUrl,
      networkMode: env.CAMELLIA_NETWORK_MODE });
    await openLogin(file, subscriptionEnvironment(environment(), settings().proxyUrl));
    // A new CLI sign-in can select a different account. Neither saved quota
    // nor an in-flight response from the old sign-in belongs to that account.
    accountVersion++;
    quotaPending = null;
    writeUsage({ latest: null, history: [], checkedAt: null, status: null, error: null });
    writeJson(cacheFile, { models: [], verifiedAt: null, error: '', awaitingVerification: true });
    onChange();
    return { opened: true };
  }
  return { state, refresh, refreshUsage, signIn };
}

module.exports = { createGoogleAccount, subscriptionEnvironment, systemProxy, parseModels, parseGoogleQuota, normalizeGoogleQuota, groupModels, normalizeSelection, effectiveSelection, runCli, runCliWithRetry, requireGoogleProvider, loginScript, headlessEnvironment, describeCliFailure, isProfilePictureFailure };
