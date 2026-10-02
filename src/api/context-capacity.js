'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../shared/json-store');
const { modelRoutes } = require('./api-router-config');
const { contextError } = require('../shared/context-overflow');

const UNKNOWN_CONTEXT_BUDGET = 32768;

const tokenCount = value => Number.isSafeInteger(value) && value > 0 ? value : null;
function evidenceBounds(entry = {}) {
  const accepted = [entry.accepted?.tokens, entry.passive?.maxReportedInput, ...(entry.probe?.samples || [])
    .filter(sample => sample.kind === 'accepted').map(sample => sample.reportedInput)].filter(tokenCount);
  // Read older evidence files without turning their character-based search
  // interval into token limits. Numeric limits survive later nonnumeric errors.
  const limits = Object.entries(entry.limits || {}).filter(([, limit]) => tokenCount(limit?.tokens))
    .map(([scope, limit]) => ({ scope, tokens: limit.tokens }));
  if (!limits.length) {
    for (const sample of [entry.passive?.lastContextError, ...(entry.probe?.samples || [])]) {
      if (tokenCount(sample?.declared)) limits.push({ scope: 'context', tokens: sample.declared });
      if (tokenCount(sample?.inputLimit)) limits.push({ scope: 'input', tokens: sample.inputLimit });
    }
  }
  const upper = limits.sort((a, b) => a.tokens - b.tokens)[0];
  return { acceptedLowerBound: accepted.length ? Math.max(...accepted) : null,
    confirmedUpperBound: upper?.tokens || null, upperBoundScope: upper?.scope || null };
}

function recordLimit(entry, sample, at) {
  for (const [field, scope] of [['declared', 'context'], ['inputLimit', 'input']]) {
    if (tokenCount(sample?.[field])) (entry.limits ||= {})[scope] = { tokens: sample[field], at };
  }
}

function preserveLegacyEvidence(entry) {
  const samples = entry.probe?.samples || [];
  for (const [field, scope] of [['declared', 'context'], ['inputLimit', 'input']]) {
    if (tokenCount(entry.limits?.[scope]?.tokens)) continue;
    const counts = [entry.passive?.lastContextError, ...samples].map(sample => sample?.[field]).filter(tokenCount);
    if (counts.length) (entry.limits ||= {})[scope] = { tokens: Math.min(...counts),
      at: entry.passive?.lastContextError?.at || entry.probe?.at || null };
  }
  const accepted = samples.filter(sample => sample.kind === 'accepted').map(sample => sample.reportedInput).filter(tokenCount);
  if (accepted.length && Math.max(...accepted) > (entry.accepted?.tokens || 0))
    entry.accepted = { tokens: Math.max(...accepted), outputBudget: entry.probe.outputBudget || null, at: entry.probe.at || null };
}

function legacyRouteIdentity(provider, key, model, protocol) {
  return createHash('sha256').update(JSON.stringify([provider.id, provider.baseUrl, provider.anthropicBaseUrl || '',
    key.id, key.key, model.id, model.upstream, protocol])).digest('hex');
}

function capacityIdentity(provider, model, protocol) {
  return createHash('sha256').update(JSON.stringify([provider.id, provider.baseUrl, provider.anthropicBaseUrl || '',
    model.id, model.upstream, protocol])).digest('hex');
}

function mergeEvidence(entry, incoming) {
  if ((incoming.accepted?.tokens || 0) > (entry.accepted?.tokens || 0)) entry.accepted = incoming.accepted;
  if (incoming.passive) {
    const passive = entry.passive ||= {};
    if ((incoming.passive.maxReportedInput || 0) > (passive.maxReportedInput || 0)) {
      const { maxReportedInput, outputBudget, at } = incoming.passive;
      Object.assign(passive, { maxReportedInput, outputBudget: outputBudget || null, at: at || null });
    }
    const error = incoming.passive.lastContextError;
    if (error && (!passive.lastContextError || (error.at || '') > (passive.lastContextError.at || '')))
      passive.lastContextError = error;
  }
  for (const [scope, limit] of Object.entries(incoming.limits || {})) {
    if (tokenCount(limit?.tokens) && (!tokenCount(entry.limits?.[scope]?.tokens) || limit.tokens < entry.limits[scope].tokens))
      (entry.limits ||= {})[scope] = limit;
  }
  if (incoming.probe && (!entry.probe || (incoming.probe.at || '') > (entry.probe.at || ''))) entry.probe = incoming.probe;
}

