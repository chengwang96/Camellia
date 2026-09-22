'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validSessionId } = require('./claude-history');

function createSessionWorkspaces({ history, loadConfig, saveConfig, metaKey, settingsKey, standaloneCwd, getSession, onDetach, fixedCwd = false }) {
async function listSessions({ limits = {}, activeSessionId = null } = {}) {
  const entries = [...await history.list()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const config = loadConfig();
  const meta = sessionMeta(config);
  const settings = config[settingsKey] || {};
  const workspaceById = new Map(meta.workspaces.map(w => [w.id, w]));
  const groups = new Map([['pinned', []], ['recent', []], ...meta.workspaces.map(w => [w.id, []])]);
  const counts = new Map();
  const seen = new Set();
  let active;
  for (const entry of entries) {
    if (seen.has(entry.id) || meta.archived[entry.id]) continue;
    seen.add(entry.id);
    const workspaceId = meta.sessionWorkspace[entry.id];
    const ws = workspaceById.get(workspaceId);
    if (ws) counts.set(ws.id, (counts.get(ws.id) || 0) + 1);
    const group = meta.pinned[entry.id] ? 'pinned' : ws ? ws.id : 'recent';
    groups.get(group).push(entry);
    if (entry.id === activeSessionId) active = entry;
  }
  const visible = new Map();
  const pagination = {};
  for (const [group, all] of groups) {
    const ranks = new Map((meta.sessionOrder[group] || []).map((id, index) => [id, index]));
    all.sort((first, second) => (ranks.get(first.id) ?? Infinity) - (ranks.get(second.id) ?? Infinity));
    const limit = Number.isSafeInteger(limits[group]) && limits[group] > 0 ? limits[group] : 60;
    const page = workspaceById.get(group)?.id && meta.collapsed[group] ? [] : all.slice(0, limit);
    for (const entry of page) visible.set(entry.id, entry);
    pagination[group] = { total: all.length, loaded: page.length, hasMore: page.length < all.length };
  }
  // Keep the open conversation addressable even outside the visible page.
  if (active) visible.set(active.id, active);
  const ordered = [...visible.values()].sort((first, second) => second.mtimeMs - first.mtimeMs || first.file.localeCompare(second.file));
  const groupFor = entry => meta.pinned[entry.id] ? 'pinned' : workspaceById.has(meta.sessionWorkspace[entry.id]) ? meta.sessionWorkspace[entry.id] : 'recent';
  for (const [group, order] of Object.entries(meta.sessionOrder)) {
    const ranks = new Map(order.map((id, index) => [id, index]));
    const slots = ordered.map((entry, index) => groupFor(entry) === group ? index : -1).filter(index => index >= 0);
    const sorted = slots.map(index => ordered[index]).sort((first, second) => (ranks.get(first.id) ?? Infinity) - (ranks.get(second.id) ?? Infinity));
    slots.forEach((slot, index) => { ordered[slot] = sorted[index]; });
  }
  const sessions = await Promise.all(ordered.map(async entry => {
    let head = { summary: '', title: '', cwd: '' };
    try { head = await history.readHead(entry.file, entry); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const title = meta.titles[entry.id] || head.summary || head.title || "(Empty session)";
    const ws = workspaceById.get(meta.sessionWorkspace[entry.id]);
    return {
      id: entry.id, title: title.length > 60 ? title.slice(0, 60) + '…' : title,
      renamed: Boolean(meta.titles[entry.id]), pinned: Boolean(meta.pinned[entry.id]),
      workspaceId: ws?.id || null, workspacePath: ws?.path || null,
      cwd: resolveContext(settings, { sessionId: entry.id }, head.cwd, meta).cwd,
      mtimeMs: entry.mtimeMs,
    };
  }));
  return {
    sessions, pagination,
    workspaces: meta.workspaces.map(w => ({ ...w, collapsed: Boolean(meta.collapsed[w.id]), sessionCount: counts.get(w.id) || 0 })),
  };
}

// Display metadata is separate from native engine transcripts.
function metaDefaults() {
  return {
    titles: {},            // sessionId -> renamed title
    archived: {},          // sessionId -> archivedAt ms
    pinned: {},            // sessionId -> pinnedAt ms
    sessionWorkspace: {},  // sessionId -> workspaceId
    sessionCwd: {},        // last execution directory; explicit null membership stays independent
    workspaces: [],        // [{ id, name, path, createdAt }] in user order
    collapsed: {},         // workspaceId -> true when collapsed
    sessionOrder: {},
  };
}

function sessionMeta(config = loadConfig()) {
  const meta = { ...metaDefaults(), ...(config[metaKey] || {}) };
  if (!Array.isArray(meta.workspaces)) throw new Error("Invalid workspace configuration");
  for (const key of ['titles', 'archived', 'pinned', 'sessionWorkspace', 'sessionCwd', 'collapsed', 'sessionOrder']) {
    if (!meta[key] || typeof meta[key] !== 'object' || Array.isArray(meta[key])) throw new Error("Invalid session configuration: " + key);
  }
  if (Object.values(meta.sessionOrder).some(order => !Array.isArray(order))) throw new Error('Invalid session order');
  return meta;
}

function saveSessionMeta(mutator) {
  const config = loadConfig();
  const meta = sessionMeta(config);
  mutator(meta);
  saveConfig({ [metaKey]: meta });
  return meta;
}

function promoteSession(id) {
  if (!validSessionId(id)) return false;
  const meta = sessionMeta();
  if (meta.archived[id]) return false;
  const workspaceIds = new Set(meta.workspaces.map(workspace => workspace.id));
  const group = meta.pinned[id] ? 'pinned' : workspaceIds.has(meta.sessionWorkspace[id]) ? meta.sessionWorkspace[id] : 'recent';
  saveSessionMeta(saved => {
    for (const key of Object.keys(saved.sessionOrder)) saved.sessionOrder[key] = saved.sessionOrder[key].filter(sessionId => sessionId !== id);
    saved.sessionOrder[group] = [id, ...(saved.sessionOrder[group] || [])];
  });
  return true;
}



function resolveContext(settings, opts = {}, legacyCwd, meta = sessionMeta()) {
  const assigned = Object.prototype.hasOwnProperty.call(meta.sessionWorkspace, opts.sessionId);
  const workspaceId = assigned ? meta.sessionWorkspace[opts.sessionId] : (opts.workspaceId || null);
  if (workspaceId) {
    const workspace = meta.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) throw new Error("Workspace no longer exists. Choose another workspace.");
    if (!workspace.path) throw new Error("Workspace has no directory. Add the folder again.");
    return { workspaceId, cwd: meta.sessionCwd[opts.sessionId] || workspace.path };
  }
  // Imported CLI sessions keep their original directory until explicitly moved.
  if (!assigned && opts.sessionId && legacyCwd === undefined) {
    const file = history.find(opts.sessionId);
    legacyCwd = file ? history.head(file).cwd : '';
  }
  return { workspaceId: null, cwd: meta.sessionCwd[opts.sessionId] || (!assigned && legacyCwd) || standaloneCwd(settings) };
}

function recordContext(id, workspaceId, cwd) {
  if (!validSessionId(id)) return;
  const meta = sessionMeta();
  const wid = workspaceId || null;
  if (meta.sessionWorkspace[id] === wid && meta.sessionCwd[id] === cwd) return;
  saveSessionMeta((m) => { m.sessionWorkspace[id] = wid; m.sessionCwd[id] = cwd; });
}

function renameSession(id, title) {
  if (!validSessionId(id)) throw new Error("Invalid session");
  const trimmed = String(title || '').trim();
  saveSessionMeta((m) => {
    if (trimmed) m.titles[id] = trimmed;
    else delete m.titles[id]; // empty title restores the auto-derived one
  });
  return { ok: true };
}

// Archived sessions are hidden from listSessions; the settings window lists
// them here so they can be restored or permanently deleted.
async function listArchived() {
  const entries = await history.list();
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const meta = sessionMeta();
  const sessions = [];
  for (const [id, archivedAt] of Object.entries(meta.archived)) {
    const entry = byId.get(id);
    let head = { summary: '', title: '' };
    if (entry) {
      try { head = await history.readHead(entry.file, entry); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    const title = meta.titles[id] || head.summary || head.title || "(Empty session)";
    sessions.push({ id, title: title.length > 60 ? title.slice(0, 60) + '…' : title,
      archivedAt, mtimeMs: entry ? entry.mtimeMs : archivedAt, missing: !entry });
  }
  return sessions.sort((a, b) => b.archivedAt - a.archivedAt || a.id.localeCompare(b.id));
}

// Permanent delete: transcript file plus every display-metadata entry.
async function removeSession(id) {
  if (!validSessionId(id)) throw new Error("Invalid session");
  const session = getSession();
  const liveId = session && (session.sessionId || session.opts?.sessionId);
  if (session && session.running && liveId === id) throw new Error("Wait for the response to finish or stop it before deleting this conversation");
  const removed = history.remove ? await history.remove(id) : false;
  saveSessionMeta((m) => {
    for (const key of ['titles', 'archived', 'pinned', 'sessionWorkspace', 'sessionCwd']) delete m[key][id];
    for (const group of Object.keys(m.sessionOrder)) m.sessionOrder[group] = m.sessionOrder[group].filter(entry => entry !== id);
  });
  return { ok: true, removed: Boolean(removed) };
}

function archiveSession(id, archived) {
  if (!validSessionId(id)) throw new Error("Invalid session");
  saveSessionMeta((m) => {
    if (archived) m.archived[id] = Date.now();
    else delete m.archived[id];
  });
  return { ok: true };
}

// Workspace + pin operations, funneled through one IPC op to keep the surface small.
// Returns the full meta snapshot so the renderer can re-render without a second call.
function metaOp(payload) {
  const op = payload && payload.op;
  if (op === 'move-session') return moveSession(payload);
  const meta = sessionMeta();
  const workspaceId = payload.id || payload.workspaceId;
  if (['rename-workspace', 'delete-workspace', 'toggle-collapse'].includes(op)
      && !meta.workspaces.some((w) => w.id === workspaceId)) return { ok: false, error: "Workspace no longer exists" };
  if (['assign-session', 'toggle-pin'].includes(op)
      && !validSessionId(payload.sessionId)) return { ok: false, error: "Invalid session" };
  if (op === 'assign-session' && payload.workspaceId && !meta.workspaces.some((w) => w.id === payload.workspaceId)) return { ok: false, error: "Workspace no longer exists" };
  const session = getSession();
  const busy = session && session.running;
  if (fixedCwd && op === 'assign-session' && (meta.sessionWorkspace[payload.sessionId] || null) !== (payload.workspaceId || null)) return { ok: false, error: "Existing sessions cannot change directories. Start a new session in the target workspace." };
  if (busy && ((op === 'assign-session' && payload.sessionId === session.sessionId)
      || (op === 'delete-workspace' && payload.id === session.opts.workspaceId))) return { ok: false, error: "Stop the current response before changing workspaces" };
  switch (op) {
    case 'create-workspace': {
      const name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: "Workspace name cannot be empty" };
      const folder = String(payload.path || '').trim();
      if (!folder || !path.isAbsolute(folder)) return { ok: false, error: "Choose a folder or enter its full path" };
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { ok: false, error: "Folder does not exist. Choose another folder." };
      const canonical = fs.realpathSync(folder);
      const pathKey = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
      if (meta.workspaces.some((w) => w.path && pathKey(w.path) === pathKey(canonical))) return { ok: false, error: "This folder is already a workspace" };
      const ws = {
        id: 'ws-' + randomUUID(),
        name,
        path: canonical,
        createdAt: Date.now(),
      };
      saveSessionMeta((m) => { m.workspaces.push(ws); });
      return { ok: true, workspace: ws, meta: sessionMeta() };
    }
    case 'rename-workspace': {
      const name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: "Workspace name cannot be empty" };
      saveSessionMeta((m) => {
        const ws = m.workspaces.find((w) => w.id === payload.id);
        if (ws) ws.name = name;
      });
      return { ok: true, meta: sessionMeta() };
    }
    case 'delete-workspace': {
      saveSessionMeta((m) => {
        m.workspaces = m.workspaces.filter((w) => w.id !== payload.id);
        for (const [sid, wid] of Object.entries(m.sessionWorkspace)) {
          if (wid === payload.id) {
            if (payload.archiveSessions === true && !m.archived[sid]) m.archived[sid] = Date.now();
            m.sessionWorkspace[sid] = null;
            if (!fixedCwd) delete m.sessionCwd[sid];
          }
        }
        delete m.collapsed[payload.id];
        delete m.sessionOrder[payload.id];
      });
      onDetach(payload.id);
      return { ok: true, meta: sessionMeta() };
    }
    case 'assign-session': {
      saveSessionMeta((m) => {
        m.sessionWorkspace[payload.sessionId] = payload.workspaceId || null;
        delete m.sessionCwd[payload.sessionId];
      });
      return { ok: true, meta: sessionMeta() };
    }
    case 'toggle-pin': {
      let pinned;
      saveSessionMeta((m) => {
        if (m.pinned[payload.sessionId]) { delete m.pinned[payload.sessionId]; pinned = false; }
        else { m.pinned[payload.sessionId] = Date.now(); pinned = true; }
      });
      return { ok: true, pinned, meta: sessionMeta() };
    }
    case 'toggle-collapse': {
      saveSessionMeta((m) => {
        if (m.collapsed[payload.workspaceId]) delete m.collapsed[payload.workspaceId];
        else m.collapsed[payload.workspaceId] = true;
      });
      return { ok: true, meta: sessionMeta() };
    }
    default:
      return { ok: false, error: 'unknown op: ' + op };
  }
}

async function moveSession(payload) {
  const entries = [...await history.list()].sort((first, second) => second.mtimeMs - first.mtimeMs || first.file.localeCompare(second.file));
  const meta = sessionMeta();
  const id = payload.sessionId;
  const entry = entries.find(candidate => candidate.id === id);
  if (!validSessionId(id) || !entry || meta.archived[id]) return { ok: false, error: 'Invalid session' };
  const group = payload.group;
  const workspace = meta.workspaces.find(candidate => candidate.id === group);
  if (!workspace && group !== 'recent' && group !== 'pinned') return { ok: false, error: 'Workspace no longer exists' };
  const groupFor = candidate => meta.pinned[candidate.id] ? 'pinned' : meta.sessionWorkspace[candidate.id] || 'recent';
  const ranks = new Map((meta.sessionOrder[group] || []).map((sessionId, index) => [sessionId, index]));
  const order = entries.filter(candidate => candidate.id !== id && !meta.archived[candidate.id] && groupFor(candidate) === group)
    .sort((first, second) => (ranks.get(first.id) ?? Infinity) - (ranks.get(second.id) ?? Infinity)).map(candidate => candidate.id);
  const target = payload.targetSessionId;
  if (target && (!order.includes(target) || !['before', 'after'].includes(payload.placement))) return { ok: false, error: 'Invalid drop target' };
  const position = target ? order.indexOf(target) + (payload.placement === 'after' ? 1 : 0) : order.length;
  order.splice(position, 0, id);
  const head = await history.readHead(entry.file, entry);
  const cwd = resolveContext(loadConfig()[settingsKey] || {}, { sessionId: id }, head.cwd, meta).cwd;
  saveSessionMeta(saved => {
    for (const key of Object.keys(saved.sessionOrder)) saved.sessionOrder[key] = saved.sessionOrder[key].filter(sessionId => sessionId !== id);
    saved.sessionOrder[group] = order;
    if (group === 'pinned') saved.pinned[id] = saved.pinned[id] || Date.now();
    else {
      delete saved.pinned[id];
      saved.sessionWorkspace[id] = workspace?.id || null;
      saved.sessionCwd[id] = cwd;
      if (workspace) delete saved.collapsed[workspace.id];
    }
  });
  return { ok: true, meta: sessionMeta() };
}

async function transcript(id) {
  const meta = sessionMeta();
  // Archived sessions stay out of the chat surface; restore them first.
  if (meta.archived[id]) throw new Error('This conversation is archived. Restore it from Settings → Archived first.');
  const { messages, cwd, truncated } = await history.transcript(id);
  return { messages, truncated, ...resolveContext(loadConfig()[settingsKey] || {}, { sessionId: id }, cwd, meta) };
}


return { listSessions, listArchived, removeSession, sessionMeta, resolveContext, recordContext, renameSession, archiveSession, metaOp, promoteSession, transcript };
}

module.exports = { createSessionWorkspaces };
