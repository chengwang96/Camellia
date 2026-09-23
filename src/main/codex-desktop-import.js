'use strict';

// Import sessions from the local Codex desktop app, read-only. The desktop app
// indexes its threads in ~/.codex/state_5.sqlite; message content lives in the
// shared rollout JSONL files under ~/.codex/sessions/. We never write there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const MAX_LISTED_SESSIONS = 1000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_COUNT = 100000;

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

function readDesktopProjects(stateFile, projectsByPath) {
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(path.dirname(stateFile), '.codex-global-state.json'), 'utf8')); } catch { return {}; }
  const projects = new Map();
  for (const [id, project] of Object.entries(state?.['local-projects'] || {})) {
    const roots = Array.isArray(project?.rootPaths) ? project.rootPaths.filter(root => typeof root === 'string' && root) : [];
    if (!roots.length) continue;
    const existing = roots.map(root => projectsByPath.get(pathKey(cleanPath(root)))).find(Boolean);
    const resolved = existing || { id, name: project.name || '', path: cleanPath(roots[0]) };
    projects.set(id, resolved);
    for (const root of roots) if (!projectsByPath.has(pathKey(cleanPath(root)))) projectsByPath.set(pathKey(cleanPath(root)), resolved);
  }
  return { projects, assignments: state?.['thread-project-assignments'] || {}, projectless: new Set(Array.isArray(state?.['projectless-thread-ids']) ? state['projectless-thread-ids'] : []) };
}

function projectForRow(row, projectsByPath, desktop = {}) {
  if (row.projectId) return { id: row.projectId, name: row.projectName || '', path: cleanPath(row.projectPath || '') };
  const assignment = desktop.assignments?.[row.id];
  if (assignment?.projectKind === 'local' && desktop.projects?.has(assignment.projectId)) return desktop.projects.get(assignment.projectId);
  if (assignment || desktop.projectless?.has(row.id)) return null;
  const cwd = cleanPath(row.cwd || '');
  if (!cwd) return null;
  return projectsByPath.get(pathKey(cwd)) || null;
}

function listDesktopSessions(stateFile, { excludeIds = new Set(), maxSessions = MAX_LISTED_SESSIONS } = {}) {
  if (!fs.existsSync(stateFile)) return [];
  return withSnapshot(stateFile, db => {
    const limit = Math.max(1, Math.min(MAX_LISTED_SESSIONS, Number(maxSessions) || MAX_LISTED_SESSIONS));
    const rows = db.prepare(`SELECT t.id, t.name, t.title, t.first_user_message, t.preview, t.cwd, t.source, t.rollout_path,
        COALESCE(t.created_at_ms, t.created_at * 1000) AS createdAt, COALESCE(t.updated_at_ms, t.updated_at * 1000) AS updatedAt,
        p.id AS projectId, p.name AS projectName, r.path AS projectPath
      FROM threads t LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN project_roots r ON r.project_id = t.project_id AND r.position = 0
      WHERE t.archived = 0 ORDER BY createdAt DESC LIMIT ?`).all(limit + 1);
    const truncated = rows.length > limit;
    if (truncated) rows.length = limit;
    const projectRoots = db.prepare(`SELECT p.id, p.name, r.path, r.position FROM projects p
      JOIN project_roots r ON r.project_id = p.id ORDER BY r.position`).all();
    const projectsById = new Map();
    const projectsByPath = new Map();
    for (const project of projectRoots) {
      if (!project.path) continue;
      if (!projectsById.has(project.id)) projectsById.set(project.id, { id: project.id, name: project.name || '', path: cleanPath(project.path) });
      projectsByPath.set(pathKey(cleanPath(project.path)), projectsById.get(project.id));
    }
    const desktop = readDesktopProjects(stateFile, projectsByPath);
    const sessions = rows.filter(r => !isSubagentSource(r.source) && !excludeIds.has(r.id)).flatMap(r => {
      const title = cleanTitle(r.name);
      if (!title) return [];
      const rolloutPath = cleanPath(r.rollout_path);
      let rolloutBytes = null;
      try {
        const stat = fs.statSync(rolloutPath);
        if (stat.isFile()) { fs.accessSync(rolloutPath, fs.constants.R_OK); rolloutBytes = stat.size; }
      } catch {}
      return [{
        id: r.id, title: title.slice(0, 60),
        cwd: cleanPath(r.cwd || ''), createdAt: r.createdAt, updatedAt: r.updatedAt,
        source: r.source, rolloutPath,
        project: projectForRow(r, projectsByPath, desktop),
        rolloutBytes,
        importable: rolloutBytes !== null,
      }];
    });
    Object.defineProperty(sessions, 'truncated', { value: truncated, enumerable: false });
    return sessions;
  });
}

