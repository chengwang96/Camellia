'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createRuntimeManager, ENGINES } = require('../src/main/runtime-manager');
const { npmCandidates } = require('../src/main/runtime-paths');
async function prepare({ engines = [], check = false, googleSubscription = false, root = path.resolve(__dirname, '..') } = {}) {
  const npm = npmCandidates(process.execPath).find(file => fs.existsSync(file));
  const manager = createRuntimeManager({ root, installRoot: root, node: process.execPath, npm,
    runtimeMode: engine => engine === 'antigravity' && googleSubscription ? 'subscription' : 'api',
    onChange: rows => { for (const row of rows) if (row.status === 'installing' || row.status === 'error') console.log(`${row.name}: ${row.message}`); } });
  for (const engine of check ? Object.keys(ENGINES) : engines) {
    if (check && !manager.locate(engine)) continue;
    await manager.ensure(engine);
    console.log(`${engine}: ready`);
  }
  if (!check && !engines.length) console.log('Choose engines to download: npm run setup:runtimes -- dsh kimi\nAvailable: claude, codex, dsh, kimi, antigravity. Use --all to install every engine.');
  return manager.state();
}
if (require.main === module) {
  const args = process.argv.slice(2);
  prepare({ check: args.includes('--check'), googleSubscription: args.includes('--google-subscription'),
    engines: args.includes('--all') ? Object.keys(ENGINES) : args.filter(arg => !['--check', '--google-subscription'].includes(arg)) })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = prepare;
