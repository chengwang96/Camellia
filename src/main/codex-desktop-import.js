'use strict';

// Import sessions from the local Codex desktop app, read-only. The desktop app
// indexes its threads in ~/.codex/state_5.sqlite; message content lives in the
// shared rollout JSONL files under ~/.codex/sessions/. We never write there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jsonLines } = require('../shared/json-lines');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { pipeline } = require('node:stream/promises');
const { createZstdDecompress } = require('node:zlib');
const { zstdFrameValidator } = require('../shared/zstd-frames');

const MAX_LISTED_SESSIONS = 1000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_COUNT = 100000;
const importsInProgress = new WeakMap();

async function withImportLock(shared, threadId, action) {
  let pending = importsInProgress.get(shared);
  if (!pending) importsInProgress.set(shared, pending = new Set());
  if (pending.has(threadId)) throw new Error('This Codex session is already being imported or synced. Try again when it finishes.');
  pending.add(threadId);
  try { return await action(); } finally { pending.delete(threadId); }
}

const messageHash = message => createHash('sha256').update(JSON.stringify([message.role, message.text])).digest('hex');
const prefixHash = hashes => createHash('sha256').update(hashes.map(hash => hash + '\n').join('')).digest('hex');
const checkpoint = (session, messageCount, hash) => ({ version: 1, messageCount, prefixHash: hash,
  rolloutBytes: session.rolloutBytes, rolloutModifiedAt: session.rolloutModifiedAt,
  updatedAt: session.updatedAt, title: session.title });

function importedConversation(shared, threadId) {
  return [...shared.items.values()].find(conversation => conversation.importThreadId === threadId);
}

function desktopStatePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.codex', 'state_5.sqlite');
}

// Open a snapshot copy: the desktop app holds the live database and may be
// running, so we never open its file directly.
function withSnapshot(file, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-import-'));
  try {
    // The live SHM contains byte-range locks on Windows. SQLite rebuilds it
    // beside the isolated copy; only the database and WAL are source data.
    for (const suffix of ['', '-wal']) {
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

const sessionTitle = row => (cleanTitle(row.name) || cleanTitle(row.title)
  || cleanTitle(row.first_user_message) || cleanTitle(row.preview)).slice(0, 60);

// These columns can contain entire prompts. Unwrap desktop request headers in
// SQLite and return only enough text for the 60-character display title.
const titleColumns = ['name', 'title', 'first_user_message', 'preview'].map(column => {
  const value = `t.${column}`, marker = '## My request:';
  return `substr(ltrim(CASE WHEN instr(${value}, '${marker}') > 0
    THEN substr(${value}, instr(${value}, '${marker}') + ${marker.length}) ELSE ${value} END,
    char(9) || char(10) || char(13) || ' '), 1, 200) AS ${column}`;
}).join(', ');

// Codex may compress a rollout without updating older index entries. Prefer
// the indexed file, then try its compressed sibling without changing either.
function rolloutInfo(file) {
  const rolloutPath = cleanPath(file);
  const candidates = typeof rolloutPath === 'string' && /\.jsonl$/i.test(rolloutPath)
    ? [rolloutPath, rolloutPath + '.zst'] : [rolloutPath];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.R_OK);
      return { rolloutPath: candidate, rolloutBytes: stat.size, rolloutModifiedAt: stat.mtimeMs, importable: true };
    } catch {}
  }
  return { rolloutPath, rolloutBytes: null, rolloutModifiedAt: null, importable: false };
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

function listDesktopSessions(stateFile, { excludeIds = new Set(), maxSessions = MAX_LISTED_SESSIONS, threadIds } = {}) {
  if (!fs.existsSync(stateFile)) return [];
  if (threadIds && !threadIds.length) return [];
  return withSnapshot(stateFile, db => {
    const limit = Math.max(1, Math.min(MAX_LISTED_SESSIONS, Math.trunc(Number(maxSessions)) || MAX_LISTED_SESSIONS));
    // Apply visibility filters before LIMIT, accepting older title/message
    // fields when name is empty. Old threads with new turns rank first.
    const hasTitle = ['name', 'title', 'first_user_message', 'preview']
      .map(column => `trim(COALESCE(t.${column}, ''), char(9) || char(10) || char(13) || ' ') <> ''`).join(' OR ');
    const where = ['t.archived = 0', `(${hasTitle})`, "substr(ltrim(t.source, char(9) || char(10) || char(13) || ' '), 1, 1) <> '{'"];
    const parameters = [];
    if (threadIds) {
      where.push(`t.id IN (${threadIds.map(() => '?').join(',')})`);
      parameters.push(...threadIds);
    }
    if (excludeIds.size) {
      where.push(`t.id NOT IN (${[...excludeIds].map(() => '?').join(',')})`);
      parameters.push(...excludeIds);
    }
    const rows = db.prepare(`SELECT t.id, ${titleColumns}, t.cwd, t.source, t.rollout_path,
        COALESCE(t.created_at_ms, t.created_at * 1000) AS createdAt, COALESCE(t.updated_at_ms, t.updated_at * 1000) AS updatedAt,
        p.id AS projectId, p.name AS projectName, r.path AS projectPath
      FROM threads t LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN project_roots r ON r.project_id = t.project_id AND r.position = 0
      WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC, createdAt DESC LIMIT ?`).all(...parameters, limit + 1);
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
      const title = sessionTitle(r);
      if (!title) return [];
      return [{
        id: r.id, title,
        cwd: cleanPath(r.cwd || ''), createdAt: r.createdAt, updatedAt: r.updatedAt,
        source: r.source, ...rolloutInfo(r.rollout_path),
        project: projectForRow(r, projectsByPath, desktop),
      }];
    });
    Object.defineProperty(sessions, 'truncated', { value: truncated, enumerable: false });
    return sessions;
  });
}