function createContextCapacity({ file, getConfig, now = () => Date.now() }) {
  const data = readJson(file, { entries: {} });
  for (const entry of Object.values(data.entries)) preserveLegacyEvidence(entry);
  function routes() {
    return getConfig().providers.flatMap(provider => provider.models.flatMap(model => {
      const protocols = model.protocol && model.protocol !== 'auto' ? [model.protocol] : provider.protocol === 'dual' ? ['openai', 'anthropic'] : [provider.protocol || 'openai'];
      return protocols.map(protocol => ({ provider, model, protocol, identity: capacityIdentity(provider, model, protocol) }));
    }));
  }
  // Older files stored one fingerprint per key. Preserve their strongest
  // accepted input, most restrictive explicit limits and latest probe.
  let migrated = false;
  for (const route of routes()) {
    for (const key of route.provider.keys) {
      const legacy = legacyRouteIdentity(route.provider, key, route.model, route.protocol);
      if (!data.entries[legacy]) continue;
      mergeEvidence(data.entries[route.identity] ||= {}, data.entries[legacy]);
      delete data.entries[legacy];
      migrated = true;
    }
  }
  if (migrated) writeJson(file, data);
  function state() {
    return { ok: true,
      entries: routes().map(route => ({ providerId: route.provider.id, model: route.model.id,
        protocol: route.protocol, declared: route.model.maxContext || null, configured: route.model.contextWindow || null, ...structuredClone(data.entries[route.identity] || {}),
        bounds: evidenceBounds(data.entries[route.identity]) })) };
  }
  function budget({ model, protocol, contextWindow } = {}) {
    const selected = [...new Map(modelRoutes(getConfig(), model, protocol).map(route => {
      const identity = capacityIdentity(route.provider, route.model, route.protocol);
      return [identity, { ...route, identity }];
    })).values()];
    if (!selected.length) return null;
    const candidates = selected.map(route => {
      const { identity } = route;
      const bounds = evidenceBounds(data.entries[identity]);
      const configured = tokenCount(contextWindow) || tokenCount(route.model.contextWindow);
      const declared = tokenCount(route.model.maxContext);
      // Successful input is a provisional operating budget only when no window
      // is known. It never increases a configured or explicitly reported cap.
      const accepted = bounds.acceptedLowerBound >= 4096 ? bounds.acceptedLowerBound : null;
      let cap = configured || declared || bounds.confirmedUpperBound || accepted || UNKNOWN_CONTEXT_BUDGET;
      let source = configured ? 'configured' : declared ? 'catalog' : bounds.confirmedUpperBound ? 'confirmed-upper-bound'
        : accepted ? 'accepted-lower-bound' : 'unknown';
      if (declared && declared < cap) { cap = declared; source = 'catalog'; }
      if (bounds.confirmedUpperBound && bounds.confirmedUpperBound <= cap) { cap = bounds.confirmedUpperBound; source = 'confirmed-upper-bound'; }
      return { providerId: route.provider.id, model: route.model.id, protocol: route.protocol,
        cap, source, ...bounds, identity };
    });
    // A request can fail over after its prompt is built. Budget every enabled
    // candidate independently, including unknown candidates, before taking the
    // minimum. Temporary cooldowns must not change this safety envelope.
    const cap = Math.min(...candidates.map(route => route.cap));
    const key = createHash('sha256').update(JSON.stringify(selected.map((route, index) =>
      [candidates[index].identity, route.model.contextWindow || null, route.model.maxContext || null]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
    return { cap, key, source: candidates.find(route => route.cap === cap).source,
      routes: candidates.map(({ identity, ...route }) => route) };
  }
  function publish() {
    const current = new Set(routes().map(route => route.identity));
    for (const identity of Object.keys(data.entries)) if (!current.has(identity)) delete data.entries[identity];
    writeJson(file, data);
  }
  function observe({ provider, model, protocol, ok, tokens = {}, status, detail, maxOutputTokens }) {
    const identity = capacityIdentity(provider, model, protocol);
    if (!routes().some(route => route.identity === identity)) return;
    const boundary = !ok && contextError(status, detail);
    if (!(ok && Number.isSafeInteger(tokens.input) && tokens.input > 0) && !boundary) return;
    const entry = data.entries[identity] ||= {};
    const passive = entry.passive ||= {};
    if (ok && tokens.input > (passive.maxReportedInput || 0)) {
      passive.maxReportedInput = tokens.input;
      passive.outputBudget = maxOutputTokens || null;
      passive.at = new Date(now()).toISOString();
    } else if (boundary) {
      const at = new Date(now()).toISOString();
      passive.lastContextError = { at, declared: boundary.declared, ...(boundary.inputLimit ? { inputLimit: boundary.inputLimit } : {}) };
      recordLimit(entry, boundary, at);
    }
    else return;
    publish();
  }
  return { state, observe, budget };
}

module.exports = { createContextCapacity, contextError, UNKNOWN_CONTEXT_BUDGET };
