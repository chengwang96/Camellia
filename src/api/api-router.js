'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { modelId, normalizeConfig, loadConfig, writeConfig, publicState, DEFAULT_PORT, PRESETS } = require('./api-router-config');
const { convertRequest, convertResponse, SSEParser, StreamConverter, frame } = require('./api-protocol');
const { recordUsage } = require('./api-usage');

function retryDelay(headers = {}, now = Date.now()) {
  const value = headers['retry-after'];
  if (value !== undefined) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(ms)) return Math.max(1000, ms);
  }
  const resets = ['x-ratelimit-reset', 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']
    .map(k => headers[k]).filter(Boolean).map(v => {
      if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000 - now;
      if (/^\d+(\.\d+)?s$/.test(v)) return parseFloat(v) * 1000;
      return Date.parse(v) - now;
    }).filter(ms => Number.isFinite(ms) && ms > 0);
  return resets.length ? Math.max(...resets) : 60000;
}
function failureKind(status, body = '') {
  if (status === 401) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status === 403 && /quota|limit|plan|entitle|subscription|exceed|credit|balance|upgrade_required|余额|额度/i.test(body)) return 'quota';
  if ([400, 404, 422].includes(status) && /unsupported_model|model_not_found|model.*(not.*(found|available|support)|unavailable)|no.*provider/i.test(body)) return 'model_unavailable';
  if (status >= 500) return 'upstream';
  return null;
}
const reasonText = { auth: "Key authentication failed", quota: "Quota exhausted or plan unavailable", rate_limit: "Provider rate limit", model_unavailable: "Model temporarily unavailable", upstream: "Provider temporarily unavailable", network: "Connection failed or timed out", protocol: "This route cannot handle the request format" };
function safeDetail(text, secrets) {
  let value = String(text || '').slice(0, 4000);
  for (const key of secrets) if (key) value = value.split(key).join('[redacted]');
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]').slice(0, 350);
}
function json(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function apiError(res, status, message, protocol, code = 'api_router_error', headers = {}) {
  json(res, status, protocol === 'anthropic' ? { type: 'error', error: { type: code, message } } : { error: { type: code, code, message } }, headers);
}

function startApiRouter({ configPath, log = () => {}, onState = () => {}, timeoutMs = 120000 } = {}) {
  let cfg = loadConfig(configPath);
  let running = false, error = null, stopped = false, saveTimer = null, lastRoute = null;
  let diskMtime = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  const sockets = new Set(), upstreams = new Set();
  const getState = () => ({ ...publicState(cfg), running, error, activeRequests: upstreams.size, url: `http://127.0.0.1:${cfg.port}`, lastRoute: lastRoute ? { ...lastRoute } : null });
  const notify = () => { try { onState(getState()); } catch { /* observers must not interrupt a request */ } };
  function refreshDisk() {
    const mtime = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
    if (mtime === diskMtime) return;
    const latest = loadConfig(configPath);
    if (latest.port !== cfg.port) throw new Error("The port changed. Restart the router.");
    // Merge counters only for unchanged credentials; never overwrite a newly edited pool.
    for (const p of latest.providers) for (const k of p.keys) {
      const old = cfg.providers.find(x => x.id === p.id)?.keys.find(x => x.id === k.id && x.key === k.key);
      if (old && cfg.usage[k.id]) latest.usage[k.id] = cfg.usage[k.id];
    }
    cfg = latest; diskMtime = mtime;
  }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    refreshDisk();
    writeConfig(configPath, cfg);
    diskMtime = fs.statSync(configPath).mtimeMs;
  }
  function changed() {
    if (!stopped) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { try { flush(); } catch (e) { error = e.message; notify(); } }, 250);
      saveTimer.unref();
    }
    notify();
  }
  function usageFor(route) {
    return cfg.providers.some(p => p.id === route.provider.id && p.keys.some(k => k.id === route.key.id && k.key === route.key.key)) ? cfg.usage[route.key.id] : null;
  }
  function candidates(model, protocol) {
    const all = [];
    for (const p of cfg.providers) {
      if (!p.enabled) continue;
      const m = p.models.find(m => m.id === model);
      if (!m) continue;
      const wire = m.protocol && m.protocol !== 'auto' ? m.protocol : p.protocol === 'dual' ? protocol : p.protocol;
      for (const k of p.keys) if (k.enabled) all.push({ provider: p, key: k, model: m, protocol: wire });
    }
    const start = all.findIndex(r => r.key.id === cfg.active[model]);
    return start > 0 ? [...all.slice(start), ...all.slice(0, start)] : all;
  }
  function available(r, model) {
    const usage = cfg.usage[r.key.id];
    return !usage?.blocked && !(usage?.models[model]?.until > Date.now());
  }
  function failed(route, model, status, kind, headers = {}, tokens = {}, trackUsage = true) {
    const usage = usageFor(route);
    if (!usage) return;
    const now = Date.now();
    const delay = kind === 'auth' ? 0 : kind === 'quota' ? Math.max(15 * 60000, retryDelay(headers)) : retryDelay(headers);
    if (trackUsage) recordUsage(usage, model, tokens, 'failures');
    usage.lastError = { status, reason: reasonText[kind], at: new Date(now).toISOString() };
    if (kind === 'auth') usage.blocked = true;
    else usage.models[model] = { until: now + delay, reason: reasonText[kind] };
    log(`${model}: ${route.provider.name} / ${route.key.id} ${reasonText[kind]}`);
    lastRoute = { model, providerId: route.provider.id, providerName: route.provider.name, keyId: route.key.id, reason: reasonText[kind], at: new Date(now).toISOString(), status: 'failed' };
    changed();
  }
  function succeeded(route, model, tokens, switched) {
    const usage = usageFor(route);
    if (!usage) return;
    recordUsage(usage, model, tokens, 'requests');
    usage.lastError = null;
    delete usage.models[model];
    cfg.active[model] = route.key.id;
    lastRoute = { model, providerId: route.provider.id, providerName: route.provider.name, keyId: route.key.id,
      reason: switched ? "Previous route unavailable. Switched to another route for the same model." : "Request complete", at: usage.lastUsedAt, status: 'ok' };
    changed();
  }

  function forward(route, clientProtocol, body, pathname, downstream, clientHeaders) {
    const source = route.protocol;
    let payload;
    try { payload = convertRequest(body, clientProtocol, source); }
    catch (e) { return Promise.resolve({ status: 400, kind: 'protocol', detail: e.message }); }
    payload.model = route.model.upstream;
    const count = pathname.endsWith('/count_tokens');
    if (count && source !== 'anthropic') return Promise.resolve({ status: 501, kind: 'protocol', detail: "This route does not provide Anthropic token counting" });
    const base = source === 'anthropic' && route.provider.anthropicBaseUrl ? route.provider.anthropicBaseUrl : route.provider.baseUrl;
    const url = new URL(base + (count ? '/messages/count_tokens' : source === 'anthropic' ? '/messages' : '/chat/completions'));
    const encoded = Buffer.from(JSON.stringify(payload));
    const headers = { 'content-type': 'application/json', 'content-length': encoded.length, 'accept-encoding': 'identity', authorization: `Bearer ${route.key.key}` };
    if (source === 'anthropic') { headers['x-api-key'] = route.key.key; headers['anthropic-version'] = '2023-06-01'; }
    if (source === 'anthropic' && clientProtocol === 'anthropic') {
      if (clientHeaders['anthropic-version']) headers['anthropic-version'] = clientHeaders['anthropic-version'];
      if (clientHeaders['anthropic-beta']) headers['anthropic-beta'] = clientHeaders['anthropic-beta'];
    }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: false };
    let anthropicTotals = {};
    const countUsage = obj => {
      const usage = obj.message?.usage || obj.usage || obj.choices?.[0]?.usage;
      if (!usage || !['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => typeof usage[key] === 'number')) return;
      tokens.reported = true;
      if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
        tokens.input = Math.max(tokens.input, Number(usage.prompt_tokens || 0));
        tokens.output = Math.max(tokens.output, Number(usage.completion_tokens || 0));
        tokens.cacheRead = Math.max(tokens.cacheRead, Number(usage.prompt_tokens_details?.cached_tokens || 0));
      } else {
        anthropicTotals = { ...anthropicTotals, ...usage };
        tokens.input = Number(anthropicTotals.input_tokens || 0) + Number(anthropicTotals.cache_read_input_tokens || 0) + Number(anthropicTotals.cache_creation_input_tokens || 0);
        tokens.output = Number(anthropicTotals.output_tokens || 0);
        tokens.cacheRead = Number(anthropicTotals.cache_read_input_tokens || 0);
        tokens.cacheWrite = Number(anthropicTotals.cache_creation_input_tokens || 0);
      }
    };
    return new Promise(resolve => {
      let settled = false, upstream, committed = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        downstream.off('close', cancel);
        upstreams.delete(upstream);
        resolve({ ...result, committed, tokens });
      };
      const cancel = () => { if (!downstream.writableEnded) { upstream?.destroy(); finish({ cancelled: true }); } };
      downstream.on('close', cancel);
      const transport = url.protocol === 'http:' ? http : https;
      upstream = transport.request(url, { method: 'POST', headers }, response => {
        const status = response.statusCode || 502;
        const isSSE = /text\/event-stream/i.test(response.headers['content-type'] || '');
        if (status >= 400 || !isSSE || !body.stream) {
          const chunks = []; let size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) response.destroy(new Error("Response exceeded the size limit")); else chunks.push(chunk); });
          response.on('error', () => finish({ status: 502, kind: 'network' }));
          response.on('end', () => {
            if (settled) return;
            const text = Buffer.concat(chunks).toString('utf8');
            if (status >= 400) return finish({ status, kind: failureKind(status, text), detail: text, headers: response.headers });
            let obj;
            try { obj = JSON.parse(text); } catch { return finish({ status: 502, kind: 'upstream' }); }
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return finish({ status: 502, kind: 'upstream' });
            if (obj.error) return finish({ status: 502, kind: failureKind(Number(obj.error.status) || 429, JSON.stringify(obj.error)) || 'upstream' });
            try {
              countUsage(obj);
              if (body.stream && !count) return finish({ status: 502, kind: 'upstream', detail: "The provider did not return the requested stream" });
              if (count && (!Number.isFinite(obj.input_tokens) || obj.input_tokens < 0)) return finish({ status: 502, kind: 'upstream' });
              const result = count ? obj : convertResponse(obj, source, clientProtocol, body.model);
              json(downstream, status, result);
              committed = true;
              finish({ ok: true });
            } catch { finish({ status: 502, kind: 'upstream' }); }
          });
          return;
        }
        let terminal = false, messageStarted = false, waitingForDrain = false;
        const converter = new StreamConverter(source, clientProtocol, body.model, data => {
          if (settled || downstream.destroyed) return;
          if (!committed) {
            committed = true;
            downstream.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
          }
          if (!downstream.write(data) && !waitingForDrain) {
            waitingForDrain = true;
            response.pause();
            downstream.once('drain', () => { waitingForDrain = false; if (!settled) response.resume(); });
          }
        });
        function streamError(kind, detail = '') {
          if (settled) return;
          if (committed && !downstream.destroyed) {
            const message = "The upstream stream was interrupted. Retry the request; started responses are not replayed automatically.";
            downstream.end(frame(clientProtocol === 'anthropic' ? { type: 'error', error: { type: 'api_error', message } } : { error: { type: 'api_error', message } }, clientProtocol === 'anthropic' ? 'error' : ''));
          }
          finish({ status: 502, kind, detail });
          response.destroy();
        }
        const parser = new SSEParser((obj, event) => {
          if (settled) return;
          if (!committed && obj?.type === 'ping') return;
          if (obj?.error || obj?.type === 'error') {
            const text = JSON.stringify(obj.error || obj);
            const status = Number(obj.error?.status) || (/rate_limit|quota|credit|overloaded/i.test(text) ? 429 : 502);
            if (!committed) { finish({ status, kind: failureKind(status, text) || 'upstream', headers: response.headers }); response.destroy(); }
            else streamError('upstream');
            return;
          }
          if (source === 'openai' ? Array.isArray(obj?.choices) && obj.choices.some(c => c.delta && typeof c.delta === 'object') : obj?.type === 'message_start' && obj.message) messageStarted = true;
          if (source === 'openai' ? obj === '[DONE]' : obj?.type === 'message_stop') {
            if (!messageStarted) throw new Error("The upstream stream contained no valid message");
            terminal = true;
          }
          if (obj !== '[DONE]') countUsage(obj);
          // Preserve native SSE event names, including tool and thinking deltas.
          converter.push(obj, event || (typeof obj === 'object' ? obj.type || '' : ''));
        });
        response.on('data', chunk => { try { parser.feed(chunk); } catch { streamError('upstream'); } });
        response.on('error', () => streamError('network'));
        response.on('end', () => {
          if (settled) return;
          try {
            parser.end();
            if (settled) return;
            if (!terminal) return streamError('upstream', "The stream did not end normally");
            converter.end();
            downstream.end();
            finish({ ok: true });
          } catch { streamError('upstream'); }
        });
      });
      upstreams.add(upstream);
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Upstream timeout')));
      upstream.on('error', () => {
        if (committed && !settled && !downstream.destroyed) {
          const message = "The upstream connection closed before the response completed. Please retry.";
          downstream.end(frame(clientProtocol === 'anthropic' ? { type: 'error', error: { type: 'api_error', message } } : { error: { type: 'api_error', message } }, clientProtocol === 'anthropic' ? 'error' : ''));
        }
        finish({ status: 502, kind: 'network' });
      });
      upstream.end(encoded);
    });
  }

  async function handle(req, res) {
    const host = req.headers.host || '';
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return apiError(res, 403, "Only local API clients are allowed", 'openai');
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/v1(?=\/)/, '');
    refreshDisk();
    if (req.method === 'GET' && ['/__router/state', '/__ollama/state'].includes(pathname)) return json(res, 200, getState());
    if (req.method === 'GET' && pathname === '/models') return json(res, 200, { object: 'list', data: publicState(cfg).models.map(id => ({ id, object: 'model', owned_by: 'api-pool' })) });
    const protocol = pathname.startsWith('/messages') ? 'anthropic' : 'openai';
    if (req.method !== 'POST' || !['/chat/completions', '/messages', '/messages/count_tokens'].includes(pathname)) return apiError(res, 404, "Unsupported API path", protocol);
    if (!cfg.enabled) return apiError(res, 503, "The API route pool is disabled", protocol);
    if (!/application\/json/i.test(req.headers['content-type'] || '')) return apiError(res, 415, "Requests must use application/json", protocol);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) return apiError(res, 413, "Request exceeded the size limit", protocol); chunks.push(chunk); }
    let body, model;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); model = modelId(body.model); }
    catch { return apiError(res, 400, "Requests require valid JSON and an explicit model ID", protocol); }
    const routes = candidates(model, protocol);
    if (!routes.length) return apiError(res, 404, `Model "${model}" has no configured routes. Add a route for this model; no other model will be used.`, protocol, 'model_not_found');
    const secrets = cfg.providers.flatMap(p => p.keys.map(k => k.key));
    const attempts = [];
    for (const route of routes) {
      if (res.destroyed || stopped) return;
      const current = candidates(model, protocol).find(r => r.provider.id === route.provider.id && r.key.id === route.key.id);
      if (!cfg.enabled || !current || current.key.key !== route.key.key || current.model.upstream !== route.model.upstream
          || current.protocol !== route.protocol || current.provider.baseUrl !== route.provider.baseUrl
          || current.provider.anthropicBaseUrl !== route.provider.anthropicBaseUrl) continue;
      if (!available(route, model)) continue;
      const result = await forward(route, protocol, body, pathname, res, req.headers);
      if (result.cancelled || stopped) {
        const usage = usageFor(route);
        if (usage && !pathname.endsWith('/count_tokens')) { recordUsage(usage, model, result.tokens, 'cancelled'); changed(); }
        return;
      }
      if (result.ok) { if (!pathname.endsWith('/count_tokens')) succeeded(route, model, result.tokens, attempts.length > 0); return; }
      if (!result.kind) {
        const usage = usageFor(route);
        if (usage && !pathname.endsWith('/count_tokens')) { recordUsage(usage, model, result.tokens, 'failures'); changed(); }
        return apiError(res, result.status, safeDetail(result.detail, secrets) || "The provider rejected the request", protocol, 'upstream_request_error');
      }
      attempts.push(`${route.provider.name}: ${reasonText[result.kind]}`);
      // Unsupported features are request-specific, not an exhausted credential.
      if (result.kind !== 'protocol') failed(route, model, result.status, result.kind, result.headers, result.tokens, !pathname.endsWith('/count_tokens'));
      if (result.committed) return; // Never replay a partially delivered answer/tool call.
    }
    const waits = routes.map(r => cfg.usage[r.key.id]?.models[model]?.until - Date.now()).filter(ms => ms > 0);
    const headers = waits.length ? { 'retry-after': String(Math.ceil(Math.min(...waits) / 1000)) } : {};
    apiError(res, attempts.length && attempts.every(a => a.endsWith(reasonText.protocol)) ? 400 : 503,
      `Model "${model}" has no available routes. The model was not changed. ${attempts.join('; ') || "Wait for quota to recover, or check the key and reset its cooldown in settings."}`, protocol, 'model_routes_exhausted', headers);
  }
  const server = http.createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) apiError(res, 500, "Router configuration or request processing failed. Check API route settings.", req.url.includes('messages') ? 'anthropic' : 'openai'); else res.destroy(); }); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('error', e => { error = `Router port ${cfg.port} failed to start (${e.code || 'unknown'})`; running = false; notify(); });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => { running = true; server.removeListener('error', reject); notify(); resolve(); });
  });
  // Callers can await ready; avoid an unhandled rejection for historical CLI callers.
  ready.catch(() => {});
  function updateConfig(raw) {
    const next = normalizeConfig(raw, cfg);
    if (next.port !== cfg.port) throw new Error("Changing the port requires a router restart");
    writeConfig(configPath, next);
    clearTimeout(saveTimer); cfg = next; diskMtime = fs.statSync(configPath).mtimeMs; notify();
    return getState();
  }
  function reset(model, key) {
    const id = model ? modelId(model) : null;
    for (const [kid, u] of Object.entries(cfg.usage)) {
      if (key && kid !== key) continue;
      u.blocked = false; u.lastError = null;
      if (id) delete u.models[id]; else u.models = {};
    }
    if (id) delete cfg.active[id];
    else if (key) { for (const [model, activeKey] of Object.entries(cfg.active)) if (activeKey === key) delete cfg.active[model]; }
    else cfg.active = {};
    changed(); return getState();
  }
  function rotate(model) {
    const id = modelId(model);
    const routes = candidates(id, 'openai');
    const next = routes.slice(1).find(r => available(r, id));
    if (!next) throw new Error("No other route is available for this model");
    cfg.active[id] = next.key.id; changed(); return getState();
  }
  async function stop() {
    stopped = true; running = false;
    try { flush(); } catch (e) { log(`Could not save router state: ${e.message}`); }
    for (const upstream of upstreams) upstream.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  return { ready, getState, updateConfig, reset, rotate, reload: () => { refreshDisk(); notify(); return getState(); }, stop, url: `http://127.0.0.1:${cfg.port}` };
}

module.exports = { startApiRouter, startOllamaProxy: startApiRouter, DEFAULT_PORT, PRESETS, retryDelay, failureKind };
