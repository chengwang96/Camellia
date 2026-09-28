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

// A reply usually names its output folder once and then lists bare file names
// from it, so a directory mentioned in the same turn becomes a base for the
// references that follow. The mention is resolved against the workspace and the
// turn's own command directories first, so a relative folder such as `output/`
// or `.build/` works the same as an absolute one, while a word that is not an
// existing directory never widens the search.
function mentionedDirectories(candidates, bases) {
  const directories = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    let targets = [];
    try { targets = targetsFor(candidate, bases); } catch {}
    for (const target of targets) {
      try {
        if (!directories.includes(target) && fs.statSync(target).isDirectory()) directories.push(target);
      } catch {}
    }
  }
  return directories;
}

// A base is only worth trying if it is a real directory. A command line yields
// tokens that merely look like a folder (a name with a trailing commit-ish
// suffix, an option value, a fragment of a patch), and every candidate is
// resolved against every base, so an entry that cannot match anything would
// make each reference pay for a failed lookup. UNC and device paths are dropped
// for the same reason a filesystem walk skips them: reaching one can block.
function usableRoots(values) {
  const directories = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || /^\\\\/.test(value.trim())) continue;
    let resolved;
    try { resolved = path.resolve(value); } catch { continue; }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    try { if (!fs.statSync(resolved).isDirectory()) continue; } catch { continue; }
    directories.push(resolved);
  }
  return directories;
}

// A turn can produce files outside the conversation workspace (for example when
// its commands ran in another project directory), so relative references are
// resolved against the workspace and every directory the turn's tools used.
// `explicitPaths` are files the caller already decided are deliverables (a
// file search the user asked for, for example), so they bypass the noise
// filter that keeps edited source and configuration out of a normal turn.
function resolveArtifacts({ paths = [], explicitPaths = [], text = '', cwd = '', roots = [] } = {}) {
  const files = new Map();
  const references = textPaths(text).filter(candidate => !/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/.test(candidate));
  const candidates = [...paths.slice(0, 100).map(candidate => ({ candidate, explicit: false })),
    ...explicitPaths.slice(0, 100).map(candidate => ({ candidate, explicit: true })),
    ...references.map(candidate => ({ candidate, explicit: true }))];
  const rootsAndCwd = usableRoots([cwd, ...roots]);
  // A folder the reply names itself is the strongest evidence of where its files
  // live, so it outranks a directory only inferred from a command's arguments,
  // which can still hold an older copy of the same file name (a template source,
  // for example). The conversation workspace keeps its place at the front.
  const named = mentionedDirectories(candidates.map(entry => entry.candidate), rootsAndCwd);
  const bases = [cwd, ...named, ...rootsAndCwd.slice(1)].filter((base, index, list) => list.indexOf(base) === index);
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
