'use strict';

// Refresh the small offline price reference. Never run in response to a chat turn.
// Prices are standard text API equivalents, not subscription charges.
const fs = require('node:fs');
const path = require('node:path');
const source = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

async function main() {
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Price catalog: HTTP ${response.status}`);
  const upstream = await response.json(), models = {};
  for (const [key, row] of Object.entries(upstream)) {
    const provider = row.litellm_provider;
    if (!['openai', 'gemini', 'anthropic', 'moonshot'].includes(provider)) continue;
    const model = key.replace(/^(?:gemini|moonshot)\//, '');
    if (!/^(gpt-[56]|gemini-[23]|claude-(opus|sonnet|haiku)-4|kimi-k[23])/.test(model)
      || /image|audio|live|tts|realtime|search|embedding|transcribe/.test(model) || model.includes('/')) continue;
    function rates(suffix = '') {
      const read = key => Number.isFinite(row[key + suffix]) ? Number((row[key + suffix] * 1e6).toFixed(8)) : null;
      return { input: read('input_cost_per_token'), output: read('output_cost_per_token'),
        cacheRead: read('cache_read_input_token_cost'), cacheWrite: read('cache_creation_input_token_cost') };
    }
    const price = rates();
    if (price.input == null || price.output == null) continue;
    const threshold = Object.keys(row).map(key => key.match(/^input_cost_per_token_above_(\d+)k_tokens$/)).find(Boolean);
    if (threshold) { price.threshold = Number(threshold[1]) * 1000; price.long = rates(`_above_${threshold[1]}k_tokens`); }
    models[model] = price;
  }
  if (Object.keys(models).length < 10) throw new Error('Price catalog is incomplete');
  const target = path.resolve(__dirname, '../src/api/subscription-prices.json');
  fs.writeFileSync(target, JSON.stringify({ source, checkedAt: new Date().toISOString().slice(0, 10), models }, null, 2) + '\n');
  process.stdout.write(`Saved ${Object.keys(models).length} standard text API prices.\n`);
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
