'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { previewKind } = require('./file-preview');
const { textPaths } = require('../shared/turn-artifacts');

function resolveArtifacts({ paths = [], text = '', cwd = '' } = {}) {
  const files = new Map();
  for (let candidate of [...paths, ...textPaths(text)].slice(0, 100)) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      candidate = candidate.trim();
      if (/^file:/i.test(candidate)) candidate = fileURLToPath(candidate);
      else {
        candidate = candidate.replace(/^sandbox:/i, '');
        try { candidate = decodeURIComponent(candidate); } catch {}
        candidate = candidate.replace(/#L\d+(?:C\d+)?$|:\d+(?::\d+)?$/, '');
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^[a-z]:[\\/]/i.test(candidate)) continue;
      if (!path.isAbsolute(candidate) && !cwd) continue;
      const resolved = path.resolve(cwd, candidate);
      const kind = previewKind(resolved);
      if (kind === 'unsupported') continue;
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) continue;
      const canonical = fs.realpathSync(resolved);
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (!files.has(key)) files.set(key, { path: resolved, name: path.basename(resolved), kind,
        extension: path.extname(resolved).slice(1).toUpperCase(), size: stat.size });
    } catch {}
  }
  return [...files.values()];
}

module.exports = { resolveArtifacts };
