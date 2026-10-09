'use strict';

// Refresh the small offline price reference. Never run in response to a chat turn.
// Prices are standard text API equivalents, not subscription charges.
const fs = require('node:fs');
const path = require('node:path');
const { fetchCatalog } = require('../src/api/subscription-price-catalog');

async function main() {
  const catalog = await fetchCatalog();
  const target = path.resolve(__dirname, '../src/api/subscription-prices.json');
  fs.writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n');
  process.stdout.write(`Saved ${Object.keys(catalog.models).length} standard text API prices.\n`);
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
