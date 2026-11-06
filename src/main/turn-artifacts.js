'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { previewKind } = require('./file-preview');
const { textPaths, ignoredOutputPath } = require('../shared/turn-artifacts');

function describeArtifact(resolved, explicit) {
  const kind = previewKind(resolved);
  if (kind === 'unsupported') return null;
  const extension = path.extname(resolved).slice(1).toLowerCase();
  if (kind === 'text' && (/\.(?:test|spec)\.[^.]+$/i.test(resolved)
    || /^(?:package(?:-lock)?\.json|tsconfig(?:\.[^.]+)?\.json|[^.]+\.config\.[^.]+|\.env(?:\..+)?|\.gitignore)$/i.test(path.basename(resolved))
    || ['log', 'lock'].includes(extension))) return null;
  // Editing a document or source file is not a delivery. Text files must be
  // referenced in the final answer or explicitly supplied by a delivery tool.
  if (kind === 'text' && !explicit) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return null;
  // Native resolution also expands Windows 8.3 aliases (for example RUNNER~1
  // in CI's TEMP), which the JavaScript realpath implementation leaves intact.
  const canonical = fs.realpathSync.native(resolved);
  return { canonical, kind, mtimeMs: stat.mtimeMs,
    file: { path: resolved, canonicalPath: canonical, name: path.basename(resolved), kind,
      extension: path.extname(resolved).slice(1).toUpperCase(), size: stat.size,
      ...(explicit ? { explicitDelivery: true } : {}) } };
}

// A network (UNC) or Windows device path never belongs to a local deliverable,
// and touching one is not a cheap failed lookup: a missing host is a blocking
// SMB name-resolution request, so a single ordinary reference such as the
// `//server/share` in a prose example can freeze the whole app for seconds.
// The rule is applied to every candidate before it reaches the filesystem, so
// the guard cannot be bypassed by resolving the same string against another base.
function networkPath(value) {
  const text = String(value || '').trim();
  return /^\\\\(?![?.]\\)/.test(text) || /^(?:[a-z]:[\\/])*[\\/]{2}(?![\\/])/.test(text);
}

function windowsShellPath(value) {
  if (process.platform !== 'win32') return value;
  // Git Bash spells a drive as /c/Users/...; Windows needs C:/Users/....
  return value.replace(/^\/([a-z])\//i, '$1:/');
}

function targetsFor(candidate, bases) {
  const value = candidate.trim();
  if (/^file:/i.test(value)) return [fileURLToPath(value)];
  let relative = value.replace(/^sandbox:/i, '');
  try { relative = decodeURIComponent(relative); } catch {}
  // Markdown file links can use /D:/folder/file.apk. Windows treats that
  // URL-style drive prefix as an invalid filesystem path until the slash is
  // removed; normalize after decoding so encoded links resolve the same way.
  if (process.platform === 'win32') relative = windowsShellPath(relative.replace(/^\/([a-z]:[\\/])/i, '$1'));
  if (networkPath(relative)) return [];
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
    let found = false;
    for (const target of targets) {
      try {
        if (fs.statSync(target).isDirectory()) {
          found = true;
          if (!directories.includes(target)) directories.push(target);
        }
      } catch {}
    }
    // An explicitly named folder still owns its files after it is removed.
    if (!found && /[\\/]$/.test(candidate.trim()) && targets.length) directories.push(targets[0]);
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
    if (typeof value !== 'string' || !value.trim() || networkPath(value)) continue;
    let resolved;
    try { resolved = path.resolve(windowsShellPath(value)); } catch { continue; }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    try { if (!fs.statSync(resolved).isDirectory()) continue; } catch { continue; }
    directories.push(resolved);
  }
  return directories;
}

// Output paths are only trusted when the file was written during this run and
// sits inside the workspace or a directory the turn's tools used. This keeps a
// command that merely names an existing media file from delivering it.
function insideOutputRoot(file, root) {
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(key(root), key(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  // A scratch folder below the turn's own root is still scratch. The root
  // itself may live in a temp directory when the conversation workspace is
  // temporary, so only segments below it count.
  return !relative.split(/[\\/]/).slice(0, -1).some(segment => ['temp', 'tmp'].includes(segment.toLowerCase()));
}

// A turn can produce files outside the conversation workspace (for example when
// its commands ran in another project directory), so relative references are
// resolved against the workspace and every directory the turn's tools used.
// `explicitPaths` are files the caller already decided are deliverables (a
// file search the user asked for, for example), so they bypass the noise
// filter that keeps edited source and configuration out of a normal turn.
function resolveArtifacts({ paths = [], explicitPaths = [], outputPaths = [], text = '', cwd = '', roots = [], since = 0, reference } = {}) {
  const files = new Map();
  const references = textPaths(text).filter(candidate => !/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/.test(candidate));
  if (reference !== undefined && !references.includes(reference)) return [];
  const candidates = [...paths.slice(0, 100).map(candidate => ({ candidate, explicit: false })),
    ...outputPaths.slice(0, 100).map(candidate => ({ candidate, explicit: false, output: true })),
    ...explicitPaths.slice(0, 100).map(candidate => ({ candidate, explicit: true })),
    ...references.map(candidate => ({ candidate, explicit: true }))];
  const rootsAndCwd = usableRoots([cwd, ...roots]);
  // A command's own working directory is a stronger base for its relative
  // output than the conversation workspace; a same-named old file in the
  // workspace must not win.
  const outputBases = outputPaths.length ? usableRoots([...roots, cwd]) : [];
  const outputRoots = outputBases.map(root => { try { return fs.realpathSync.native(root); } catch { return root; } });
  // A folder the reply names itself is the strongest evidence of where its files
  // live. Bare names stay in that folder instead of falling back to an older
  // copy in the workspace or a directory inferred from a command.
  const named = mentionedDirectories(references, rootsAndCwd);
  const bases = [cwd, ...named, ...rootsAndCwd.slice(1)].filter((base, index, list) => list.indexOf(base) === index);
  for (const { candidate, explicit, output } of candidates) {
    if (reference !== undefined && candidate !== reference) continue;
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    let targets = [];
    try {
      let decoded = candidate.trim();
      try { decoded = decodeURIComponent(decoded); } catch {}
      const referenceBases = output ? outputBases : named.length && references.includes(candidate) && !/[\\/:]/.test(decoded)
        ? named.slice(0, 1) : bases;
      targets = targetsFor(candidate, referenceBases);
    } catch {}
    for (const target of targets) {
      try {
        const entry = describeArtifact(target, explicit);
        if (!entry) continue;
        if (output) {
          if (entry.kind === 'text' || entry.file.size <= 0) continue;
          if (!(since > 0) || entry.mtimeMs < since - 2000) continue;
          if (ignoredOutputPath(entry.canonical)) continue;
          if (!outputRoots.some(root => insideOutputRoot(entry.canonical, root))) continue;
        }
        const key = process.platform === 'win32' ? entry.canonical.toLowerCase() : entry.canonical;
        if (!files.has(key)) files.set(key, entry.file);
        break;
      } catch {}
    }
  }
  return [...files.values()];
}

module.exports = { resolveArtifacts };
