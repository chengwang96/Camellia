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

test('workspace moves persist order without changing conversations or collapsed state', async context => {
  const { harness, shared, command, workspace } = fixture(context);
  const first = workspace('First'), second = workspace('Second'), third = workspace('Third');
  const conversation = shared.create('codex', first.id, 'Keep membership');
  await command('meta-op', { op: 'toggle-collapse', workspaceId: first.id });
  const original = shared.workspaces.sessionMeta();
  for (const [workspaceId, targetWorkspaceId, placement, expected] of [
    [third.id, first.id, 'before', [third.id, first.id, second.id]],
    [first.id, second.id, 'after', [third.id, second.id, first.id]],
  ]) {
    const result = await command('meta-op', { op: 'move-workspace', workspaceId, targetWorkspaceId, placement });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual((await command('list-sessions')).workspaces.map(entry => entry.id), expected);
  }
  const saved = shared.workspaces.sessionMeta();
  assert.deepEqual(saved, { ...original, workspaces: [third, second, first] });
  assert.equal(shared.get(conversation.id).workspaceId, first.id);
  const restarted = createHarness(harness.root);
  const listed = await restarted.call('conversation-command', { engine: 'codex', action: 'list-sessions' });
  assert.deepEqual(listed.workspaces.map(entry => entry.id), [third.id, second.id, first.id]);
  assert.equal(listed.workspaces[2].collapsed, true);
});

test('invalid workspace moves and self drops leave metadata unchanged', async context => {
  const { shared, command, workspace } = fixture(context);
  const first = workspace('First'), second = workspace('Second');
  const original = shared.workspaces.sessionMeta();
  for (const payload of [
    { workspaceId: 'missing', targetWorkspaceId: second.id, placement: 'before' },
    { workspaceId: first.id, targetWorkspaceId: 'missing', placement: 'after' },
    { workspaceId: first.id, targetWorkspaceId: second.id, placement: 'invalid' },
    { workspaceId: first.id, placement: 'before' },
  ]) {
    assert.equal((await command('meta-op', { op: 'move-workspace', ...payload })).ok, false);
    assert.deepEqual(shared.workspaces.sessionMeta(), original);
  }
  assert.equal((await command('meta-op', { op: 'move-workspace', workspaceId: first.id, targetWorkspaceId: first.id, placement: 'before' })).ok, true);
  assert.deepEqual(shared.workspaces.sessionMeta(), original);
});

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