// Rollout JSONL keeps both response_item and event_msg copies of a turn; the
// response_item message rows are canonical here. Tool calls and reasoning are
// not imported.
async function readRolloutMessages(rolloutPath, onMessage, { maxMessageBytes = MAX_MESSAGE_BYTES, maxMessageCount = MAX_MESSAGE_COUNT } = {}) {
  const file = cleanPath(rolloutPath);
  const messages = [];
  let messageBytes = 0;
  let messageCount = 0;
  let previous = null;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== 'response_item') continue;
      const payload = row.payload || {};
      if (payload.type !== 'message') continue;
      const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      const parts = Array.isArray(payload.content) ? payload.content : [];
      let text = parts.filter(part => part && (part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string').map(part => part.text).join('\n').trim();
      if (!text) continue;
      if (role === 'user') {
        if (text.startsWith('<environment_context') || text.startsWith('# AGENTS.md')) continue;
        const myRequest = text.indexOf('## My request:');
        if (myRequest >= 0) text = text.slice(myRequest + '## My request:'.length).trim();
        if (!text) continue;
      }
      const message = { role, text, at: Date.parse(row.timestamp) || Date.now() };
      if (previous && message.role === previous.role && message.text === previous.text) continue;
      messageBytes += Buffer.byteLength(text, 'utf8');
      messageCount++;
      if (messageBytes > maxMessageBytes || messageCount > maxMessageCount) {
        throw new Error('Extracted conversation exceeds the safety limit (64 MiB of text or 100,000 messages); no partial history was imported');
      }
      previous = message;
      if (onMessage) await onMessage(message);
      else messages.push(message);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return messages;
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

async function importDesktopSessions(shared, stateFile, ids, log = () => {}) {
  const sessions = listDesktopSessions(stateFile);
  const selected = sessions.filter(s => ids.includes(s.id));
  const imported = [], skipped = [];
  for (const session of selected) {
    let conversation = null;
    try {
      const workspaceId = resolveWorkspace(shared, session.project);
      const cwd = workspaceId ? undefined : session.cwd && fs.existsSync(session.cwd) ? session.cwd : undefined;
      conversation = shared.create('codex', workspaceId, session.title, cwd);
      conversation.importedFrom = 'codex-desktop';
      conversation.importThreadId = session.id;
      conversation.createdAt = session.createdAt || Date.now();
      conversation.updatedAt = session.updatedAt || conversation.createdAt;
      let count = 0;
      await readRolloutMessages(session.rolloutPath, message => {
        shared.append(conversation, { role: message.role, engine: 'codex', text: message.text, displayText: message.text, attachments: [] });
        count++;
      });
      shared.save(conversation);
      imported.push({ id: conversation.id, threadId: session.id, title: conversation.title, messages: count });
    } catch (error) {
      if (conversation) shared.purge(conversation.id);
      log('codex desktop import failed for ' + session.id + ': ' + error.message);
      skipped.push({ threadId: session.id, error: error.message });
    }
  }
  return { imported, skipped };
}


// Re-read the desktop rollout and overwrite the Camellia copy. Callers must
// confirm with the user first: this replaces Camellia-side history.
async function syncDesktopSession(shared, stateFile, conversationId) {
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
  const messages = await readRolloutMessages(session.rolloutPath);
  let count = 0;
  shared.resetHistory(c);
  for (const message of messages) {
    shared.append(c, { role: message.role, engine: 'codex', text: message.text, displayText: message.text, attachments: [] });
    count++;
  }
  if (session.title) c.title = session.title.slice(0, 80);
  const workspaceId = resolveWorkspace(shared, session.project);
  if (workspaceId && c.workspaceId !== workspaceId) { c.workspaceId = workspaceId; shared.workspaces.recordContext(c.id, workspaceId, c.cwd); }
  c.updatedAt = shared.stamp();
  shared.save(c);
  return { id: c.id, title: c.title, messages: count };
}

module.exports = { desktopStatePath, listDesktopSessions, readRolloutMessages, importDesktopSessions, syncDesktopSession, resolveWorkspace,
  MAX_LISTED_SESSIONS, MAX_MESSAGE_BYTES, MAX_MESSAGE_COUNT };