// An imported thread stays available when its source changes. Old imports have
// no checkpoint, so offer one update to establish it without replacing history.
function listDesktopImportCandidates(shared, stateFile) {
  const sessions = listDesktopSessions(stateFile);
  const candidates = sessions.flatMap(session => {
    const conversation = importedConversation(shared, session.id);
    if (!conversation) return [{ ...session, action: 'import' }];
    const saved = conversation.codexDesktopSync;
    if (saved?.version === 1 && saved.rolloutBytes === session.rolloutBytes
        && saved.rolloutModifiedAt === session.rolloutModifiedAt
        && saved.updatedAt === session.updatedAt && saved.title === session.title) return [];
    return [{ ...session, action: 'update', conversationId: conversation.id }];
  });
  Object.defineProperty(candidates, 'truncated', { value: sessions.truncated, enumerable: false });
  return candidates;
}

// Rollout JSONL keeps both response_item and event_msg copies of a turn; the
// response_item message rows are canonical here. Tool calls and reasoning are
// not imported.
async function readRolloutMessages(rolloutPath, onMessage, { maxMessageBytes = MAX_MESSAGE_BYTES, maxMessageCount = MAX_MESSAGE_COUNT } = {}) {
  const file = rolloutInfo(rolloutPath).rolloutPath;
  const messages = [];
  let messageBytes = 0;
  let messageCount = 0;
  let previous = null;
  const source = fs.createReadStream(file);
  const input = /\.zst$/i.test(file) ? createZstdDecompress() : source;
  let endsWithNewline = false;
  let incompleteRecord = false;
  const corruptHistory = () => new Error('Could not import Codex history: invalid JSONL record.');
  input.on('data', chunk => { if (chunk.length) endsWithNewline = chunk[chunk.length - 1] === 10 || chunk[chunk.length - 1] === 13; });
  const lines = jsonLines(input);
  // Observe the entire decoder pipeline, including errors after its final
  // output chunk. Keep cleanup errors handled if the consumer stops early.
  const completed = input === source ? null : pipeline(source, zstdFrameValidator(), input).then(() => null, error => error);
  try {
    for await (const line of lines) {
      if (incompleteRecord) throw corruptHistory();
      if (!line) continue;
      let row;
      // A live writer may leave one incomplete final record. A malformed
      // complete record must reject the import instead of silently losing text.
      try { row = JSON.parse(line); } catch { incompleteRecord = true; continue; }
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
    const decodingError = await completed;
    if (decodingError) throw decodingError;
    if (incompleteRecord && endsWithNewline) throw corruptHistory();
  } finally {
    lines.destroy();
    input.destroy();
    source.destroy();
    await completed;
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
  if (!Array.isArray(ids) || ids.length > MAX_LISTED_SESSIONS || ids.some(id => typeof id !== 'string' || !id))
    throw new Error('Select up to 1,000 Codex sessions to import or update.');
  const threadIds = [...new Set(ids)];
  // The list may change between opening the dialog and clicking Import.
  // Resolve selected IDs directly instead of silently dropping off-list rows.
  const selected = listDesktopSessions(stateFile, { threadIds });
  const imported = [], updated = [], skipped = [];
  const available = new Set(selected.map(session => session.id));
  for (const threadId of threadIds) if (!available.has(threadId))
    skipped.push({ threadId, error: 'The Codex session is no longer available for import. Refresh the import list.' });
  for (const session of selected) {
    let conversation = null;
    try {
      await withImportLock(shared, session.id, async () => {
        const existing = importedConversation(shared, session.id);
        if (existing) {
          updated.push({ ...await syncDesktopConversation(shared, stateFile, existing.id, session), threadId: session.id });
          return;
        }
        const workspaceId = resolveWorkspace(shared, session.project);
        const cwd = workspaceId ? undefined : session.cwd && fs.existsSync(session.cwd) ? session.cwd : undefined;
        conversation = shared.create('codex', workspaceId, session.title, cwd);
        conversation.importedFrom = 'codex-desktop';
        conversation.importThreadId = session.id;
        conversation.createdAt = session.createdAt || Date.now();
        conversation.updatedAt = session.updatedAt || conversation.createdAt;
        let count = 0;
        const hash = createHash('sha256');
        await readRolloutMessages(session.rolloutPath, message => {
          const fingerprint = messageHash(message);
          hash.update(fingerprint + '\n');
          shared.append(conversation, { role: message.role, engine: 'codex', text: message.text, displayText: message.text, attachments: [],
            codexDesktopSource: { threadId: session.id, index: count++, hash: fingerprint } });
        });
        conversation.codexDesktopSync = checkpoint(session, count, hash.digest('hex'));
        shared.save(conversation);
        imported.push({ id: conversation.id, threadId: session.id, title: conversation.title, messages: count });
      });
    } catch (error) {
      if (conversation) await shared.purge(conversation.id);
      log('codex desktop import failed for ' + session.id + ': ' + error.message);
      skipped.push({ threadId: session.id, error: error.message });
    }
  }
  return { imported, updated, skipped };
}


async function syncDesktopSession(shared, stateFile, conversationId) {
  const c = shared.get(conversationId);
  if (!c?.importThreadId) throw new Error('This conversation was not imported from the Codex desktop app');
  return withImportLock(shared, c.importThreadId, () => syncDesktopConversation(shared, stateFile, conversationId));
}

// Validate the last source prefix before appending. Source indexes on copied
// rows also prevent duplicates if the history write succeeded but saving the
// checkpoint failed. Native cursors and Camellia-only turns remain intact.
async function syncDesktopConversation(shared, stateFile, conversationId, listedSession) {
  const c = shared.get(conversationId);
  if (shared.busy(c.id)) throw new Error('Wait for this conversation to finish or stop it before syncing.');
  const rows = shared.rows(c);
  const seq = c.seq;
  const session = listedSession || listDesktopSessions(stateFile, { threadIds: [c.importThreadId] })[0]
    || withSnapshot(stateFile, db => {
      const r = db.prepare(`SELECT t.id, ${titleColumns}, t.cwd, t.source, t.rollout_path,
          COALESCE(t.updated_at_ms, t.updated_at * 1000) AS updatedAt,
          p.id AS projectId, p.name AS projectName, r.path AS projectPath FROM threads t
          LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN project_roots r ON r.project_id = t.project_id AND r.position = 0
          WHERE t.id = ?`).get(c.importThreadId);
      return r ? { id: r.id, title: sessionTitle(r),
        updatedAt: r.updatedAt, ...rolloutInfo(r.rollout_path),
        project: r.projectId ? { id: r.projectId, name: r.projectName || '', path: cleanPath(r.projectPath || '') } : null,
      } : null;
    });
  if (!session) throw new Error('The session no longer exists in the Codex desktop app');
  const messages = await readRolloutMessages(session.rolloutPath);
  if (shared.items.get(c.id) !== c || c.seq !== seq || shared.busy(c.id))
    throw new Error('Conversation changed while syncing. Try again when it is idle.');
  const hashes = messages.map(messageHash);
  const saved = c.codexDesktopSync;
  let count = 0;
  if (saved) {
    if (saved.version !== 1 || !Number.isSafeInteger(saved.messageCount) || saved.messageCount < 0
        || saved.messageCount > messages.length || prefixHash(hashes.slice(0, saved.messageCount)) !== saved.prefixHash)
      throw new Error('Codex history changed before the last import. Incremental sync stopped; Camellia history was kept.');
    count = saved.messageCount;
  } else {
    // Legacy imports copied only role/text and had no source cursor. Their
    // common leading messages establish the initial cursor; a local suffix is
    // preserved, and all subsequent updates use the durable source checkpoint.
    const history = rows.filter(row => !row.internal && ['user', 'assistant'].includes(row.role));
    while (count < history.length && count < messages.length
        && history[count].role === messages[count].role && history[count].text === messages[count].text) count++;
    if (history.length && !count)
      throw new Error('The original imported messages no longer match Codex. Incremental sync stopped; Camellia history was kept.');
  }
  const copied = new Map(rows.filter(row => row.codexDesktopSource?.threadId === c.importThreadId)
    .map(row => [row.codexDesktopSource.index, row.codexDesktopSource.hash]));
  while (copied.has(count)) {
    if (copied.get(count) !== hashes[count])
      throw new Error('Codex history changed during the last sync. Camellia history was kept.');
    count++;
  }
  const addedMessages = messages.length - count;
  for (let index = count; index < messages.length; index++) {
    const message = messages[index];
    shared.append(c, { role: message.role, engine: 'codex', text: message.text, displayText: message.text, attachments: [],
      codexDesktopSource: { threadId: c.importThreadId, index, hash: hashes[index] } });
  }
  const titleChanged = Boolean(session.title && (!saved || saved.title !== session.title));
  if (titleChanged) c.title = session.title.slice(0, 80);
  const workspaceId = resolveWorkspace(shared, session.project);
  if (workspaceId && c.workspaceId !== workspaceId) { c.workspaceId = workspaceId; shared.workspaces.recordContext(c.id, workspaceId, c.cwd); }
  c.codexDesktopSync = checkpoint(session, messages.length, prefixHash(hashes));
  if (addedMessages || titleChanged) c.updatedAt = shared.stamp();
  shared.save(c);
  return { id: c.id, title: c.title, messages: messages.length, addedMessages };
}

module.exports = { desktopStatePath, listDesktopSessions, listDesktopImportCandidates, readRolloutMessages, importDesktopSessions, syncDesktopSession, resolveWorkspace,
  MAX_LISTED_SESSIONS, MAX_MESSAGE_BYTES, MAX_MESSAGE_COUNT };

