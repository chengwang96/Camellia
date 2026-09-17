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
  const proxy = proxyUrl || systemProxy();
  if (proxy) {
    for (const key of Object.keys(next)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete next[key];
    Object.assign(next, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' });
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

function runCli(file, args, { env, cwd, timeout = 45000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Google account check timed out. Check the network connection and retry.')); }, timeout);
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(errors.trim() || output.trim() || `Antigravity CLI exited (${code})`));
      else resolve(output);
    });
  });
}

function requireGoogleProvider(settingsFile) {
  const value = readJson(settingsFile, {});
  if (value.modelProvider && value.modelProvider !== 'antigravity') {
    throw new Error('The official CLI is configured for an API provider. Use “Sign in with Google” in Antigravity settings to switch it to your Google account.');
  }
}

function loginScript(file, { platform, exe, proxyUrl = '' }) {
  const quote = value => platform === 'win32' ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'";
  const effective = proxyUrl || systemProxy();
  const proxy = effective ? { HTTP_PROXY: effective, HTTPS_PROXY: effective, NO_PROXY: 'localhost,127.0.0.1,::1' } : {};
  const lines = platform === 'win32'
    ? ["$Host.UI.RawUI.WindowTitle = 'Camellia — Google sign-in'", ...API_ENV.map(key => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`),
      "$env:AGY_CLI_DISABLE_AUTO_UPDATE = 'true'", ...Object.entries(proxy).map(([key, value]) => `$env:${key} = ${quote(value)}`),
      `& ${quote(exe)}`, "Read-Host 'Return to Camellia and refresh the Google account. Press Enter to close'" ]
    : ['#!/bin/sh', 'unset ' + API_ENV.join(' '), 'export AGY_CLI_DISABLE_AUTO_UPDATE=true',
      ...Object.entries(proxy).map(([key, value]) => `export ${key}=${quote(value)}`), `exec ${quote(exe)}`];
  // Windows PowerShell 5.1 needs a BOM for non-ASCII installation paths.
  fs.writeFileSync(file, (platform === 'win32' ? '\uFEFF' : '') + lines.join('\n') + '\n', { mode: 0o700 });
}

function createGoogleAccount({ home, cliSettingsFile, runtime, environment, settings, openLogin }) {
  const cacheFile = path.join(home, 'google-account.json');
  const state = () => ({ models: [], verifiedAt: null, error: '', ...readJson(cacheFile, {}), installed: Boolean(runtime().locate('antigravity', 'subscription')) });
  async function refresh() {
    const found = runtime().locate('antigravity', 'subscription');
    if (!found) throw new Error('Download the Antigravity Google subscription runtime first.');
    requireGoogleProvider(cliSettingsFile);
    fs.mkdirSync(home, { recursive: true });
    try {
      const output = await runCli(found.file, ['models'], { env: subscriptionEnvironment(environment(), settings().proxyUrl), cwd: home });
      const models = parseModels(output);
      if (!models.length) throw new Error('The Google account returned no available models.');
      writeJson(cacheFile, { models, verifiedAt: Date.now(), error: '' });
    } catch (error) {
      writeJson(cacheFile, { ...state(), models: [], error: error.message });
      throw error;
    }
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
    loginScript(file, { platform: process.platform, exe: found.file, proxyUrl: settings().proxyUrl });
    await openLogin(file, subscriptionEnvironment(environment(), settings().proxyUrl));
    return { opened: true };
  }
  return { state, refresh, signIn };
}

module.exports = { createGoogleAccount, subscriptionEnvironment, systemProxy, parseModels, runCli, requireGoogleProvider, loginScript };
