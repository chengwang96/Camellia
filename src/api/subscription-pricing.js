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
  const aliases = { 'kimi-code/k3': 'kimi-k3', 'kimi-code/k2.6': 'kimi-k2.6', 'kimi-code/k2.5': 'kimi-k2.5' };
  const name = aliases[model] || model;
  return Object.hasOwn(catalog.models, name) ? catalog.models[name] : null;
}
function estimateTokens(model, sample) {
  const price = priceFor(model);
  if (!price || sample.reported === false) return null;
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = sample;
  if (![input, output, cacheRead, cacheWrite].every(n => Number.isFinite(n) && n >= 0) || cacheRead + cacheWrite > input) return null;
  // Input includes both cache buckets; reasoning is already inside output.
  // Turn aggregates cannot select a per-request context tier reliably.
  if (price.threshold && sample.aggregate) return null;
  const rates = price.threshold && input > price.threshold ? price.long : price;
  if (!rates || cacheRead && rates.cacheRead == null || cacheWrite && rates.cacheWrite == null) return null;
  return ((input - cacheRead - cacheWrite) * rates.input + output * rates.output
    + cacheRead * (rates.cacheRead || 0) + cacheWrite * (rates.cacheWrite || 0)) / 1e6;
}

module.exports = { estimateTokens, priceFor, catalogInfo, installCatalog };
