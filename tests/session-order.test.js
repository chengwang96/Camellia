'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness } = require('./claude-harness.cjs');

function fixture(context) {
  const harness = createHarness();
  harness.configureApi();
  context.after(() => harness.cleanup());
  const shared = harness.api.sharedConversations;
  const command = (action, payload) => harness.call('conversation-command', { engine: 'codex', action, payload });
  const workspace = name => shared.workspaces.metaOp({ op: 'create-workspace', name, path: harness.folder(name) }).workspace;
  return { harness, shared, command, workspace };
}

test('manual order is applied before pagination and survives activity and restart', async context => {
  const { harness, shared, command, workspace } = fixture(context);
  const group = workspace('Order');
  const sessions = Array.from({ length: 65 }, (_, index) => shared.create('codex', group.id, 'Session ' + index));
  const moved = sessions[0], target = sessions[64];
  const result = await command('meta-op', { op: 'move-session', sessionId: moved.id, group: group.id, targetSessionId: target.id, placement: 'before' });
  assert.equal(result.ok, true, result.error);
  const order = (await command('list-sessions')).sessions.map(session => session.id);
  assert.equal(order.length, 60);
  assert.equal(order.indexOf(moved.id) + 1, order.indexOf(target.id));
  sessions[15].updatedAt = Date.now() + 100000;
  shared.save(sessions[15]);
  const restarted = createHarness(harness.root);
  const listed = await restarted.call('conversation-command', { engine: 'codex', action: 'list-sessions' });
  assert.deepEqual(listed.sessions.map(session => session.id), order);
});

test('moving between workspaces preserves transcript and execution directory across restart', async context => {
  const { harness, shared, command, workspace } = fixture(context);
  const source = workspace('Source'), target = workspace('Target');
  const conversation = shared.create('codex', source.id, 'Move me');
  shared.append(conversation, { role: 'user', engine: 'codex', text: 'Keep this message' });
  const originalCwd = conversation.cwd;
  const transcript = fs.readFileSync(shared.dir + '/' + conversation.id + '.jsonl', 'utf8');
  await command('meta-op', { op: 'toggle-collapse', workspaceId: target.id });
  const result = await command('meta-op', { op: 'move-session', sessionId: conversation.id, group: target.id });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.meta.collapsed[target.id], undefined);
  assert.equal(conversation.workspaceId, target.id);
  assert.equal(conversation.cwd, originalCwd);
  const restarted = createHarness(harness.root);
  const loaded = await restarted.call('conversation-command', { engine: 'codex', action: 'load-session', payload: conversation.id });
  assert.equal(loaded.workspaceId, target.id);
  assert.equal(loaded.cwd, originalCwd);
  assert.equal((await command('list-sessions')).sessions[0].cwd, originalCwd);
  assert.equal(fs.readFileSync(shared.dir + '/' + conversation.id + '.jsonl', 'utf8'), transcript);
  await command('meta-op', { op: 'move-session', sessionId: conversation.id, group: 'recent' });
  assert.equal(conversation.workspaceId, null);
  assert.equal(conversation.cwd, originalCwd);
});

test('pinned moves preserve membership and workspace moves unpin; invalid targets do not mutate metadata', async context => {
  const { shared, command, workspace } = fixture(context);
  const group = workspace('Pinned');
  const conversation = shared.create('codex', group.id, 'Pinned session');
  const other = shared.create('codex', null, 'Other');
  await command('meta-op', { op: 'move-session', sessionId: conversation.id, group: 'pinned' });
  assert.equal(conversation.workspaceId, group.id);
  assert.ok(shared.workspaces.sessionMeta().pinned[conversation.id]);
  const before = JSON.stringify(shared.workspaces.sessionMeta());
  for (const payload of [
    { group: 'missing' },
    { group: group.id, targetSessionId: other.id, placement: 'before' },
    { group: 'recent', targetSessionId: other.id, placement: 'invalid' },
  ]) {
    const result = await command('meta-op', { op: 'move-session', sessionId: conversation.id, ...payload });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(shared.workspaces.sessionMeta()), before);
  }
  await command('meta-op', { op: 'move-session', sessionId: conversation.id, group: 'recent', targetSessionId: other.id, placement: 'after' });
  assert.equal(shared.workspaces.sessionMeta().pinned[conversation.id], undefined);
  assert.equal(conversation.workspaceId, null);
  assert.deepEqual((await command('list-sessions')).sessions.map(session => session.id), [other.id, conversation.id]);
});

test('legacy sessions retain their execution directory when reorganized', async context => {
  const { harness } = fixture(context);
  const original = harness.folder('Original directory');
  harness.seedSession('legacy-move', original);
  const target = harness.call('claude-meta-op', { op: 'create-workspace', name: 'Target', path: harness.folder('Legacy target') }).workspace;
  const result = await harness.call('claude-meta-op', { op: 'move-session', sessionId: 'legacy-move', group: target.id });
  assert.equal(result.ok, true, result.error);
  const listed = (await harness.call('claude-list-sessions')).sessions[0];
  assert.equal(listed.workspaceId, target.id);
  assert.equal(listed.cwd, original);
  const before = JSON.stringify(harness.api.claudeSessionMeta());
  const missing = await harness.call('claude-meta-op', { op: 'move-session', sessionId: 'missing', group: target.id });
  assert.equal(missing.ok, false);
  assert.equal(JSON.stringify(harness.api.claudeSessionMeta()), before);
});

test('agent reply metadata promotes its conversation within its current group', async context => {
  const { shared, command, workspace } = fixture(context);
  const group = workspace('Replies');
  const first = shared.create('codex', group.id, 'First');
  const second = shared.create('codex', group.id, 'Second');
  await command('meta-op', { op: 'move-session', sessionId: first.id, group: group.id, targetSessionId: second.id, placement: 'after' });
  first.lastReplyAt = Date.now();
  shared.save(first);
  shared.workspaces.promoteSession(first.id);
  const listed = await command('list-sessions');
  assert.deepEqual(listed.sessions.filter(session => session.workspaceId === group.id).map(session => session.id), [first.id, second.id]);
  assert.ok(shared.get(first.id).lastReplyAt > 0);
});
