#!/usr/bin/env node
'use strict';
const path = require('node:path');
const os = require('node:os');
const { startApiRouter } = require('../src/api/api-router');
const { loadConfig, writeConfig, normalizeConfig } = require('../src/api/api-router-config');
const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ollama-proxy.json');
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/ollama-proxy-cli.js [--port 8788] [--quota-minutes 15]\nShared API pool. Status: GET /__router/state (keys masked).\n'
      + '--quota-minutes N: how often provider account APIs are read for balances and quota; 0 disables the check.');
    return;
  }
  if (args.includes('--port')) writeConfig(file, normalizeConfig({ ...loadConfig(file), port: Number(args[args.indexOf('--port') + 1]) }));
  const minutes = args.includes('--quota-minutes') ? Number(args[args.indexOf('--quota-minutes') + 1]) : 15;
  const handle = startApiRouter({ configPath: file, log: console.log,
    quotaCheck: { enabled: Number.isFinite(minutes) && minutes > 0, intervalMs: minutes * 60000 } });
  await handle.ready;
  const state = handle.getState();
  console.log(`API router: ${state.url}; ${state.providers.length} providers, ${state.models.length} models. Same-model failover only.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await handle.stop(); process.exit(0); });
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