test('new conversations appear first within their workspace', async context => {
  const { shared, command, workspace } = fixture(context);
  const group = workspace('New conversations');
  const first = shared.create('codex', group.id, 'First');
  const second = shared.create('codex', group.id, 'Second');
  await command('meta-op', { op: 'move-session', sessionId: first.id, group: group.id, targetSessionId: second.id, placement: 'before' });
  const third = shared.create('codex', group.id, 'Third');
  const listed = await command('list-sessions');
  assert.deepEqual(listed.sessions.filter(session => session.workspaceId === group.id).map(session => session.id), [third.id, first.id, second.id]);
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

for (const groupType of ['workspace', 'recent', 'pinned']) test('sending immediately promotes a conversation in ' + groupType + ' before engine preparation', async context => {
  const { harness, shared, command, workspace } = fixture(context);
  const group = workspace('Sending');
  const workspaceId = groupType === 'recent' ? null : group.id;
  const groupKey = groupType === 'workspace' ? group.id : groupType;
  const first = shared.create('claude', workspaceId, 'First');
  const second = shared.create('claude', workspaceId, 'Second');
  if (groupType === 'pinned') {
    await command('meta-op', { op: 'move-session', sessionId: first.id, group: 'pinned' });
  }
  await command('meta-op', { op: 'move-session', sessionId: second.id, group: groupKey });
  const other = shared.create('claude', groupType === 'recent' ? group.id : null, 'Other group');
  const before = shared.workspaces.sessionMeta();
  const preparedOrder = new Promise(resolve => {
    shared.prepare = async () => resolve(shared.workspaces.sessionMeta().sessionOrder[groupKey].slice());
  });
  const sent = await harness.call('conversation-command', { engine: 'claude', action: 'send', payload: { sessionId: first.id, prompt: 'Send now' } });
  assert.equal(sent.ok, true, sent.error);
  assert.deepEqual(await preparedOrder, [first.id, second.id]);
  assert.equal(shared.active.has(first.id), true);
  assert.equal(shared.get(first.id).lastReplyAt, undefined);
  assert.equal(first.workspaceId, workspaceId);
  assert.equal(other.workspaceId, groupType === 'recent' ? group.id : null);
  const after = shared.workspaces.sessionMeta();
  assert.deepEqual(after.pinned, before.pinned);
  assert.deepEqual(after.sessionWorkspace, before.sessionWorkspace);
  const ids = new Set([first.id, second.id]);
  assert.deepEqual((await command('list-sessions')).sessions.filter(session => ids.has(session.id)).map(session => session.id), [first.id, second.id]);
  const restarted = createHarness(harness.root);
  const listed = await restarted.call('conversation-command', { engine: 'codex', action: 'list-sessions' });
  assert.deepEqual(listed.sessions.filter(session => ids.has(session.id)).map(session => session.id), [first.id, second.id]);
  harness.finishTurn();
  await new Promise(resolve => setImmediate(resolve));
});

test('rejected sends do not change manual order', async context => {
  const { harness, shared, command } = fixture(context);
  const first = shared.create('claude', null, 'First');
  const second = shared.create('claude', null, 'Second');
  await command('meta-op', { op: 'move-session', sessionId: second.id, group: 'recent' });
  const before = shared.workspaces.sessionMeta().sessionOrder;
  const sent = await harness.call('conversation-command', { engine: 'claude', action: 'send', payload: { sessionId: first.id, prompt: 'x'.repeat(200001) } });
  assert.equal(sent.ok, false);
  assert.deepEqual(shared.workspaces.sessionMeta().sessionOrder, before);
});

test('completed agent replies promote their conversation within its current group', async context => {
  const { harness, shared, command, workspace } = fixture(context);
  shared.prepare = async () => {};
  const group = workspace('Replies');
  const first = shared.create('codex', group.id, 'First');
  const second = shared.create('codex', group.id, 'Second');
  assert.deepEqual((await command('list-sessions')).sessions.filter(session => session.workspaceId === group.id).map(session => session.id), [second.id, first.id]);
  const sent = await harness.call('conversation-command', { engine: 'claude', action: 'send', payload: { sessionId: first.id, prompt: 'Reply to this conversation' } });
  assert.equal(sent.ok, true, sent.error);
  await command('meta-op', { op: 'move-session', sessionId: second.id, group: group.id });
  harness.finishTurn();
  await new Promise(resolve => setImmediate(resolve));
  const listed = await command('list-sessions');
  assert.deepEqual(listed.sessions.filter(session => session.workspaceId === group.id).map(session => session.id), [first.id, second.id]);
  assert.ok(shared.get(first.id).lastReplyAt > 0);
});

test('conversations created within the same millisecond keep the newest first', async context => {
  const { shared, command, workspace } = fixture(context);
  const group = workspace('Same millisecond');
  const wallClock = Date.now;
  Date.now = () => 1700000000000;
  let first, second, third;
  try {
    first = shared.create('codex', group.id, 'First');
    second = shared.create('codex', group.id, 'Second');
    third = shared.create('codex', group.id, 'Third');
  } finally { Date.now = wallClock; }
  assert.ok(first.updatedAt < second.updatedAt && second.updatedAt < third.updatedAt);
  const listed = await command('list-sessions');
  assert.deepEqual(listed.sessions.filter(session => session.workspaceId === group.id).map(session => session.id), [third.id, second.id, first.id]);
});
