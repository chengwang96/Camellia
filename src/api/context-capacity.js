'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../shared/json-store');
const { endpoint } = require('./api-router-config');

const OUTPUT_TOKENS = 128;
const MAX_TOTAL_ESTIMATE = 524288;
const WORDS = 'amber river stone forest quiet silver meadow copper planet winter garden ocean violet cloud gentle paper lantern cedar orange marble'.split(' ');

function contextError(status, detail) {
  if (![400, 422].includes(status)) return null;
  let error;
  try { const body = typeof detail === 'string' ? JSON.parse(detail) : detail; error = body?.error || body; } catch { return null; }
  const message = String(error?.message || '');
  const code = String(error?.code || error?.type || '');
  if (!/^(context_length_exceeded|context_window_exceeded|prompt_too_long|input_too_long)$/.test(code)
    && !/(maximum context length|context window).{0,80}(exceed|too (?:long|large))|exceed.{0,80}(context window|maximum context length)|prompt is too long|maximum context length is \d+/i.test(message)) return null;
  const match = /maximum context length is\s*([\d,]+)\s*tokens/i.exec(message);
  const declared = match ? Number(match[1].replaceAll(',', '')) : null;
  return { kind: 'context', declared: Number.isSafeInteger(declared) && declared > 0 ? declared : null };
}

function routeIdentity(provider, key, model, protocol) {
  return createHash('sha256').update(JSON.stringify([provider.id, provider.baseUrl, provider.anthropicBaseUrl || '',
    key.id, key.key, model.id, model.upstream, protocol])).digest('hex');
}

function probeText(estimate) {
  let seed = 739391, text = '';
  while (text.length < estimate * 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    text += WORDS[seed % WORDS.length] + ' ';
  }
  const markers = ['CAP_START_73Q', 'CAP_MIDDLE_92R', 'CAP_END_46S'];
  const middle = Math.floor(text.length / 2);
  return { markers, text: `Return only the three CAP_ markers in this text, in order.\n${markers[0]}\n${text.slice(0, middle)}\n${markers[1]}\n${text.slice(middle)}\n${markers[2]}` };
}

function inputUsage(usage, protocol) {
  const value = protocol === 'anthropic' ? usage?.input_tokens : usage?.prompt_tokens;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value + (protocol === 'anthropic' ? Math.max(0, Number(usage.cache_read_input_tokens) || 0) + Math.max(0, Number(usage.cache_creation_input_tokens) || 0) : 0);
}

