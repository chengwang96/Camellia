'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');

function setup(t) { const h = createHarness(); h.configureApi(); t.after(() => h.cleanup()); return h; }

async function archivedList(h) {
  const res = await h.call('archived-sessions-list');
  assert.equal(res.ok, true, res.error);
  return res.sessions;
}

test('archived sessions are listed, restorable and deletable from settings', async (t) => {
  const h = setup(t);
  const file = h.seedSession('old-chat', h.folder('proj'), 'Refactor the parser');
  h.call('claude-meta-op', { op: 'toggle-pin', sessionId: 'old-chat' });
  h.call('claude-rename-session', { id: 'old-chat', title: 'Parser work' });
  assert.equal((await h.call('claude-list-sessions')).sessions.length, 1);

  h.call('claude-archive-session', { id: 'old-chat', archived: true });
  assert.equal((await h.call('claude-list-sessions')).sessions.length, 0);

  const listed = await archivedList(h);
  assert.equal(listed.length, 1);
  assert.deepEqual({ id: listed[0].id, source: listed[0].source, title: listed[0].title, missing: listed[0].missing },
    { id: 'old-chat', source: 'claude', title: 'Parser work', missing: false });
  assert.ok(listed[0].archivedAt > 0);

  const restored = await h.call('archived-session-action', { source: 'claude', id: 'old-chat', action: 'restore' });
  assert.equal(restored.ok, true);
  assert.equal((await archivedList(h)).length, 0);
  assert.equal((await h.call('claude-list-sessions')).sessions[0].id, 'old-chat');

  h.call('claude-archive-session', { id: 'old-chat' });
  const deleted = await h.call('archived-session-action', { source: 'claude', id: 'old-chat', action: 'delete' });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await archivedList(h)).length, 0);
  const meta = h.api.claudeSessionMeta();
  for (const key of ['titles', 'archived', 'pinned', 'sessionWorkspace', 'sessionCwd']) assert.equal(meta[key]['old-chat'], undefined);
  assert.equal(h.events.some(e => e.channel === 'dsh:archived-changed' && e.data.action === 'delete' && e.data.id === 'old-chat'), true);
});

test('deleting keeps working when the transcript file is already gone', async (t) => {
  const h = setup(t);
  const file = h.seedSession('ghost', h.folder('proj'));
  h.call('claude-archive-session', { id: 'ghost' });
  fs.unlinkSync(file);
  const listed = await archivedList(h);
  assert.equal(listed[0].missing, true);
  assert.equal(listed[0].title, '(Empty session)');
  const res = await h.call('archived-session-action', { source: 'claude', id: 'ghost', action: 'delete' });
  assert.equal(res.ok, true);
  assert.equal((await archivedList(h)).length, 0);
});

test('a running conversation cannot be deleted', async (t) => {
  const h = setup(t);
  h.call('claude-send', { prompt: 'First' });
  const sid = h.finishTurn();
  h.call('claude-archive-session', { id: sid });
  h.call('claude-send', { sessionId: sid, prompt: 'Still running' });
  const res = await h.call('archived-session-action', { source: 'claude', id: sid, action: 'delete' });
  assert.equal(res.ok, false);
  assert.match(res.error, /finish or stop/);
  h.finishTurn();
});

test('shared conversations are archived and purged with all their files', async (t) => {
  const h = setup(t);
  const shared = h.api.sharedConversations;
  const c = shared.create('claude', null, 'Shared parser chat');
  shared.append(c, { role: 'user', engine: 'claude', text: 'hello' });
  shared.save(c);
  const jsonFile = path.join(shared.dir, c.id + '.json');
  const logFile = path.join(shared.dir, c.id + '.jsonl');
  assert.equal(fs.existsSync(jsonFile), true);
  assert.equal(fs.existsSync(logFile), true);

  const archive = await h.call('conversation-command', { engine: 'claude', action: 'archive-session', payload: { id: c.id } });
  assert.equal(archive.ok, true, archive.error);
  const listed = await archivedList(h);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, 'shared');
  assert.equal(listed[0].origin, 'claude');
  assert.equal(listed[0].title, 'Shared parser chat');

  const restored = await h.call('archived-session-action', { source: 'shared', id: c.id, action: 'restore' });
  assert.equal(restored.ok, true);
  assert.equal((await archivedList(h)).length, 0);

  await h.call('conversation-command', { engine: 'claude', action: 'archive-session', payload: { id: c.id } });
  const deleted = await h.call('archived-session-action', { source: 'shared', id: c.id, action: 'delete' });
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(fs.existsSync(jsonFile), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(shared.items.has(c.id), false);
  assert.equal((await archivedList(h)).length, 0);
});

