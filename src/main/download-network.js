'use strict';

const { Agent, ProxyAgent, EnvHttpProxyAgent, fetch } = require('undici');

const PROBE_BYTES = 256 * 1024;
const PROBE_TIMEOUT = 8000;
// A route has to be clearly faster before overriding the saved choice.
const PROBE_MARGIN = 1.2;

function downloadSettings({ mode = 'direct', url = '' } = {}) {
  if (!['direct', 'proxy'].includes(mode)) throw new Error('Choose a download connection');
  url = url.trim();
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Enter a valid HTTP or HTTPS proxy address'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Use an HTTP or HTTPS proxy address without a path');
    }
    url = parsed.href;
  }
  if (mode === 'proxy' && !url) throw new Error('Enter a proxy address before enabling the download proxy');
  return { mode, url };
}

function createDownloadConnection(settings, baseEnv = process.env) {
  const env = { ...baseEnv };
  let dispatcher;
  if (settings === undefined) {
    // CLI setup keeps the shell's proxy configuration. Desktop downloads always
    // pass an explicit choice, without changing the app's API connections.
    dispatcher = new EnvHttpProxyAgent({ httpProxy: env.http_proxy || env.HTTP_PROXY || '',
      httpsProxy: env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '',
      noProxy: env.no_proxy || env.NO_PROXY || '' });
  } else {
    const { mode, url } = downloadSettings(settings);
    for (const key of Object.keys(env)) {
      if (/^(https?|all|no)_proxy$|^npm_config_(proxy|https?_proxy|noproxy)$/i.test(key)) delete env[key];
    }
    const proxy = mode === 'proxy' ? url : '';
    Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: '',
      NO_PROXY: mode === 'proxy' ? 'localhost,127.0.0.1,::1' : '*',
      npm_config_proxy: proxy, npm_config_https_proxy: proxy,
      npm_config_noproxy: mode === 'proxy' ? 'localhost,127.0.0.1,::1' : '*', NODE_USE_ENV_PROXY: '1' });
    dispatcher = mode === 'proxy' ? new ProxyAgent(url) : new Agent();
  }
  return { env, fetch: (url, options) => fetch(url, { ...options, dispatcher }), close: () => dispatcher.destroy() };
}

// Measure only the beginning of a real update artifact. Servers that ignore
// Range are canceled after the same cap instead of downloading the whole file.
async function measureDownload(connection, url, { bytes = PROBE_BYTES, timeout = PROBE_TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = performance.now();
  try {
    const response = await connection.fetch(url, {
      headers: { range: `bytes=0-${bytes - 1}`, 'accept-encoding': 'identity' },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Speed test failed (HTTP ${response.status})`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Speed test returned no response body');
    let received = 0;
    try {
      while (received < bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
    } finally {
      try { await reader.cancel(); } catch { /* The response may already be closed. */ }
    }
    const ms = Math.max(1, performance.now() - started);
    if (!received) throw new Error('Speed test returned an empty response');
    return { bytes: received, ms, bytesPerSecond: received / (ms / 1000) };
  } finally {
    clearTimeout(timer);
  }
}

function probeCandidates(settings) {
  if (settings === undefined) return [{ route: 'environment', settings: undefined }];
  const normalized = downloadSettings(settings);
  if (normalized.mode === 'direct') return [{ route: 'direct', settings: normalized }];
  return [{ route: 'direct', settings: { mode: 'direct', url: '' } },
    { route: 'proxy', settings: normalized }];
}

function speedText(result) {
  if (!result.ok) return `${result.route} failed: ${result.error}`;
  return `${result.route} ${(result.bytesPerSecond / 1048576).toFixed(2)} MB/s`;
}

// Compare the configured route with a direct download before a harness update.
// The saved proxy stays the fallback and is kept unless direct is clearly faster.
async function chooseDownloadConnection(settings, { probeUrl, baseEnv = process.env, log = () => {},
  create = createDownloadConnection, probe = measureDownload } = {}) {
  const candidates = probeCandidates(settings);
  if (!probeUrl || candidates.length === 1) {
    const selected = candidates[0];
    return { connection: create(selected.settings, baseEnv), route: selected.route, settings: selected.settings, results: [] };
  }
  const entries = candidates.map(candidate => {
    let connection;
    try { connection = create(candidate.settings, baseEnv); }
    catch (error) { return { ...candidate, error }; }
    return { ...candidate, connection };
  });
  const measured = await Promise.all(entries.map(async entry => {
    if (entry.error) return { ...entry, ok: false, error: entry.error.message };
    try {
      return { ...entry, ok: true, ...await probe(entry.connection, probeUrl) };
    } catch (error) {
      return { ...entry, ok: false, error: error.name === 'AbortError' ? 'Timed out' : error.message };
    }
  }));
  const usable = measured.filter(result => result.ok);
  const configured = measured.find(result => result.route === candidates.at(-1).route);
  let selected = configured?.ok ? configured : usable[0] || configured || measured[0];
  const fastest = usable.slice().sort((a, b) => b.bytesPerSecond - a.bytesPerSecond)[0];
  if (fastest && configured?.ok && fastest.route !== configured.route
      && fastest.bytesPerSecond >= configured.bytesPerSecond * PROBE_MARGIN) selected = fastest;
  if (!selected?.connection) selected = { route: 'fallback', connection: create(settings, baseEnv) };
  for (const entry of measured) if (entry.connection !== selected.connection) entry.connection?.close();
  log(`download route: ${measured.map(speedText).join('; ')}; using ${selected.route}`);
  return { connection: selected.connection, route: selected.route, settings: selected.settings, results: measured.map(({ connection, ...result }) => result) };
}

module.exports = { downloadSettings, createDownloadConnection, chooseDownloadConnection, measureDownload };
