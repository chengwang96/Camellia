'use strict';

const bundled = require('./subscription-prices.json');
let catalog = bundled;
const catalogInfo = { source: catalog.source, checkedAt: catalog.checkedAt, basis: 'standard-text-api', currency: 'USD', origin: 'bundled', refreshing: false };
function installCatalog(value, origin = 'cache') {
  if (!require('./subscription-price-catalog').validCatalog(value)) throw new Error('Invalid price catalog');
  catalog = { ...value, models: { ...bundled.models, ...value.models } };
  Object.assign(catalogInfo, { source: value.source, checkedAt: value.checkedAt, origin });
}

function priceFor(model) {
  // Only explicit, stable aliases. Unknown routing/auto aliases remain unpriced.
  const aliases = { 'kimi-code/k3': 'kimi-k3', 'kimi-code/k2.6': 'kimi-k2.6', 'kimi-code/k2.5': 'kimi-k2.5',
    // Antigravity exposes Opus 4.6 thinking under a separate model ID.
    'claude-opus-4-6-thinking': 'claude-opus-4-6' };
  const name = aliases[model] || model;
  return Object.hasOwn(catalog.models, name) ? catalog.models[name] : null;
}
function estimateTokens(model, sample) {
  const price = priceFor(model);
  if (!price || sample.reported === false) return null;
  // Input includes both cache buckets; reasoning is already inside output.
  // Turn aggregates cannot select a per-request context tier reliably.
  if (price.threshold && sample.aggregate) return null;
  const rates = price.threshold && sample.input > price.threshold ? price.long : price;
  return estimateAtRates(rates, sample);
}
function estimateAtRates(rates, sample) {
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = sample;
  if (sample.reported === false || ![input, output, cacheRead, cacheWrite].every(n => Number.isFinite(n) && n >= 0)
    || cacheRead + cacheWrite > input) return null;
  if (!rates || cacheRead && rates.cacheRead == null || cacheWrite && rates.cacheWrite == null) return null;
  return ((input - cacheRead - cacheWrite) * rates.input + output * rates.output
    + cacheRead * (rates.cacheRead || 0) + cacheWrite * (rates.cacheWrite || 0)) / 1e6;
}
// Historical totals may span thousands of requests. Their summed input is
// never a single long-context request; use base rates and label tiered models
// as historical estimates when the individual requests cannot be recovered.
function estimateAggregateTokens(model, sample) {
  return estimateAtRates(priceFor(model), sample);
}

module.exports = { estimateTokens, estimateAggregateTokens, priceFor, catalogInfo, installCatalog };
