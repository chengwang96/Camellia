'use strict';

// /find powers a plain-language file search from the desktop composer and the
// paired phone. It walks the folders the conversation actually belongs to and
// returns real files that the existing artifact list and download flow can
// serve unchanged.

const fs = require('node:fs');
const path = require('node:path');
const { previewKind } = require('./file-preview');
const { extractText, readable } = require('./file-text');

const MAX_RESULTS = 20;
const MAX_VISITED = 20_000;
const MAX_DEPTH = 8;
const DEFAULT_ENTRIES = 100_000;
// Content mode has to sample files rather than filter names, so it gets its own
// tighter budget: the model waits for this call and a whole tree of large
// documents must not stall the turn.
const MAX_CONTENT_FILES = 240;
const MAX_CONTENT_BYTES = 48 * 1024 * 1024;
const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_PARTS = 400;
const SNIPPET_CHARS = 320;
// Dependency trees and caches dwarf a user's documents and never hold the
// deliverable being looked for, so the default walk skips them. Build output
// folders are deliberately searched: an installer, APK or exported document
// usually lives in `dist/` or `build/`, which is exactly what /find is for.
const IGNORED_DIRECTORIES = new Set(['.git', '.svn', '.hg', 'node_modules', 'bower_components', 'vendor',
  '__pycache__', '.venv', 'venv', '.tox', '.gradle', '.idea', '.vscode', '.cache',
  'coverage', '.next', '.nuxt', '.pytest_cache']);
// Files that are almost never a user deliverable but are noisy matches.
const IGNORED_FILES = [/^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock)$/i,
  /\.(?:pyc|pyo|class|o|obj|a|lib|dll|so|dylib|pdb|map|min\.js|min\.css|tsbuildinfo)$/i];

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1 || /[\u4e00-\u9fff]/.test(token));
}

