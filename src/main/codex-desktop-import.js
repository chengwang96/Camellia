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

function projectForRow(row, projectsByPath) {
  if (row.projectId) return { id: row.projectId, name: row.projectName || '', path: cleanPath(row.projectPath || '') };
  const cwd = cleanPath(row.cwd || '');
  if (!cwd) return null;
  return projectsByPath.get(pathKey(cwd)) || null;
}

function listDesktopSessions(stateFile, { excludeIds = new Set() } = {}) {
  if (!fs.existsSync(stateFile)) return [];
  return withSnapshot(stateFile, db => {
    const rows = db.prepare(`SELECT t.id, t.name, t.title, t.first_user_message, t.preview, t.cwd, t.source, t.rollout_path,
        COALESCE(t.created_at_ms, t.created_at * 1000) AS createdAt, COALESCE(t.updated_at_ms, t.updated_at * 1000) AS updatedAt,
        p.id AS projectId, p.name AS projectName, r.path AS projectPath
      FROM threads t LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN project_roots r ON r.project_id = t.project_id AND r.position = 0
      WHERE t.archived = 0 ORDER BY createdAt DESC`).all();
    const projectsByPath = new Map(db.prepare(`SELECT p.id, p.name, r.path FROM projects p
      JOIN project_roots r ON r.project_id = p.id AND r.position = 0`).all()
      .filter(project => cleanPath(project.path || ''))
      .map(project => [pathKey(cleanPath(project.path)), { id: project.id, name: project.name || '', path: cleanPath(project.path) }]));
    return rows.filter(r => !isSubagentSource(r.source) && !excludeIds.has(r.id)).flatMap(r => {
      const title = cleanTitle(r.name);
      if (!title) return [];
      return [{
        id: r.id, title: title.slice(0, 60),
        cwd: cleanPath(r.cwd || ''), createdAt: r.createdAt, updatedAt: r.updatedAt,
        source: r.source, rolloutPath: cleanPath(r.rollout_path),
        project: projectForRow(r, projectsByPath),
        importable: fs.existsSync(cleanPath(r.rollout_path)),
      }];
    });
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


function pathKey(p) {
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
}

// Match a Codex project to an existing workspace by real path, or create one.
// Workspaces are stored canonicalized (create-workspace realpaths folders), so
// compare in the same form or symlinked temp paths would miss and duplicate.
function resolveWorkspace(shared, project) {
  if (!project?.path || !fs.existsSync(cleanPath(project.path))) return null;
  let target;
  try { target = fs.realpathSync(cleanPath(project.path)); } catch { return null; }
  const meta = shared.workspaces.sessionMeta();
  const existing = meta.workspaces.find(w => w.path && pathKey(w.path) === pathKey(target));
  if (existing) return existing.id;
  const result = shared.workspaces.metaOp({ op: 'create-workspace', name: project.name || path.basename(target), path: target });
  return result.ok ? result.workspace.id : null;
}

function importDesktopSessions(shared, stateFile, ids, log = () => {}) {
  const sessions = listDesktopSessions(stateFile);
  const selected = sessions.filter(s => ids.includes(s.id));
  const imported = [], skipped = [];
  for (const session of selected) {
    try {
      const workspaceId = resolveWorkspace(shared, session.project);
      const cwd = workspaceId ? undefined : session.cwd && fs.existsSync(session.cwd) ? session.cwd : undefined;
      const c = shared.create('codex', workspaceId, session.title, cwd);
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


// Re-read the desktop rollout and overwrite the Camellia copy. Callers must
// confirm with the user first: this replaces Camellia-side history.
function syncDesktopSession(shared, stateFile, conversationId) {
  const c = shared.get(conversationId);
  if (!c?.importThreadId) throw new Error('This conversation was not imported from the Codex desktop app');
  const session = listDesktopSessions(stateFile, {}).find(s => s.id === c.importThreadId)
    || withSnapshot(stateFile, db => {
      const r = db.prepare(`SELECT t.id, t.name, t.title, t.first_user_message, t.preview, t.cwd, t.source, t.rollout_path,
          p.id AS projectId, p.name AS projectName, r.path AS projectPath FROM threads t
          LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN project_roots r ON r.project_id = t.project_id AND r.position = 0
          WHERE t.id = ?`).get(c.importThreadId);
      return r ? { id: r.id, title: cleanTitle(r.name) || cleanTitle(r.title) || cleanTitle(r.first_user_message || r.preview),
        project: r.projectId ? { id: r.projectId, name: r.projectName || '', path: cleanPath(r.projectPath || '') } : null,
        rolloutPath: cleanPath(r.rollout_path) } : null;
    });
  if (!session) throw new Error('The session no longer exists in the Codex desktop app');
  const messages = readRolloutMessages(session.rolloutPath);
  shared.resetHistory(c);
  for (const message of messages) {
    shared.append(c, { role: message.role, engine: 'codex', text: message.text, displayText: message.text, attachments: [] });
  }
  if (session.title) c.title = session.title.slice(0, 80);
  const workspaceId = resolveWorkspace(shared, session.project);
  if (workspaceId && c.workspaceId !== workspaceId) { c.workspaceId = workspaceId; shared.workspaces.recordContext(c.id, workspaceId, c.cwd); }
  c.updatedAt = Date.now();
  shared.save(c);
  return { id: c.id, title: c.title, messages: messages.length };
}

module.exports = { desktopStatePath, listDesktopSessions, readRolloutMessages, importDesktopSessions, syncDesktopSession, resolveWorkspace };

