'use strict';

const { Agent, ProxyAgent, EnvHttpProxyAgent, fetch } = require('undici');

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

module.exports = { downloadSettings, createDownloadConnection };
