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
  for (const id of ['old-one', 'old-two', c.id]) {
    assert.equal(h.events.some(e => e.channel === 'dsh:archived-changed' && e.data.action === 'delete' && e.data.id === id), true);
  }
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
  shared.active.delete(c.id);
});
