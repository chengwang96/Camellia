'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { previewKind } = require('./file-preview');
const { textPaths, documentFormat } = require('../shared/turn-artifacts');

function describeArtifact(resolved, explicit) {
  const kind = previewKind(resolved);
  if (kind === 'unsupported') return null;
  const extension = path.extname(resolved).slice(1).toLowerCase();
  if (kind === 'text' && (/\.(?:test|spec)\.[^.]+$/i.test(resolved)
    || /^(?:package(?:-lock)?\.json|tsconfig(?:\.[^.]+)?\.json|[^.]+\.config\.[^.]+|\.env(?:\..+)?|\.gitignore)$/i.test(path.basename(resolved))
    || ['log', 'lock'].includes(extension))) return null;
  if (kind === 'text' && !explicit && !documentFormat({ extension })
    && !['txt', 'csv', 'tsv', 'rst', 'tex'].includes(extension)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return null;
  return { canonical: fs.realpathSync(resolved), kind,
    file: { path: resolved, name: path.basename(resolved), kind,
      extension: path.extname(resolved).slice(1).toUpperCase(), size: stat.size } };
}

function targetsFor(candidate, bases) {
  const value = candidate.trim();
  if (/^file:/i.test(value)) return [fileURLToPath(value)];
  let relative = value.replace(/^sandbox:/i, '');
  try { relative = decodeURIComponent(relative); } catch {}
  relative = relative.replace(/#L\d+(?:C\d+)?$|:\d+(?::\d+)?$/, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(relative) && !/^[a-z]:[\\/]/i.test(relative)) return [];
  if (path.isAbsolute(relative)) return [relative];
  return bases.map(base => path.resolve(base, relative));
}

// A turn can produce files outside the conversation workspace (for example when
// its commands ran in another project directory), so relative references are
// resolved against the workspace and every directory the turn's tools used.
function resolveArtifacts({ paths = [], text = '', cwd = '', roots = [] } = {}) {
  const files = new Map();
  const bases = [cwd, ...roots].filter(base => typeof base === 'string' && base.trim());
  const references = textPaths(text).filter(candidate => !/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/.test(candidate));
  const candidates = [...paths.slice(0, 100).map(candidate => ({ candidate, explicit: false })),
    ...references.map(candidate => ({ candidate, explicit: true }))];
  for (const { candidate, explicit } of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    let targets = [];
    try {
      targets = targetsFor(candidate, bases);
    } catch {}
    for (const target of targets) {
      try {
        const entry = describeArtifact(target, explicit);
        if (!entry) continue;
        const key = process.platform === 'win32' ? entry.canonical.toLowerCase() : entry.canonical;
        if (!files.has(key)) files.set(key, entry.file);
        break;
      } catch {}
    }
  }
  return [...files.values()];
}

module.exports = { resolveArtifacts };