function wildcard(value) {
  return value.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

function matches(name, extension, query) {
  const haystack = (name + ' ' + extension).toLowerCase();
  const needles = tokens(query);
  if (!needles.length) return true;
  return needles.every(token => haystack.includes(token) || new RegExp(wildcard(token)).test(haystack));
}

function rootsFor({ cwd, workspacePath, workspaceId, workspaces = [], roots = [] }) {
  const seen = new Set();
  const directories = [];
  const add = value => {
    if (typeof value !== 'string' || !value.trim()) return;
    let resolved;
    try { resolved = fs.realpathSync.native(value); } catch { try { resolved = path.resolve(value); } catch { return; } }
    let stats;
    try { stats = fs.statSync(resolved); } catch { return; }
    if (!stats.isDirectory()) return;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    directories.push(resolved);
  };
  for (const root of roots) add(root);
  add(cwd);
  add(workspacePath);
  if (workspaceId) for (const workspace of workspaces) if (workspace && workspace.id === workspaceId) add(workspace.path);
  return directories;
}

function walk(directory, query, results, budget) {
  const stack = [{ directory, depth: 0 }];
  while (stack.length && results.length < MAX_RESULTS && budget.visited < MAX_VISITED && budget.entries > 0) {
    const { directory: current, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (budget.visited >= MAX_VISITED || budget.entries <= 0 || results.length >= MAX_RESULTS) break;
      budget.visited++;
      const name = entry.name;
      if (name.startsWith('.') && name !== '.env') continue;
      let stats = null;
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || IGNORED_DIRECTORIES.has(name.toLowerCase())) continue;
        budget.entries--;
        stack.push({ directory: path.join(current, name), depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      budget.entries--;
      if (IGNORED_FILES.some(pattern => pattern.test(name))) continue;
      const extension = path.extname(name).slice(1).toUpperCase();
      if (!matches(name, extension, query)) continue;
      let kind;
      try {
        stats = fs.statSync(path.join(current, name));
        if (!stats.isFile()) continue;
        kind = previewKind(name);
      } catch { continue; }
      // The artifact list only carries file kinds it can hand over; a match it
      // cannot serve is still reported by name so the search is never silently
      // incomplete, but it is not quoted as a downloadable path.
      results.push({ path: path.join(current, name), name, extension: extension || 'file',
        kind: kind === 'unsupported' ? 'document' : kind, deliverable: kind !== 'unsupported',
        size: stats.size, modifiedAt: stats.mtimeMs });
    }
  }
}

// Every candidate a content search may look inside. This is a plain collect
// pass: the caller samples the text so the async work stays out of the walk.
function collectReadable(roots, budget) {
  const files = [];
  for (const root of roots) {
    const stack = [{ directory: root, depth: 0 }];
    while (stack.length && files.length < MAX_CONTENT_FILES && budget.visited < MAX_VISITED && budget.entries > 0) {
      const { directory: current, depth } = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (budget.visited >= MAX_VISITED || budget.entries <= 0 || files.length >= MAX_CONTENT_FILES) break;
        budget.visited++;
        const name = entry.name;
        if (name.startsWith('.') && name !== '.env') continue;
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH || IGNORED_DIRECTORIES.has(name.toLowerCase())) continue;
          budget.entries--;
          stack.push({ directory: path.join(current, name), depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        budget.entries--;
        if (IGNORED_FILES.some(pattern => pattern.test(name))) continue;
        const kind = readable(name);
        if (!kind) continue;
        let stats;
        try {
          stats = fs.statSync(path.join(current, name));
          if (!stats.isFile()) continue;
        } catch { continue; }
        files.push({ path: path.join(current, name), name, kind, size: stats.size, modifiedAt: stats.mtimeMs });
      }
    }
  }
  return files;
}

function snippet(text, token) {
  const at = text.toLowerCase().indexOf(token);
  if (at < 0) return text.slice(0, SNIPPET_CHARS).trim();
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  return text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// The reply is plain Markdown that quotes each downloadable result as an inline
// code path, so the desktop artifact panel and the Android download sheet pick
// the files up through their existing reference parsing.
const MESSAGES = {
  en: { none: (query, roots) => ['No files matched "' + query + '".', '',
      roots.length ? 'Searched: ' + roots.map(root => '`' + root + '`').join(', ') : 'There were no folders to search.',
      'Try a file name or extension (for example `report`, `.pptx` or `*2024*`).'].join('\n'),
    found: (count, query) => 'Found ' + count + ' file' + (count === 1 ? '' : 's') + ' for "' + query + '":',
    listed: count => count + ' more match the search but cannot be offered for download:',
    download: 'Open or download any of these from the files below.',
    matched: query => 'Found files containing "' + query + '":',
    empty: 'Describe the file you are looking for', tooLong: 'Search text is too long' },
  zh: { none: (query, roots) => ['没有找到与「' + query + '」匹配的文件。', '',
      roots.length ? '已搜索：' + roots.map(root => '`' + root + '`').join('、') : '当前没有可搜索的目录。',
      '可以试试文件名或扩展名（例如 `报告`、`.pptx` 或 `*2024*`）。'].join('\n'),
    found: (count, query) => '为「' + query + '」找到 ' + count + ' 个文件：',
    listed: count => '另有 ' + count + ' 个匹配项不支持在此下载，仅列出：',
    download: '可以在下方直接打开或下载这些文件。',
    matched: query => '找到了包含「' + query + '」的文件：',
    empty: '请描述你要找的文件', tooLong: '搜索内容过长' },
};

function replyFor(query, results, roots, language, mode = 'name') {
  const copy = MESSAGES[String(language || '').startsWith('zh') ? 'zh' : 'en'];
  if (!results.length) {
    return copy.none(query, roots);
  }
  const deliverable = results.filter(file => file.deliverable);
  const listed = results.filter(file => !file.deliverable);
  const lines = [];
  if (deliverable.length) {
    lines.push(mode === 'content' ? copy.matched(query) : copy.found(deliverable.length, query), '');
    for (const file of deliverable) {
      lines.push('- `' + file.path + '` — ' + [escapeCell(file.extension), formatSize(file.size), escapeCell(path.dirname(file.path))].filter(Boolean).join(' · '));
      if (file.snippet) lines.push('  ' + escapeCell(file.snippet));
    }
  }
  if (listed.length) {
    if (lines.length) lines.push('');
    lines.push(copy.listed(listed.length));
    for (const file of listed) {
      lines.push('- ' + [file.name, escapeCell(file.extension), formatSize(file.size)].filter(Boolean).join(' · '));
      if (file.snippet) lines.push('  ' + escapeCell(file.snippet));
    }
  }
  if (deliverable.length) lines.push('', copy.download);
  return lines.join('\n');
}

// `roots` is optional: the remote gateway resolves them from the conversation,
// while the desktop renderer already knows its workspace folder.
function searchFiles({ query, cwd, workspacePath, workspaceId, workspaces, roots, language } = {}) {
  const copy = MESSAGES[String(language || '').startsWith('zh') ? 'zh' : 'en'];
  const text = String(query || '').trim();
  if (!text) throw new Error(copy.empty);
  if (text.length > 500) throw new Error(copy.tooLong);
  const searched = rootsFor({ cwd, workspacePath, workspaceId, workspaces, roots });
  const results = [];
  const budget = { visited: 0, entries: DEFAULT_ENTRIES };
  for (const root of searched) {
    if (results.length >= MAX_RESULTS || budget.visited >= MAX_VISITED) break;
    walk(root, text, results, budget);
  }
  results.sort((first, second) => second.modifiedAt - first.modifiedAt || first.name.localeCompare(second.name));
  return { query: text, results, roots: searched, text: replyFor(text, results, searched, language) };
}

// Content search answers the case a name search cannot: the user knows a file
// exists but not what it is called. Every readable file in the conversation's
// folders is sampled and matched against the query terms, and each hit carries
// a snippet so a model can judge the match instead of guessing.
async function searchContents({ query, cwd, workspacePath, workspaceId, workspaces, roots, language, limit = 20 } = {}) {
  const copy = MESSAGES[String(language || '').startsWith('zh') ? 'zh' : 'en'];
  const text = String(query || '').trim();
  if (!text) throw new Error(copy.empty);
  if (text.length > 500) throw new Error(copy.tooLong);
  const needles = tokens(text).filter(token => !/[*?]/.test(token));
  if (!needles.length) return searchFiles({ query: text, cwd, workspacePath, workspaceId, workspaces, roots, language });
  const searched = rootsFor({ cwd, workspacePath, workspaceId, workspaces, roots });
  const budget = { visited: 0, entries: DEFAULT_ENTRIES };
  const candidates = collectReadable(searched, budget);
  const results = [];
  let sampledBytes = 0;
  for (const file of candidates) {
    if (results.length >= limit || sampledBytes >= MAX_CONTENT_BYTES) break;
    if (file.size > MAX_CONTENT_BYTES || sampledBytes + Math.min(file.size, MAX_SAMPLE_BYTES) > MAX_CONTENT_BYTES) continue;
    let body;
    try { body = await extractText(file.path, file.kind); } catch { continue; }
    sampledBytes += Math.min(file.size, MAX_SAMPLE_BYTES);
    if (!body) continue;
    const haystack = body.toLowerCase();
    // Every term must appear, so "quarterly revenue" does not match a file that
    // only says "revenue" somewhere unrelated.
    if (!needles.every(token => haystack.includes(token))) continue;
    const kind = previewKind(file.name);
    results.push({ path: file.path, name: file.name, extension: path.extname(file.name).slice(1).toUpperCase() || 'file',
      kind: kind === 'unsupported' ? 'document' : kind, deliverable: kind !== 'unsupported',
      size: file.size, modifiedAt: file.modifiedAt, snippet: snippet(body, needles[0]) });
  }
  results.sort((first, second) => second.modifiedAt - first.modifiedAt || first.name.localeCompare(second.name));
  return { query: text, results, roots: searched, text: replyFor(text, results, searched, language, 'content'), sampled: sampledBytes };
}

module.exports = { searchFiles, searchContents, MAX_RESULTS };
