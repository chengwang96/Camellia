'use strict';

const fs = require('node:fs');
const path = require('node:path');

function removeManagedRuntime(dataDir, engine, runtime) {
  if (!['dsh', 'codex', 'kimi', 'claude', 'antigravity', 'pi'].includes(engine)) throw new Error('Unsupported engine');
  const target = path.resolve(dataDir, 'runtimes', engine);
  if (runtime?.external || runtime && path.resolve(runtime.dir) !== target) throw new Error('Only server-managed runtimes can be uninstalled');
  const base = fs.realpathSync(dataDir);
  for (const directory of [path.join(dataDir, 'runtimes'), target]) {
    if (!fs.existsSync(directory)) return { removed: false };
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Linked runtime directories cannot be removed');
    const resolved = fs.realpathSync(directory), relative = path.relative(base, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime directory is outside server storage');
  }
  fs.rmSync(target, { recursive: true, force: false });
  return { removed: true };
}

module.exports = { removeManagedRuntime };
