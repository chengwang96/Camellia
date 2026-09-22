'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { previewKind } = require('./file-preview');
const { textPaths, documentFormat } = require('../shared/turn-artifacts');

function resolveArtifacts({ paths = [], text = '', cwd = '' } = {}) {
  const files = new Map();
  const references = textPaths(text).filter(candidate => !/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/.test(candidate));
  const candidates = [...paths.slice(0, 100).map(candidate => ({ candidate, explicit: false })),
    ...references.map(candidate => ({ candidate, explicit: true }))];
  for (let { candidate, explicit } of candidates) {
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
      const extension = path.extname(resolved).slice(1).toLowerCase();
      if (kind === 'text' && (/\.(?:test|spec)\.[^.]+$/i.test(resolved)
        || /^(?:package(?:-lock)?\.json|tsconfig(?:\.[^.]+)?\.json|[^.]+\.config\.[^.]+|\.env(?:\..+)?|\.gitignore)$/i.test(path.basename(resolved))
        || ['log', 'lock'].includes(extension))) continue;
      if (kind === 'text' && !explicit && !documentFormat({ extension })
        && !['txt', 'csv', 'tsv', 'rst', 'tex'].includes(extension)) continue;
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
