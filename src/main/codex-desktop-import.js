'use strict';

// Import sessions from the local Codex desktop app, read-only. The desktop app
// indexes its threads in ~/.codex/state_5.sqlite; message content lives in the
// shared rollout JSONL files under ~/.codex/sessions/. We never write there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function desktopStatePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.codex', 'state_5.sqlite');
}

// Open a snapshot copy: the desktop app holds the live database and may be
// running, so we never open its file directly.
function withSnapshot(file, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-import-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = file + suffix;
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, 'state.sqlite' + suffix));
    }
    const db = new DatabaseSync(path.join(dir, 'state.sqlite'), { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function cleanPath(p) {
  return typeof p === 'string' && p.startsWith('\\\\?\\') ? p.slice(4) : p;
}

// Sub-agent spawn rows duplicate their parent thread's content.
function isSubagentSource(source) {
  return typeof source === 'string' && source.trim().startsWith('{');
}

// Desktop titles and first messages can carry the synthetic "files mentioned"
// wrapper; unwrap to the user's actual request when present.
function cleanTitle(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  const marker = '## My request:';
  const at = text.indexOf(marker);
  if (at >= 0) text = text.slice(at + marker.length).trim();
  return text;
}

function listDesktopSessions(stateFile, { excludeIds = new Set() } = {}) {
  if (!fs.existsSync(stateFile)) return [];
  return withSnapshot(stateFile, db => {
    const rows = db.prepare(`SELECT id, title, first_user_message, preview, cwd, source, rollout_path,
        COALESCE(created_at_ms, created_at * 1000) AS createdAt, COALESCE(updated_at_ms, updated_at * 1000) AS updatedAt
      FROM threads WHERE archived = 0 ORDER BY createdAt DESC`).all();
    return rows.filter(r => !isSubagentSource(r.source) && !excludeIds.has(r.id)).map(r => ({
      id: r.id,
      title: (cleanTitle(r.title) || cleanTitle(r.first_user_message || r.preview)).slice(0, 60) || '(Untitled)',
      cwd: r.cwd || '', createdAt: r.createdAt, updatedAt: r.updatedAt,
      source: r.source, rolloutPath: cleanPath(r.rollout_path),
      importable: fs.existsSync(cleanPath(r.rollout_path)),
    }));
  });
}

// Rollout JSONL keeps both response_item and event_msg copies of a turn; the
// response_item message rows are canonical here. Tool calls and reasoning are
// not imported.
function readRolloutMessages(rolloutPath) {
  const file = cleanPath(rolloutPath);
  const messages = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'response_item') continue;
    const payload = row.payload || {};
    if (payload.type !== 'message') continue;
    const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const parts = Array.isArray(payload.content) ? payload.content : [];
    let text = parts.filter(p => p.type === 'input_text' || p.type === 'output_text').map(p => p.text || '').join('\n').trim();
    if (!text) continue;
    if (role === 'user') {
      if (text.startsWith('<environment_context') || text.startsWith('# AGENTS.md')) continue;
      const myRequest = text.indexOf('## My request:');
      if (myRequest >= 0) text = text.slice(myRequest + '## My request:'.length).trim();
      if (!text) continue;
    }
    messages.push({ role, text, at: Date.parse(row.timestamp) || Date.now() });
  }
  // A rollout can repeat rows across compaction; drop exact consecutive repeats.
  return messages.filter((m, i) => !i || m.role !== messages[i - 1].role || m.text !== messages[i - 1].text);
}

function importDesktopSessions(shared, stateFile, ids, log = () => {}) {
  const sessions = listDesktopSessions(stateFile);
  const selected = sessions.filter(s => ids.includes(s.id));
  const imported = [], skipped = [];
  for (const session of selected) {
    try {
      const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : undefined;
      const c = shared.create('codex', null, session.title, cwd);
      c.importedFrom = 'codex-desktop';
      c.importThreadId = session.id;
      c.createdAt = session.createdAt || Date.now();
      c.updatedAt = session.updatedAt || c.createdAt;
      let count = 0;
      for (const message of readRolloutMessages(session.rolloutPath)) {
        shared.append(c, { role: message.role, engine: 'codex', text: message.text, displayText: message.text, attachments: [] });
        count++;
      }
      shared.save(c);
      imported.push({ id: c.id, threadId: session.id, title: c.title, messages: count });
    } catch (error) {
      log('codex desktop import failed for ' + session.id + ': ' + error.message);
      skipped.push({ threadId: session.id, error: error.message });
    }
  }
  return { imported, skipped };
}

module.exports = { desktopStatePath, listDesktopSessions, readRolloutMessages, importDesktopSessions };