test('a busy shared conversation cannot be deleted', async (t) => {
  const h = setup(t);
  const shared = h.api.sharedConversations;
  const c = shared.create('claude', null, 'Busy chat');
  shared.active.set(c.id, { facade: { gen: 1 }, permissions: new Map() });
  shared.workspaces.archiveSession(c.id, true);
  const res = await h.call('archived-session-action', { source: 'shared', id: c.id, action: 'delete' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Stop this conversation/);
  shared.active.delete(c.id);
});

test('unknown sources and actions are rejected', async (t) => {
  const h = setup(t);
  assert.equal((await h.call('archived-session-action', { source: 'nowhere', id: 'x', action: 'delete' })).ok, false);
  assert.equal((await h.call('archived-session-action', { source: 'claude', id: 'x', action: 'wipe' })).ok, false);
  assert.equal((await h.call('archived-session-action', { source: 'claude', id: '__proto__', action: 'delete' })).ok, false);
});

test('a sidebar delete removes an active engine conversation and its metadata without archiving it', async (t) => {
  const h = setup(t);
  const file = h.seedSession('live-chat', h.folder('proj'), 'Live parser work');
  h.call('claude-rename-session', { id: 'live-chat', title: 'Live parser' });
  h.call('claude-meta-op', { op: 'toggle-pin', sessionId: 'live-chat' });
  assert.equal((await h.call('claude-list-sessions')).sessions.length, 1);

  const deleted = await h.call('claude-delete-session', { id: 'live-chat' });
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await h.call('claude-list-sessions')).sessions.length, 0);
  const meta = h.api.claudeSessionMeta();
  for (const key of ['titles', 'archived', 'pinned', 'sessionWorkspace', 'sessionCwd']) assert.equal(meta[key]['live-chat'], undefined);
  assert.equal((await archivedList(h)).length, 0);
  assert.equal(h.events.some(e => e.channel === 'dsh:archived-changed' && e.data.action === 'delete' && e.data.id === 'live-chat'), true);
});

test('the sidebar delete path is also wired through the shared conversation command', async (t) => {
  const h = setup(t);
  const shared = h.api.sharedConversations;
  const c = shared.create('claude', null, 'Shared delete-me');
  let released = 0;
  h.api.codex.sessions.set({ conversationId: c.id }, { shutdown: async () => { released++; } });
  shared.append(c, { role: 'user', engine: 'claude', text: 'hello' });
  shared.save(c);
  const jsonFile = path.join(shared.dir, c.id + '.json');
  const logFile = path.join(shared.dir, c.id + '.jsonl');
  assert.equal(fs.existsSync(jsonFile), true);

  const deleted = await h.call('conversation-command', { engine: 'claude', action: 'delete-session', payload: { id: c.id } });
  assert.equal(deleted.ok, true, deleted.error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
  assert.equal(h.api.codex.sessions.get({ conversationId: c.id }), null);
  assert.equal(fs.existsSync(jsonFile), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(shared.items.has(c.id), false);
  assert.equal((await archivedList(h)).length, 0);
});

test('a busy shared conversation cannot be deleted from the sidebar', async (t) => {
  const h = setup(t);
  const shared = h.api.sharedConversations;
  const c = shared.create('claude', null, 'Busy delete-me');
  shared.active.set(c.id, { facade: { gen: 1 }, permissions: new Map() });
  const res = await h.call('conversation-command', { engine: 'claude', action: 'delete-session', payload: { id: c.id } });
  assert.equal(res.ok, false);
  assert.match(res.error, /Stop this conversation/);
  shared.active.delete(c.id);
});

test('codex, antigravity and kimi sidebar deletes remove their own engine histories', async (t) => {
  const h = setup(t);
  const seed = (engine, id) => {
    const dir = path.join(h.userData, engine + '-history', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: dir, message: { role: 'user', content: engine } }) + '\n');
    return file;
  };
  const configFile = path.join(h.userData, 'desktop-config.json');
  const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
  const bound = ['codex', 'kimi'];
  for (const engine of ['codex', 'antigravity', 'kimi']) {
    const id = engine + '-session';
    const file = seed(engine, id);
    h.call(engine + '-meta-op', { op: 'toggle-pin', sessionId: id });
    assert.equal((await h.call(engine + '-list-sessions')).sessions.some(s => s.id === id), true);
    if (bound.includes(engine)) fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(),
      [engine + 'SessionConnections']: { [id]: 'subscription' }, [engine + 'SessionAccounts']: { [id]: 'account-1' } }));
    const res = await h.call(engine + '-delete-session', { id });
    assert.equal(res.ok, true, res.error);
    assert.equal(fs.existsSync(file), false);
    if (bound.includes(engine)) {
      const after = readConfig();
      assert.equal(after[engine + 'SessionConnections']?.[id], undefined, engine + ' connection binding outlived the conversation');
      assert.equal(after[engine + 'SessionAccounts']?.[id], undefined, engine + ' account binding outlived the conversation');
    }
    assert.equal((await h.call(engine + '-list-sessions')).sessions.some(s => s.id === id), false);
    assert.equal(h.events.some(e => e.channel === 'dsh:archived-changed' && e.data.id === id && e.data.action === 'delete'), true);
  }
  assert.equal((await h.call('codex-delete-session', { id: '__proto__' })).ok, false);
});

