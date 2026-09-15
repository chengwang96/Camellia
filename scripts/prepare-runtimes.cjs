'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { npmCandidates } = require('../src/main/runtime-paths');
const patchDsh = require('../integrations/dsh/patch.cjs');
const root = path.resolve(__dirname, '..');
async function prepare({ strict = false, engines = ['dsh', 'kimi', 'claude'] } = {}) {
  const npm = npmCandidates(process.execPath).find(file => fs.existsSync(file));
  const manager = createRuntimeManager({ root, installRoot: root, node: process.execPath, npm,
    onChange: rows => { for (const row of rows) if (row.status === 'installing' || row.status === 'error') console.log(`${row.name}: ${row.message}`); } });
  for (const engine of engines) {
    try {
      if (process.argv.includes('--check') && !manager.locate(engine)) continue;
      await manager.ensure(engine);
      if (engine === 'dsh') patchDsh(path.join(root, 'runtimes/dsh'));
      console.log(`${engine}: ready`);
    } catch (error) {
      if (strict) throw error;
      console.warn(`${engine}: ${error.message}\nOpen Camellia and retry in Settings → Runtime.`);
    }
  }
}
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = prepare;