async function sendProbe(provider, key, model, protocol, estimate, signal, fetchImpl) {
  const content = probeText(estimate);
  const base = endpoint(protocol === 'anthropic' && provider.anthropicBaseUrl ? provider.anthropicBaseUrl : provider.baseUrl);
  const response = await fetchImpl(base + (protocol === 'anthropic' ? '/messages' : '/chat/completions'), {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.key}`,
      ...(protocol === 'anthropic' ? { 'x-api-key': key.key, 'anthropic-version': '2023-06-01' } : {}) },
    body: JSON.stringify({ model: model.upstream, messages: [{ role: 'user', content: content.text }], max_tokens: OUTPUT_TOKENS, stream: false }),
  });
  const body = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok || body?.error) {
    const boundary = contextError(response.status, body);
    if (boundary) return { estimate, ...boundary };
    return { estimate, kind: 'error', reason: response.status === 413 ? 'body_limit' : response.status === 429 ? 'rate_limit' : 'http_error', httpStatus: response.status };
  }
  const valid = protocol === 'anthropic' ? Array.isArray(body?.content) : Array.isArray(body?.choices) && body.choices.length > 0;
  if (!valid) return { estimate, kind: 'error', reason: 'invalid_response' };
  const text = protocol === 'anthropic' ? body.content.map(part => part.text || '').join('') : body.choices[0]?.message?.content;
  return { estimate, kind: 'accepted', reportedInput: inputUsage(body.usage, protocol),
    markersFound: typeof text === 'string' && content.markers.every(marker => text.includes(marker)) };
}

function createContextCapacity({ file, getConfig, onChange = () => {}, fetchImpl = fetch, now = () => Date.now() }) {
  const data = readJson(file, { entries: {} });
  for (const entry of Object.values(data.entries)) if (entry.probe?.status === 'running') entry.probe.status = 'interrupted';
  let active = null;
  function routes() {
    return getConfig().providers.flatMap(provider => provider.keys.flatMap(key => provider.models.flatMap(model => {
      const protocols = model.protocol && model.protocol !== 'auto' ? [model.protocol] : provider.protocol === 'dual' ? ['openai', 'anthropic'] : [provider.protocol || 'openai'];
      return protocols.map(protocol => ({ provider, key, model, protocol, identity: routeIdentity(provider, key, model, protocol) }));
    })));
  }
  function state() {
    return { ok: true, active: active ? { providerId: active.provider.id, keyId: active.key.id, model: active.model.id, protocol: active.protocol } : null,
      entries: routes().map(route => ({ providerId: route.provider.id, keyId: route.key.id, model: route.model.id,
        protocol: route.protocol, declared: route.model.maxContext || null, ...structuredClone(data.entries[route.identity] || {}) })) };
  }
  function publish() {
    const current = new Set(routes().map(route => route.identity));
    for (const identity of Object.keys(data.entries)) if (!current.has(identity)) delete data.entries[identity];
    writeJson(file, data);
    try { onChange(state()); } catch {}
  }
  function observe({ provider, key, model, protocol, ok, tokens = {}, status, detail, maxOutputTokens }) {
    const identity = routeIdentity(provider, key, model, protocol);
    if (!routes().some(route => route.identity === identity)) return;
    const boundary = !ok && contextError(status, detail);
    if (!(ok && Number.isSafeInteger(tokens.input) && tokens.input > 0) && !boundary) return;
    const entry = data.entries[identity] ||= {};
    const passive = entry.passive ||= {};
    if (ok && tokens.input > (passive.maxReportedInput || 0)) {
      passive.maxReportedInput = tokens.input;
      passive.outputBudget = maxOutputTokens || null;
      passive.at = new Date(now()).toISOString();
    } else if (boundary) passive.lastContextError = { at: new Date(now()).toISOString(), declared: boundary.declared };
    else return;
    publish();
  }
  async function run(job, maxEstimate, maxRequests) {
    const result = { source: 'probe', at: new Date(now()).toISOString(), outputBudget: OUTPUT_TOKENS,
      maxEstimate, maxRequests, totalEstimate: 0, samples: [], acceptedEstimate: 0, rejectedEstimate: null, status: 'running' };
    const save = () => {
      if (!routes().some(route => route.identity === job.identity)) return false;
      const entry = data.entries[job.identity] ||= {};
      entry.probe = structuredClone(result);
      publish();
      return true;
    };
    let estimate = Math.min(8192, maxEstimate);
    const deadline = AbortSignal.timeout(300000);
    try {
      save();
      while (result.samples.length < maxRequests) {
        job.controller.signal.throwIfAborted();
        deadline.throwIfAborted();
        if (!routes().some(route => route.identity === job.identity && route.provider.enabled && route.key.enabled)) { result.status = 'configuration_changed'; break; }
        if (result.totalEstimate + estimate > MAX_TOTAL_ESTIMATE) { result.status = 'budget'; break; }
        result.totalEstimate += estimate;
        const sample = await sendProbe(job.provider, job.key, job.model, job.protocol, estimate,
          AbortSignal.any([job.controller.signal, deadline, AbortSignal.timeout(60000)]), fetchImpl);
        result.samples.push(sample);
        if (sample.kind === 'error') { result.status = sample.reason; break; }
        if (sample.kind === 'accepted') result.acceptedEstimate = estimate;
        else result.rejectedEstimate = estimate;
        if (!save()) { result.status = 'configuration_changed'; break; }
        if (result.rejectedEstimate !== null) {
          if (result.rejectedEstimate - result.acceptedEstimate <= 2048) { result.status = 'range'; break; }
          estimate = Math.floor((result.acceptedEstimate + result.rejectedEstimate) / 2);
        } else {
          if (estimate === maxEstimate) { result.status = 'input_cap'; break; }
          estimate = Math.min(maxEstimate, estimate * 2);
        }
      }
      if (result.status === 'running') result.status = 'request_cap';
    } catch (error) {
      result.status = job.controller.signal.aborted ? 'cancelled' : error.name === 'TimeoutError' ? 'timeout' : 'network_error';
    } finally {
      result.finishedAt = new Date(now()).toISOString();
      active = null;
      save();
      try { onChange(state()); } catch {}
    }
    return result;
  }
  function start({ providerId, keyId, model, protocol, maxEstimate = 65536, maxRequests = 8, confirmed = false } = {}) {
    if (!confirmed) throw new Error('Confirm the context probe cost warning first');
    if (active) throw new Error('A context probe is already running');
    if (!Number.isInteger(maxEstimate) || maxEstimate < 8192 || maxEstimate > 262144 || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 12) throw new Error('Invalid context probe budget');
    const route = routes().find(item => item.provider.id === providerId && item.key.id === keyId && item.model.id === model && item.protocol === protocol);
    if (!route || !route.provider.enabled || !route.key.enabled) throw new Error('Choose a saved, enabled provider, key and model');
    const job = { ...structuredClone(route), controller: new AbortController() };
    active = job;
    job.done = run(job, maxEstimate, maxRequests);
    void job.done.catch(() => {});
    return state();
  }
  function cancel() { active?.controller.abort(); return state(); }
  function settled() { return active?.done || Promise.resolve(); }
  return { state, start, cancel, observe, settled };
}

module.exports = { createContextCapacity, contextError, probeText };
