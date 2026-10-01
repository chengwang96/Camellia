'use strict';

const { providerTargets, subscriptionTargets, probeTargets, summarize } = require('./network-probe');

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
function networkEnvironment(source, { mode = 'direct', url = '', subscriptionProxy } = {}) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (PROXY_KEYS.test(key)) delete env[key];
  const proxy = mode !== 'direct' ? url : '';
  // "Prefer direct" hands every other process a loopback bridge that dials
  // direct first. A subscription CLI cannot wait for that: its login and
  // streaming endpoints are exactly the hosts a direct attempt cannot reach,
  // so it gets the real detected proxy instead.
  const subscription = mode !== 'direct' ? subscriptionProxy ?? url : '';
  Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: '',
    NO_PROXY: proxy ? 'localhost,127.0.0.1,::1' : '*', NODE_USE_ENV_PROXY: '1',
    npm_config_proxy: proxy, npm_config_https_proxy: proxy, npm_config_noproxy: proxy ? 'localhost,127.0.0.1,::1' : '*',
    CAMELLIA_NETWORK_MODE: mode, CAMELLIA_NETWORK_PROXY: proxy, CAMELLIA_SUBSCRIPTION_PROXY: subscription });
  return env;
}
// The provider CLIs (Codex app-server, Claude Code) are spawned with this
// resolved transport so a "prefer direct" policy cannot make them try a direct
// route first. An empty value means no system proxy was detected, which is the
// only case where they connect directly. Outside the desktop there is no such
// policy, so the caller's own proxy configuration is preserved.
function subscriptionEnvironment(source) {
  if (source.CAMELLIA_SUBSCRIPTION_PROXY === undefined) return { ...source };
  const env = { ...source };
  const proxy = String(env.CAMELLIA_SUBSCRIPTION_PROXY ?? '');
  for (const key of Object.keys(env)) if (PROXY_KEYS.test(key)) delete env[key];
  Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: '',
    NO_PROXY: proxy ? 'localhost,127.0.0.1,::1' : '*', NODE_USE_ENV_PROXY: '1' });
  return env;
}
// A proxy that accepts connections but cannot reach the internet leaves every
// request hanging. Probing over raw TCP tells a working proxy apart from a
// stale one without paying for an application request.
function probeTarget(url) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80) };
}
// The probe reuses the release/update endpoint the app already depends on, so
// "healthy" matches something the user actually needs, and a machine that must
// route everything through a proxy is never mistaken for a broken one.
async function healthCheck(proxyUrl, { url = 'https://api.github.com', timeout = 5000 } = {}) {
  const { host, port } = probeTarget(url);
  const reachable = connect => connect().then(socket => { socket.destroy(); return true; }, () => false);
  // Direct connectivity is the precondition for "prefer direct" to help at
  // all: if a direct connection also fails, switching modes changes nothing.
  const direct = await reachable(() => require('./network-fallback').directConnection(host, port, { timeout }));
  if (!direct) return { direct, proxy: false };
  const proxy = await reachable(() => require('./network-fallback').proxyConnection(proxyUrl, host, port, { timeout }));
  return { direct, proxy };
}
function createNetworkSettings({ loadConfig, saveConfig, sessions, applyEnvironment, onHealthChange = () => {}, probeUrl = 'https://chatgpt.com',
  healthCheckImpl = healthCheck, createFallback = require('./network-fallback').createFallbackProxy,
  loadRoutes = () => ({ providers: [] }), providerTargetsImpl = providerTargets, subscriptionEngines = () => [], probeImpl = probeTargets }) {
  let detected = { url: '', unsupported: false }, error = '', queue = Promise.resolve(), degraded = false, monitor = null, closed = false;
  const bridges = [];
  // Whether the live transport is the direct-first bridge, or the real system
  // proxy. "Auto" is allowed to fall back to the proxy when direct is blocked,
  // so the settings page can explain the outcome instead of only the choice.
  let directFirst = false;
  // "auto" is the stored name for the direct-first bridge that tries direct and
  // falls back to the detected proxy. Older configs still say "prefer-direct",
  // so both spellings resolve to the same behaviour.
  const mode = () => {
    const saved = loadConfig().network?.mode;
    if (saved === 'prefer-direct') return 'auto';
    return ['direct', 'system', 'auto'].includes(saved) ? saved : 'direct';
  };
  // `mode` reports the transport actually in use so a background downgrade is
  // visible; `configured` is the stored choice, always one of the selectable
  // modes, so the settings page never renders an option that no longer exists.
  // A downgrade is never persisted, so a restart re-probes a proxy the user may
  // have fixed in the meantime.
  const state = () => ({ mode: degraded ? 'prefer-direct' : mode(), configured: mode() === 'prefer-direct' ? 'auto' : mode(),
    degraded, directFirst, autoFallback: mode() === 'auto' && !directFirst && !degraded,
    detectedUrl: detected.url, unsupported: detected.unsupported, error });
  // A full connectivity test covers every enabled provider host and the
  // subscription CLIs that are signed in. It is read-only: the result tells the
  // settings page what to show and whether "auto" can safely take the
  // direct-first bridge, and it never changes the stored choice on its own.
  async function testConnectivity() {
    if (closed) return { ok: false, error: 'Network settings are closed' };
    await detectProxy();
    const engines = subscriptionEngines();
    const targets = [...providerTargetsImpl(loadRoutes()), ...subscriptionTargets(engines)];
    const results = targets.length ? await probeImpl(targets, { proxyUrl: detected.url }) : [];
    const summary = summarize(results);
    return { ok: true, at: new Date().toISOString(), detectedUrl: detected.url, unsupported: detected.unsupported,
      results, summary, subscriptionEngines: engines };
  }
  async function detectProxy() {
    error = '';
    try {
      const detector = sessions().fromPartition('camellia-system-proxy-detector');
      await detector.setProxy({ mode: 'system' });
      await detector.forceReloadProxyConfig?.();
      detected = detectedProxy(await detector.resolveProxy(probeUrl));
    } catch { detected = { url: '', unsupported: false }; error = 'Could not detect the system proxy.'; }
    return state();
  }
  // Detection only refreshes which proxy is in use. It must not clear the
  // downgrade: reading the state from the settings page goes through here, and
  // doing so would hide the warning until the next probe. An explicit save
  // clears it, and a proxy that starts working again is picked up by
  // checkHealth().
  async function detect() { return detectProxy(); }
  function schedule(period) {
    clearTimeout(monitor);
    if (closed) return;
    monitor = setTimeout(async () => {
      try { await checkHealth(); } catch { /* keep the last known result */ }
      schedule(degraded ? 15000 : 60000);
    }, period);
    monitor.unref?.();
  }
  async function apply(nextMode, persist = false, probe = false) {
    if (!['direct', 'system', 'auto', 'prefer-direct'].includes(nextMode)) throw new Error('Choose direct connection or system proxy');
    // Keep the user's choice ("auto") for persistence even when the resolved
    // transport for this run is the proxy.
    const requested = nextMode;
    // Only an explicit save re-tests connectivity. Startup and the health
    // monitor reuse the stored choice: the direct-first bridge already falls
    // back per connection, so honoring it costs nothing and avoids probing on
    // every launch.
    if (nextMode === 'auto' && persist) {
      // Automatic mode tests connectivity for real and only takes the
      // direct-first bridge when direct connections work; otherwise it stays on
      // the proxy, so a machine that needs the proxy is never cut off.
      await detectProxy();
      const engines = subscriptionEngines();
      const targets = [...providerTargetsImpl(loadRoutes()), ...subscriptionTargets(engines)];
      const summary = targets.length ? summarize(await probeImpl(targets, { proxyUrl: detected.url })) : { direct: 0, total: 0, subscriptionDirect: true, hasSubscriptions: false };
      const eligible = summary.total === 0 || (summary.direct === summary.total && summary.subscriptionDirect);
      nextMode = eligible ? 'auto' : 'system';
    }
    if (nextMode !== 'direct') {
      // Probe without clearing the downgrade flag: checkHealth() re-applies
      // "prefer direct" through this path and must not erase its own state.
      await detectProxy();
      if (!detected.url && nextMode === 'system') {
        error ||= detected.unsupported ? 'The detected proxy protocol is not supported. Enable an HTTP or mixed proxy port.' : 'No system proxy detected. Enable the system proxy and detect again.';
        if (persist) throw new Error(error);
      }
      // Startup installs the environment before any window exists, so a proxy
      // that is already broken must be caught here. Otherwise the embedded
      // network node starts on a dead proxy and stays stuck until the page
      // happens to re-probe. A user's explicit save uses the monitor instead,
      // so the choice they made is applied immediately.
      if (probe && detected.url && nextMode === 'system') {
        const health = await healthCheckImpl(detected.url, { url: probeUrl });
        if (health.direct && !health.proxy) {
          degraded = true;
          nextMode = 'prefer-direct';
          onHealthChange({ degraded: true, proxy: detected.url, state: state() });
        }
      }
    }
    // An unavailable system proxy must not become a loopback proxy with no
    // upstream. Every request through such a proxy fails, and callers that
    // read the inherited HTTP_PROXY instead of the Electron session (the
    // embedded Tailscale node) then never reach the control plane and hang.
    // Report the problem and fall back to a direct connection; only
    // "prefer direct" keeps a bridge, because it dials direct first.
    let url = nextMode === 'system' ? detected.url : '';
    if (nextMode === 'auto' || nextMode === 'prefer-direct') {
      const bridge = await createFallback(detected.url, { allowDirect: true });
      bridges.push(bridge); // Existing engines retain their transport until restart.
      url = bridge.url;
      directFirst = true;
    } else {
      directFirst = false;
    }
    // A degraded proxy is dead, so the subscription CLIs share the bridge that
    // still falls back rather than the address that would hang. Otherwise they
    // take the real detected proxy, never the loopback bridge that tries direct
    // first.
    const subscriptionProxy = nextMode === 'direct' ? '' : degraded ? url : detected.url || url;
    // One resolved HTTP proxy is shared by Electron, Node and engine processes.
    await sessions().defaultSession.setProxy(url ? { mode: 'fixed_servers', proxyRules: url, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' } : { mode: 'direct' });
    applyEnvironment(networkEnvironment(process.env, { mode: nextMode === 'prefer-direct' ? 'auto' : nextMode, url, subscriptionProxy }));
    saveConfig({ ...(persist ? { network: { mode: requested } } : {}), downloadProxy: { mode: url ? 'proxy' : 'direct', url } });
    schedule(nextMode === 'system' ? 4000 : 60000);
    return state();
  }
  // A selected system proxy that cannot reach the internet is downgraded to
  // "prefer direct": direct connectivity is tried first, so work resumes
  // immediately, while the proxy stays in the chain for hosts only it serves.
  // The user is told through onHealthChange and must investigate the cause.
  async function checkHealth() {
    if (closed || mode() !== 'system' || !detected.url) return state();
    const result = await healthCheckImpl(detected.url, { url: probeUrl });
    if (closed) return state();
    if (result.direct && !result.proxy && !degraded) {
      degraded = true;
      await apply('prefer-direct');
      onHealthChange({ degraded: true, proxy: detected.url, state: state() });
    } else if (degraded && result.proxy) {
      degraded = false;
      // Restore the stored choice so the chain matches the proxy in use now;
      // the bridge built for the broken proxy must not outlive it.
      await apply(mode());
      onHealthChange({ degraded: false, proxy: detected.url, state: state() });
    }
    return state();
  }
  return { state, detect, checkHealth, testConnectivity, close() { closed = true; clearTimeout(monitor); bridges.forEach(bridge => bridge.close()); },
    initialize() { return apply(mode(), false, true); },
    save(value) {
      // An explicit choice supersedes an automatic downgrade: the new setting
      // is applied as chosen and the health monitor re-probes it from scratch.
      const run = () => { degraded = false; return apply(value?.mode, true); };
      const result = queue.then(run, run); queue = result.catch(() => {}); return result;
    } };
}
module.exports = { detectedProxy, networkEnvironment, subscriptionEnvironment, createNetworkSettings, healthCheck, probeTarget, PROXY_KEYS };
