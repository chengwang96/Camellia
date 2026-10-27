'use strict';

// Refresh the small offline price reference. Never run in response to a chat turn.
// Prices are standard text API equivalents, not subscription charges.
const fs = require('node:fs');
const path = require('node:path');
const { fetchCatalog } = require('../src/api/subscription-price-catalog');

const OFFICIAL_PRICES = {
  'kimi-k3.1-pro': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: null },
  'kimi-k3.1-pro-highspeed': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: null },
};

async function main() {
  const catalog = await fetchCatalog();
  Object.assign(catalog.models, OFFICIAL_PRICES);
  const target = path.resolve(__dirname, '../src/api/subscription-prices.json');
  fs.writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n');
  process.stdout.write(`Saved ${Object.keys(catalog.models).length} standard text API prices.\n`);
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
