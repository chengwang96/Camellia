'use strict';

const { readJson, writeJson } = require('../shared/json-store');
const { recordUsage, dayId } = require('./api-usage');
const { estimateTokens, catalogInfo } = require('./subscription-pricing');

const ENGINES = new Set(['codex', 'kimi', 'antigravity']);
const EXTRA = ['reasoningTokens', 'estimatedCostUsd', 'pricedTokens', 'unpricedTokens'];
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
function subscriptionProfiles(config) {
  const names = { codex: 'ChatGPT / Codex', kimi: 'Kimi Code', antigravity: 'Google / Antigravity' };
  return Object.keys(names).flatMap(engine => require('../engines/subscription-accounts').accountsFor(config, engine)
    .map(account => ({ id: `${engine}:${account.id}`, engine, accountId: account.id,
      provider: names[engine], label: account.label || `${names[engine]} · ${account.id}` })));
}

// Separate from API-key counters: native subscription traffic bypasses the router.
// Only usage metadata is saved; credentials and conversation text never enter this file.
function createSubscriptionUsage({ file, onChange = () => {}, now = () => new Date() }) {
  const data = readJson(file, { version: 1, since: now().toISOString(), accounts: {}, recent: [] });
  let seen = new Set(data.recent || []), error = null;
  function state(profiles = []) {
    const accounts = new Map(Object.entries(data.accounts).map(([id, account]) => [id, { id, ...structuredClone(account) }]));
    for (const profile of profiles) accounts.set(profile.id, { ...accounts.get(profile.id), ...profile });
    return { since: data.since, pricing: catalogInfo, error, accounts: [...accounts.values()] };
  }
  function record({ id, engine, accountId = 'default', model, samples = [], outcome = 'requests', at = now(), incomplete = false }) {
    if (!ENGINES.has(engine) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(accountId) || !id || seen.has(id)) return false;
    if (!['requests', 'failures', 'cancelled'].includes(outcome)) throw new Error('Invalid usage outcome');
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid usage date');
    const key = `${engine}:${accountId}`;
    const oldAccount = data.accounts[key] && structuredClone(data.accounts[key]), oldRecent = data.recent;
    const account = data.accounts[key] ||= { engine, accountId, label: accountId, usage: {} };
    const groups = new Map();
    for (const sample of samples) {
      const name = String(sample.model || model || 'Unknown model');
      if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
      const value = groups.get(name) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: true,
        reasoningTokens: 0, estimatedCostUsd: 0, pricedTokens: 0, unpricedTokens: 0 };
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) value[field] += count(sample[field]);
      value.reasoningTokens += count(sample.reasoning);
      const tokens = count(sample.input) + count(sample.output);
      const cost = estimateTokens(name, sample);
      if (cost === null) value.unpricedTokens += tokens;
      else { value.estimatedCostUsd += cost; value.pricedTokens += tokens; }
      groups.set(name, value);
    }
    if (!groups.size) groups.set(model && !['__proto__', 'constructor', 'prototype'].includes(model) ? model : 'Unknown model',
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: false });
    let first = true;
    for (const [name, tokens] of groups) {
      // One completed turn even when it uses several models. Extra model rows
      // carry tokens but do not multiply the turn count.
      recordUsage(account.usage, name, tokens, first ? outcome : 'tokensOnly', date);
      for (const bucket of [account.usage, account.usage.byModel[name], account.usage.daily[dayId(date)][name]]) {
        for (const field of EXTRA) bucket[field] = (bucket[field] || 0) + count(tokens[field]);
        if (first && (incomplete && tokens.reported || !tokens.reported && outcome !== 'requests')) bucket.unreported = (bucket.unreported || 0) + 1;
      }
      first = false;
    }
    seen.add(id);
    data.recent = [...seen].slice(-10000);
    while (seen.size > 10000) seen.delete(seen.values().next().value);
    try { writeJson(file, data); error = null; }
    catch (failure) {
      if (oldAccount) data.accounts[key] = oldAccount; else delete data.accounts[key];
      data.recent = oldRecent; seen = new Set(oldRecent || []);
      error = 'Subscription usage could not be saved.';
      onChange();
      throw failure;
    }
    onChange();
    return true;
  }
  return { state, record };
}

module.exports = { createSubscriptionUsage, subscriptionProfiles };
