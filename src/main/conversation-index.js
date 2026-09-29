'use strict';

// /find's primary source is not the filesystem but Camellia's own history. The
// user's case is a file some conversation edited or produced, so the transcript
// already records both the paths and the words used to describe them around
// that turn. Matching against that history is more accurate than walking
// folders, and it reads no file contents at all — a file that has since been
// renamed or moved is still recovered by the name and words it was created
// under.

const path = require('node:path');
const fs = require('node:fs');
const { toolPaths, toolRoots } = require('../shared/turn-artifacts');

const MAX_HISTORY_FILES = 40;
const MAX_SESSIONS = 400;
const MAX_DESCRIPTION_CHARS = 400;

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 1 || /[\u4e00-\u9fff]/.test(token));
}

function wildcard(value) {
  return value.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

function appears(haystack, token) {
  return haystack.includes(token) || new RegExp(wildcard(token)).test(haystack);
}

// Every term must appear somewhere in the record, so two unrelated words cannot
// add up to a match. The file name is the strongest signal and the words used
// around that turn are next; the conversation title only adds weight, because
// it is shared by every file in that conversation and must not pull in files
// that have nothing to do with the query.
function score(nameText, descriptionText, titleText, needles) {
  if (!needles.length) return 0;
  const combined = nameText + ' ' + descriptionText + ' ' + titleText;
  let total = 0, matchedCore = 0;
  for (const token of needles) {
    if (!appears(combined, token)) return 0;
    if (appears(nameText, token)) { total += 8; matchedCore++; }
    else if (appears(descriptionText, token)) { total += 3; matchedCore++; }
    else total += 1;
  }
  return matchedCore ? total : 0;
}

// Replays one conversation's rows into the files it touched, each carrying the
// user words that surrounded the turn. Tool rows are parsed with the same
// helper the artifact collector uses, so a path the artifact filter hides
// (edited source, a config file) is still recovered here.
function entriesOf(rows, { cwd = '', sessionId = '', title = '' } = {}) {
  const files = [];
  let prompt = '';
  let turnRoots = [];
  const pending = new Map();
  const track = (event, roots) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'gui:tool') {
      if (event.input !== undefined) {
        for (const value of toolPaths(event.name, event.input)) pending.set(String(event.id) + ':' + value, value);
        roots.push(...toolRoots(event.input));
      }
      if (['completed', 'failed', 'cancelled'].includes(event.status) && (event.is_error || event.status !== 'completed'))
        for (const key of [...pending.keys()]) if (key.startsWith(String(event.id) + ':')) pending.delete(key);
      return;
    }
    if (event.type === 'assistant') {
      for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (part?.type !== 'tool_use') continue;
        for (const value of toolPaths(part.name, part.input)) pending.set(String(part.id) + ':' + value, value);
        roots.push(...toolRoots(part.input));
      }
      return;
    }
    if (event.type === 'user') for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (part?.type === 'tool_result' && part.is_error)
        for (const key of [...pending.keys()]) if (key.startsWith(String(part.tool_use_id) + ':')) pending.delete(key);
    }
  };
  for (const row of rows) {
    if (row.internal) continue;
    if (row.role === 'user') { prompt = String(row.displayText ?? row.text ?? '').slice(0, MAX_DESCRIPTION_CHARS); turnRoots = []; continue; }
    if (row.role === 'tool') {
      try { track(JSON.parse(row.text), turnRoots); } catch { /* damaged tool row */ }
      continue;
    }
    if (row.role !== 'assistant') continue;
    // A /find reply lists every path it matched, so indexing its wording would
    // make each file inherit its siblings' names; the search is metadata about
    // a lookup, not evidence that the turn authored anything.
    if (row.find) { pending.clear(); continue; }
    // Quoted paths are stripped for the same reason: a normal reply can mention
    // several files, and only the words around them describe this one.
    const words = String(row.text || '').replace(/`[^`\n]+`/g, ' ');
    const description = [prompt, words].filter(Boolean).join(' ').slice(0, MAX_DESCRIPTION_CHARS);
    const recorded = (Array.isArray(row.artifacts) ? row.artifacts : []).map(artifact => artifact?.path).filter(value => typeof value === 'string');
    for (const value of [...recorded, ...pending.values()]) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const resolved = path.isAbsolute(value) ? value : path.resolve(turnRoots[0] || cwd || '', value);
      files.push({ path: resolved, description, sessionId, title, at: Number(row.at) || 0 });
    }
    pending.clear();
  }
  return files;
}

// Builds the name/description index over existing conversations, newest first.
function buildHistoryIndex(manager, { sessions = [], limit = 400 } = {}) {
  const ordered = [...sessions].slice(0, MAX_SESSIONS);
  const files = new Map();
  for (const session of ordered) {
    const conversation = manager.get(session.id);
    if (!conversation) continue;
    if (files.size > limit) break;
    // Sessions arrive newest first; visit their turns in the same order so a
    // timestamp tie retains conversation/turn recency instead of filename order.
    for (const entry of entriesOf(manager.rows(conversation), { cwd: conversation.cwd || '', sessionId: session.id, title: session.title || '' }).reverse()) {
      const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
      if (!files.has(key)) files.set(key, { path: entry.path, descriptions: [], titles: new Set(), sessions: new Set(), at: 0 });
      const record = files.get(key);
      record.sessions.add(session.id);
      if (entry.title) record.titles.add(entry.title);
      if (entry.description && record.descriptions.length < 4) record.descriptions.push(entry.description);
      // A file touched by several turns keeps its most recent turn, so /find
      // without words can order files by when they were last worked on.
      if (entry.at > record.at) record.at = entry.at;
    }
  }
  return [...files.values()];
}

function searchHistory({ query, entries = [], cwd = '', limit = MAX_HISTORY_FILES, language } = {}) {
  const text = String(query || '').trim();
  const needles = tokens(text);
  // With no words there is nothing to match, so the honest answer is the files
  // worked on most recently — what the user wants when they cannot even name
  // the file they are after.
  if (!needles.length) return recentFiles({ entries, cwd, limit });
  const results = [];
  for (const entry of entries) {
    const name = path.basename(entry.path);
    const titles = [entry.title, ...(entry.titles || [])].filter(Boolean).join(' ');
    const description = [entry.description, ...(entry.descriptions || [])].filter(Boolean).join(' ');
    const descriptionText = description.toLowerCase();
    const titleText = titles.toLowerCase();
    const total = score((name).toLowerCase(), descriptionText, titleText, needles);
    if (!total) continue;
    // A name match outranks a description match; a file under the current
    // conversation's folder outranks one from an older conversation elsewhere.
    const workspaceBonus = cwd && entry.path.startsWith(path.resolve(cwd)) ? 3 : 0;
    results.push({ ...entry, titles: [...(entry.titles || [])].slice(0, 3), sessions: [...(entry.sessions || [])],
      score: total + workspaceBonus });
  }
  results.sort((first, second) => second.score - first.score || first.path.localeCompare(second.path));
  return results.slice(0, limit);
}

// Files that still exist come first, newest turn first; a vanished file is only
// listed when there is nothing live to show.
function recentFiles({ entries = [], cwd = '', limit = MAX_HISTORY_FILES } = {}) {
  const live = [], missing = [];
  for (const entry of entries) {
    let exists = false;
    try { exists = fs.statSync(entry.path).isFile(); } catch { exists = false; }
    (exists ? live : missing).push({ ...entry, titles: [...(entry.titles || [])].slice(0, 3),
      sessions: [...(entry.sessions || [])], exists });
  }
  const rank = (first, second) => (second.at || 0) - (first.at || 0);
  live.sort(rank); missing.sort(rank);
  return [...live, ...missing].slice(0, limit);
}

module.exports = { buildHistoryIndex, searchHistory, recentFiles, entriesOf, MAX_HISTORY_FILES };
