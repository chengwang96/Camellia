'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');

function setup(t) {
  const harness = createHarness();
  harness.configureApi();
  t.after(() => harness.cleanup());
  return harness;
}

for (const archiveSessions of [false, true]) {
  test(`shared workspace removal with archiveSessions=${archiveSessions} preserves files, unrelated sessions and restart state`, async t => {
    const harness = setup(t);
    const shared = harness.api.sharedConversations;
    const command = (action, payload) => harness.call('conversation-command', { engine: 'codex', action, payload });
    const folder = harness.folder('Archive project');
    const canonicalFolder = fs.realpathSync(folder);
    const projectFile = path.join(folder, 'keep.txt');
    fs.writeFileSync(projectFile, 'Do not delete project files');
    const created = await command('meta-op', { op: 'create-workspace', name: 'Archive project', path: folder });
    assert.equal(created.ok, true, created.error);
    const workspace = created.workspace;
    const otherWorkspace = await command('meta-op', { op: 'create-workspace', name: 'Other', path: harness.folder('Other') });
    const unrelated = shared.create('codex', otherWorkspace.workspace.id, 'Other workspace');
    const independent = shared.create('claude', null, 'Independent');
    const grouped = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'].map(engine => {
      const conversation = shared.create(engine, workspace.id, engine + ' conversation');
      shared.append(conversation, { role: 'user', engine, text: 'Retain this transcript' });
      shared.save(conversation);
      return conversation;
    });
    await command('meta-op', { op: 'toggle-pin', sessionId: grouped[0].id });
    await command('rename-session', { id: grouped[0].id, title: 'Pinned renamed conversation' });
    await command('archive-session', { id: grouped[1].id });
    const originalArchiveTime = shared.workspaces.sessionMeta().archived[grouped[1].id];
    await command('meta-op', { op: 'toggle-collapse', workspaceId: workspace.id });
    const transcripts = new Map(grouped.map(conversation => {
      const file = path.join(shared.dir, conversation.id + '.jsonl');
      return [file, fs.readFileSync(file, 'utf8')];
    }));

    const removed = await command('meta-op', { op: 'delete-workspace', id: workspace.id, archiveSessions });
    assert.equal(removed.ok, true, removed.error);
    assert.equal(removed.meta.workspaces.some(entry => entry.id === workspace.id), false);
    assert.equal(removed.meta.collapsed[workspace.id], undefined);
    assert.equal(removed.meta.archived[grouped[1].id], originalArchiveTime);
    assert.ok(removed.meta.pinned[grouped[0].id]);
    assert.equal(removed.meta.titles[grouped[0].id], 'Pinned renamed conversation');
    for (const conversation of grouped) {
      assert.equal(removed.meta.sessionWorkspace[conversation.id], null);
      assert.equal(Boolean(removed.meta.archived[conversation.id]), archiveSessions || conversation === grouped[1]);
      assert.equal(shared.get(conversation.id).workspaceId, null);
      assert.equal(shared.get(conversation.id).cwd, canonicalFolder);
      assert.equal(JSON.parse(fs.readFileSync(path.join(shared.dir, conversation.id + '.json'), 'utf8')).workspaceId, null);
    }
    for (const [file, content] of transcripts) assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), 'Do not delete project files');

    const restarted = createHarness(harness.root);
    const sessions = (await restarted.call('conversation-command', { engine: 'codex', action: 'list-sessions' })).sessions;
    assert.ok(sessions.some(entry => entry.id === unrelated.id && entry.workspaceId === otherWorkspace.workspace.id));
    assert.ok(sessions.some(entry => entry.id === independent.id && entry.workspaceId === null));
    for (const conversation of grouped) {
      assert.equal(sessions.some(entry => entry.id === conversation.id), !archiveSessions && conversation !== grouped[1]);
    }
    const archived = await restarted.call('archived-sessions-list');
    assert.equal(archived.ok, true, archived.error);
    assert.equal(archived.sessions.length, archiveSessions ? grouped.length : 1);
    for (const entry of archived.sessions) {
      assert.equal(entry.source, 'shared');
      assert.equal((await restarted.call('conversation-command', { engine: 'codex', action: 'load-session', payload: entry.id })).ok, false);
      const restored = await restarted.call('archived-session-action', { source: 'shared', id: entry.id, action: 'restore' });
      assert.equal(restored.ok, true, restored.error);
      const loaded = await restarted.call('conversation-command', { engine: 'codex', action: 'load-session', payload: entry.id });
      assert.equal(loaded.ok, true, loaded.error);
      assert.equal(loaded.workspaceId, null);
      assert.equal(loaded.cwd, canonicalFolder);
      assert.ok(loaded.messages.some(message => message.text === 'Retain this transcript'));
    }
    assert.equal((await restarted.call('archived-sessions-list')).sessions.length, 0);
  });
}

test('workspace archive includes sessions beyond the history page and rejects repeated removal without changing metadata', async t => {
  const harness = setup(t);
  const workspace = harness.call('claude-meta-op', { op: 'create-workspace', name: 'Many sessions', path: harness.folder('Many') }).workspace;
  const files = [];
  for (let index = 0; index < 75; index++) {
    const id = 'archive-page-' + index;
    files.push(harness.seedSession(id, workspace.path));
    harness.call('claude-meta-op', { op: 'assign-session', sessionId: id, workspaceId: workspace.id });
  }
  assert.equal((await harness.call('claude-list-sessions')).sessions.length, 60);
  const result = harness.call('claude-meta-op', { op: 'delete-workspace', id: workspace.id, archiveSessions: true });
  assert.equal(result.ok, true, result.error);
  assert.equal((await harness.call('claude-list-sessions')).sessions.length, 0);
  assert.equal((await harness.call('archived-sessions-list')).sessions.length, 75);
  for (const file of files) assert.equal(fs.existsSync(file), true);
  const before = JSON.stringify(harness.api.claudeSessionMeta());
  assert.equal(harness.call('claude-meta-op', { op: 'delete-workspace', id: workspace.id, archiveSessions: true }).ok, false);
  assert.equal(JSON.stringify(harness.api.claudeSessionMeta()), before);
});

test('workspace archive rejects a running shared conversation without partial removal', async t => {
  const harness = setup(t);
  const shared = harness.api.sharedConversations;
  const workspace = shared.workspaces.metaOp({ op: 'create-workspace', name: 'Busy', path: harness.folder('Busy') }).workspace;
  const conversation = shared.create('codex', workspace.id);
  shared.active.set(conversation.id, { facade: { gen: 1 }, permissions: new Map() });
  const before = JSON.stringify(shared.workspaces.sessionMeta());
  try {
    const result = await harness.call('conversation-command', {
      engine: 'claude', action: 'meta-op', payload: { op: 'delete-workspace', id: workspace.id, archiveSessions: true },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Stop conversations/);
    assert.equal(JSON.stringify(shared.workspaces.sessionMeta()), before);
    assert.equal(shared.get(conversation.id).workspaceId, workspace.id);
  } finally {
    shared.active.delete(conversation.id);
  }
});

test('an empty workspace can be removed with archive enabled', async t => {
  const harness = setup(t);
  const shared = harness.api.sharedConversations;
  const workspace = shared.workspaces.metaOp({ op: 'create-workspace', name: 'Empty', path: harness.folder('Empty') }).workspace;
  const result = await harness.call('conversation-command', {
    engine: 'codex', action: 'meta-op', payload: { op: 'delete-workspace', id: workspace.id, archiveSessions: true },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.meta.workspaces.length, 0);
  assert.deepEqual(result.meta.archived, {});
  assert.equal(fs.existsSync(workspace.path), true);
});