test('delete-all removes every archived session across sources', async (t) => {
  const h = setup(t);
  const fileA = h.seedSession('old-one', h.folder('proj'), 'First');
  const fileB = h.seedSession('old-two', h.folder('proj'), 'Second');
  h.call('claude-archive-session', { id: 'old-one' });
  h.call('claude-archive-session', { id: 'old-two' });
  const shared = h.api.sharedConversations;
  const c = shared.create('kimi', null, 'Shared archived');
  shared.append(c, { role: 'user', engine: 'kimi', text: 'hello' });
  shared.save(c);
  const jsonFile = path.join(shared.dir, c.id + '.json');
  const logFile = path.join(shared.dir, c.id + '.jsonl');
  shared.workspaces.archiveSession(c.id, true);
  assert.equal((await archivedList(h)).length, 3);

  const res = await h.call('archived-session-action', { action: 'delete-all' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.deleted, 3);
  for (const file of [fileA, fileB, jsonFile, logFile]) assert.equal(fs.existsSync(file), false);
  assert.equal(shared.items.has(c.id), false);
  assert.equal((await archivedList(h)).length, 0);
  const meta = h.api.claudeSessionMeta();
  for (const key of ['titles', 'archived', 'pinned', 'sessionWorkspace', 'sessionCwd']) {
    assert.equal(meta[key]['old-one'], undefined);
    assert.equal(meta[key]['old-two'], undefined);
  }
  const change = h.events.find(e => e.channel === 'dsh:archived-changed' && e.data.action === 'delete-all');
  assert.deepEqual(new Set(change.data.ids), new Set(['old-one', 'old-two', c.id]));
});

test('delete-all keeps the event loop responsive and sends one sidebar refresh', async (t) => {
  const h = setup(t);
  const ids = Array.from({ length: 40 }, (_, index) => `bulk-${index}`);
  for (const id of ids) {
    h.seedSession(id, h.folder('proj'), id);
    h.call('claude-archive-session', { id });
  }
  const progress = [];
  const sender = { isDestroyed: () => false, send: (channel, value) => progress.push({ channel, value }) };
  let settled = false;
  const pending = h.call('archived-session-action', { action: 'delete-all' }, { sender })
    .then(result => { settled = true; return result; });
  const duplicate = await h.call('archived-session-action', { action: 'delete-all' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /already being deleted/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false, 'bulk deletion must yield so the main event loop can serve other windows');
  const result = await pending;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.deleted, ids.length);
  assert.equal((await archivedList(h)).length, 0);
  assert.equal(progress[0].channel, 'dsh:archived-delete-progress');
  assert.deepEqual({ processed: progress[0].value.processed, total: progress[0].value.total }, { processed: 0, total: ids.length });
  assert.equal(progress.at(-1).value.processed, ids.length);
  const changes = h.events.filter(event => event.channel === 'dsh:archived-changed' && ['delete', 'delete-all'].includes(event.data.action));
  assert.equal(changes.length, 1, 'chat windows should reload their sidebar only once');
  assert.equal(changes[0].data.action, 'delete-all');
  assert.deepEqual(new Set(changes[0].data.ids), new Set(ids));
});

test('delete-all stops at a busy conversation and reports the error', async (t) => {
  const h = setup(t);
  const file = h.seedSession('busy-peer', h.folder('proj'), 'Deletable');
  h.call('claude-archive-session', { id: 'busy-peer' });
  const shared = h.api.sharedConversations;
  const c = shared.create('claude', null, 'Busy chat');
  shared.active.set(c.id, { facade: { gen: 1 }, permissions: new Map() });
  shared.workspaces.archiveSession(c.id, true);
  const res = await h.call('archived-session-action', { action: 'delete-all' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Stop this conversation/);
  assert.equal(fs.existsSync(file), false); // earlier sources were already cleared
  const remaining = await archivedList(h);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, c.id);
  const change = h.events.find(e => e.channel === 'dsh:archived-changed' && e.data.action === 'delete-all');
  assert.deepEqual([...change.data.ids], ['busy-peer'], 'a partial failure must still refresh the sidebar for deleted conversations');
  shared.active.delete(c.id);
});
