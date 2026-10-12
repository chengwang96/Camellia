'use strict';

const { estimateTokens, estimateAggregateTokens, priceFor } = require('./subscription-pricing');

const TOKENS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const SAMPLE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const PRICING = ['estimatedCostUsd', 'pricedTokens', 'unpricedTokens', 'approximateTokens'];
const number = value => Number.isFinite(value) && value >= 0;
const keyOf = (account, day, model) => JSON.stringify([account, day, model]);
const sampleOf = value => ({ input: value.inputTokens || 0, output: value.outputTokens || 0,
  cacheRead: value.cacheReadTokens || 0, cacheWrite: value.cacheWriteTokens || 0 });

function historyTargets(data) {
  const result = [];
  for (const [account, value] of Object.entries(data.accounts)) {
    for (const [day, models] of Object.entries(value.usage?.daily || {})) {
      for (const [model, usage] of Object.entries(models)) {
        if (usage.unpricedTokens > 0 && priceFor(model)) result.push({ account, engine: value.engine, accountId: value.accountId, day, model });
      }
    }
  }
  return result;
}

function recoveredCost(row, usage, model) {
  if (!row || !Array.isArray(row.samples) || row.turns !== (usage.requests || 0) + (usage.failures || 0) + (usage.cancelled || 0)) return null;
  const sum = Object.fromEntries(TOKENS.map(field => [field, 0]));
  let cost = 0;
  for (const sample of row.samples) {
    if (sample.aggregate) return null;
    const amount = estimateTokens(model, sample);
    if (amount === null) return null;
    cost += amount;
    for (let i = 0; i < TOKENS.length; i++) sum[TOKENS[i]] += sample[SAMPLE_FIELDS[i]] || 0;
  }
  return TOKENS.every(field => sum[field] === (usage[field] || 0)) ? cost : null;
}

// Replace pricing only. Request counts, token totals, dates and usage gaps are
// preserved. A complete native day must match every token bucket and turn
// count before its per-request tiers can replace the saved estimate.
function recalculateHistory(data, recovered = []) {
  const accounts = structuredClone(data.accounts), cleared = new Set(), clearedRemainders = new Set();
  const native = new Map(recovered.map(row => [keyOf(row.account, row.day, row.model), row]));
  const result = { repricedTokens: 0, recoveredTokens: 0, estimatedTokens: 0 };
  function replace(usage, parents, model, row) {
    const total = (usage.inputTokens || 0) + (usage.outputTokens || 0), unpriced = usage.unpricedTokens || 0;
    if (!unpriced || ![...TOKENS, ...PRICING].every(field => number(usage[field] ?? 0))
      || (usage.pricedTokens || 0) + unpriced !== total) return false;
    const exact = recoveredCost(row, usage, model);
    const cost = exact ?? estimateAggregateTokens(model, sampleOf(usage));
    if (cost === null) return false;
    const approximate = exact === null ? total : 0;
    const next = { estimatedCostUsd: cost, pricedTokens: total, unpricedTokens: 0, approximateTokens: approximate };
    const delta = Object.fromEntries(PRICING.map(field => [field, next[field] - (usage[field] || 0)]));
    if (parents.some(parent => PRICING.some(field => !number(parent[field] ?? 0) || (parent[field] || 0) + delta[field] < -1e-8))) return false;
    for (const parent of parents) for (const field of PRICING) parent[field] = Math.max(0, (parent[field] || 0) + delta[field]);
    Object.assign(usage, next);
    result.repricedTokens += unpriced;
    result[approximate ? 'estimatedTokens' : 'recoveredTokens'] += unpriced;
    return true;
  }
  for (const [account, value] of Object.entries(accounts)) {
    const usage = value.usage;
    if (!usage?.unpricedTokens) continue;
    for (const [day, models] of Object.entries(usage.daily || {})) {
      for (const [model, bucket] of Object.entries(models)) {
        const lifetime = usage.byModel?.[model];
        if (!lifetime || !priceFor(model)) continue;
        const key = keyOf(account, day, model);
        if (replace(bucket, [usage, lifetime], model, native.get(key))) cleared.add(key);
      }
    }
    // Daily charts retain only 90 days. Recalculate the older remainder using
    // the lifetime model breakdown, subtracting daily buckets once.
    for (const [model, lifetime] of Object.entries(usage.byModel || {})) {
      if (!lifetime.unpricedTokens || !priceFor(model)) continue;
      const remainder = Object.fromEntries([...TOKENS, ...PRICING].map(field => [field, lifetime[field] || 0]));
      for (const models of Object.values(usage.daily || {})) {
        if (!models[model]) continue;
        for (const field of Object.keys(remainder)) remainder[field] -= models[model][field] || 0;
      }
      if (Math.abs(remainder.estimatedCostUsd) < 1e-8) remainder.estimatedCostUsd = 0;
      if (replace(remainder, [usage, lifetime], model)) clearedRemainders.add(JSON.stringify([account, model]));
    }
  }
  const pendingPricing = (data.pendingPricing || []).filter(row => !cleared.has(keyOf(row.account, row.day, row.model))
    && !(clearedRemainders.has(JSON.stringify([row.account, row.model])) && !accounts[row.account]?.usage?.daily?.[row.day]?.[row.model]));
  return { accounts, pendingPricing, result };
}

module.exports = { historyTargets, recalculateHistory };
