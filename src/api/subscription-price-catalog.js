'use strict';

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
const { readJson, writeJson } = require('../shared/json-store');

function validRates(rates) {
  return rates && ['input', 'output'].every(key => Number.isFinite(rates[key]) && rates[key] >= 0)
    && ['cacheRead', 'cacheWrite'].every(key => rates[key] == null || Number.isFinite(rates[key]) && rates[key] >= 0);
}
function validCatalog(catalog) {
  return catalog?.source === SOURCE && Number.isFinite(Date.parse(catalog.checkedAt))
    && catalog.models && Object.keys(catalog.models).length >= 10
    && Object.entries(catalog.models).every(([model, price]) => !['__proto__', 'constructor', 'prototype'].includes(model)
      && model.length < 200 && validRates(price)
      && (price.threshold == null || Number.isSafeInteger(price.threshold) && price.threshold > 0 && validRates(price.long)));
}
function transformCatalog(upstream, at = new Date()) {
  const models = {};
  for (const [key, row] of Object.entries(upstream)) {
    if (!row || !['openai', 'gemini', 'anthropic', 'moonshot'].includes(row.litellm_provider)) continue;
    const model = key.replace(/^(?:gemini|moonshot)\//, '');
    if (!/^(gpt-[56]|gemini-[23]|claude-(opus|sonnet|haiku)-4|kimi-k[23])/.test(model)
      || /image|audio|live|tts|realtime|search|embedding|transcribe/.test(model) || model.includes('/')) continue;
    function rates(suffix = '') {
      const read = key => Number.isFinite(row[key + suffix]) ? Number((row[key + suffix] * 1e6).toFixed(8)) : null;
      return { input: read('input_cost_per_token'), output: read('output_cost_per_token'),
        cacheRead: read('cache_read_input_token_cost'), cacheWrite: read('cache_creation_input_token_cost') };
    }
    const price = rates();
    if (!validRates(price)) continue;
    const tiers = Object.keys(row).map(key => key.match(/^input_cost_per_token_above_(\d+)k_tokens$/)).filter(Boolean);
    // The estimator supports one context threshold. Do not guess a multi-tier price.
    if (tiers.length > 1) continue;
    if (tiers.length) { price.threshold = Number(tiers[0][1]) * 1000; price.long = rates(`_above_${tiers[0][1]}k_tokens`); }
    if (price.threshold && !validRates(price.long)) continue;
    models[model] = price;
  }
  const catalog = { source: SOURCE, checkedAt: at.toISOString(), models };
  if (!validCatalog(catalog)) throw new Error('Price catalog is incomplete or invalid');
  return catalog;
}
async function fetchCatalog(fetcher = fetch, at = new Date()) {
  const response = await fetcher(SOURCE, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Price catalog: HTTP ${response.status}`);
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('Price catalog is too large');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) throw new Error('Price catalog is too large');
    chunks.push(Buffer.from(chunk));
  }
  return transformCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')), at);
}
function createPriceRefresh({ file, fetcher = fetch, now = () => new Date(), onChange = () => {} }) {
  const pricing = require('./subscription-pricing');
  const cache = readJson(file, null);
  if (validCatalog(cache) && Date.parse(cache.checkedAt) >= Date.parse(pricing.catalogInfo.checkedAt)) pricing.installCatalog(cache, 'cache');
  let pending = null, timer = null, stopped = false, started = false;
  async function refresh({ force = false } = {}) {
    if (pending) return pending;
    if (!force && now().getTime() - Date.parse(pricing.catalogInfo.checkedAt) < REFRESH_MS) return { ok: true, pricing: { ...pricing.catalogInfo } };
    pricing.catalogInfo.refreshing = true; onChange();
    pending = (async () => {
      try {
        const catalog = await fetchCatalog(fetcher, now());
        writeJson(file, catalog); // Keep the last good catalog if download or disk writes fail.
        pricing.installCatalog(catalog, 'cache');
        delete pricing.catalogInfo.error;
        return { ok: true, pricing: { ...pricing.catalogInfo, refreshing: false } };
      } catch (error) {
        pricing.catalogInfo.error = 'Prices could not be refreshed. The last available catalog is in use.';
        return { ok: false, error: pricing.catalogInfo.error };
      } finally { pricing.catalogInfo.refreshing = false; pending = null; onChange(); }
    })();
    return pending;
  }
  async function tick() {
    await refresh();
    if (!stopped) {
      const delay = pricing.catalogInfo.error ? RETRY_MS : Math.max(1000, REFRESH_MS - (now().getTime() - Date.parse(pricing.catalogInfo.checkedAt)));
      timer = setTimeout(tick, delay); timer.unref?.();
    }
  }
  return { refresh, start: () => { if (started) return; started = true; stopped = false; void tick(); }, stop: () => { stopped = true; started = false; clearTimeout(timer); } };
}
module.exports = { SOURCE, transformCatalog, validCatalog, fetchCatalog, createPriceRefresh };
