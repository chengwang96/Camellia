'use strict';

const PROXY_KEYS = /^(https?|all|no)_proxy$|^npm_config_(proxy|https?_proxy|noproxy)$/i;
function detectedProxy(result) {
  // Respect the first route: a leading DIRECT is not permission to use a
  // later fallback. SOCKS-only routes cannot be shared by all our runtimes.
  const first = String(result || '').split(';')[0].trim();
  const match = /^(PROXY|HTTPS)\s+([^\s/]+)$/i.exec(first);
  if (!match) return { url: '', unsupported: Boolean(first && first !== 'DIRECT') };
  try {
    const url = new URL((match[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://') + match[2]);
    if (url.username || url.password) return { url: '', unsupported: true };
    return { url: url.href, unsupported: false };
  } catch { return { url: '', unsupported: true }; }
}
function networkEnvironment(source, { mode = 'direct', url = '' }) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (PROXY_KEYS.test(key)) delete env[key];
  const proxy = mode !== 'direct' ? url : '';
  Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: '',
    NO_PROXY: proxy ? 'localhost,127.0.0.1,::1' : '*', NODE_USE_ENV_PROXY: '1',
    npm_config_proxy: proxy, npm_config_https_proxy: proxy, npm_config_noproxy: proxy ? 'localhost,127.0.0.1,::1' : '*',
    CAMELLIA_NETWORK_MODE: mode, CAMELLIA_NETWORK_PROXY: proxy });
  return env;
}
function createNetworkSettings({ loadConfig, saveConfig, sessions, applyEnvironment, createFallback = require('./network-fallback').createFallbackProxy }) {
  let detected = { url: '', unsupported: false }, error = '', queue = Promise.resolve();
  const bridges = [];
  const mode = () => ['system', 'prefer-direct'].includes(loadConfig().network?.mode) ? loadConfig().network.mode : 'direct';
  const state = () => ({ mode: mode(), detectedUrl: detected.url, unsupported: detected.unsupported, error });
  async function detect() {
    error = '';
    try {
      const detector = sessions().fromPartition('camellia-system-proxy-detector');
      await detector.setProxy({ mode: 'system' });
      await detector.forceReloadProxyConfig?.();
      detected = detectedProxy(await detector.resolveProxy('https://chatgpt.com'));
    } catch { detected = { url: '', unsupported: false }; error = 'Could not detect the system proxy.'; }
    return state();
  }
  async function apply(nextMode, persist = false) {
    if (!['direct', 'system', 'prefer-direct'].includes(nextMode)) throw new Error('Choose direct connection or system proxy');
    if (nextMode !== 'direct') {
      await detect();
      if (!detected.url && nextMode === 'system') {
        error ||= detected.unsupported ? 'The detected proxy protocol is not supported. Enable an HTTP or mixed proxy port.' : 'No system proxy detected. Enable the system proxy and detect again.';
        if (persist) throw new Error(error);
      }
    }
    let url = nextMode === 'system' ? detected.url : '';
    if (nextMode === 'prefer-direct' || (nextMode === 'system' && !url)) {
      const bridge = await createFallback(detected.url, { allowDirect: nextMode === 'prefer-direct' });
      bridges.push(bridge); // Existing engines retain their transport until restart.
      url = bridge.url;
    }
    // One resolved HTTP proxy is shared by Electron, Node and engine processes.
    await sessions().defaultSession.setProxy(url ? { mode: 'fixed_servers', proxyRules: url, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' } : { mode: 'direct' });
    applyEnvironment(networkEnvironment(process.env, { mode: nextMode, url }));
    saveConfig({ ...(persist ? { network: { mode: nextMode } } : {}), downloadProxy: { mode: url ? 'proxy' : 'direct', url } });
    return state();
  }
  return { state, detect, close: () => bridges.forEach(bridge => bridge.close()), initialize: () => apply(mode()),
    save(value) { const run = () => apply(value?.mode, true); const result = queue.then(run, run); queue = result.catch(() => {}); return result; } };
}
module.exports = { detectedProxy, networkEnvironment, createNetworkSettings, PROXY_KEYS };
