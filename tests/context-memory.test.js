'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { snapshotFor, viewFor, compactView, statusFor, searchFor, remember, entriesFromSnapshot, MAX_SNAPSHOT } = require('../src/engines/context-memory');

function fixture(t, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-memory-'));
  t.after(() => removeTree(dir));
  return {
    manager: { dir, loadConfig: () => ({ contextMemory: { enabled } }) },
    conversation: { id: 'conversation', workspaceId: 'workspace', cwd: '/tmp/workspace' },
  };
}

test('working memory stores user and workspace entries, deduplicates and snapshots them', t => {
  const { manager, conversation } = fixture(t);
  const user = remember(manager, conversation, { text: 'Prefer concise answers.', scope: 'user', importance: 'critical' });
  const workspace = remember(manager, conversation, { text: 'Tests use node --test.', scope: 'workspace' });
  assert.equal(user.replayed, false);
  assert.equal(workspace.replayed, false);
  const duplicate = remember(manager, conversation, { text: 'Tests use node --test.', scope: 'workspace' });
  assert.equal(duplicate.replayed, true);
  const status = statusFor(manager, conversation);
  assert.equal(status.enabled, true);
  assert.equal(status.scope.user, 1);
  assert.equal(status.scope.workspace, 1);
  const snapshot = snapshotFor(manager, conversation);
  assert.match(snapshot, /Prefer concise answers/);
  assert.match(snapshot, /Tests use node --test/);
  assert.ok(snapshot.length <= MAX_SNAPSHOT + 200);
  const search = searchFor(manager, conversation, 'concise answers');
  assert.equal(search.results.length, 1);
});

test('disabled memory injects no snapshot and still reports its files', t => {
  const { manager, conversation } = fixture(t, false);
  remember({ ...manager, loadConfig: () => ({ contextMemory: { enabled: true } }) }, conversation,
    { text: 'Stored while enabled.', scope: 'workspace' });
  assert.equal(snapshotFor(manager, conversation), '');
  const status = statusFor(manager, conversation);
  assert.equal(status.enabled, false);
  assert.equal(status.scope.workspace, 1);
});

test('a pinned snapshot remains the read-only source after live memory changes', t => {
  const { manager, conversation } = fixture(t);
  remember(manager, conversation, { text: 'Pinned preference', scope: 'user' });
  const pinned = snapshotFor(manager, conversation);
  remember(manager, conversation, { text: 'Added after the turn started', scope: 'user' });
  assert.deepEqual(entriesFromSnapshot(pinned).map(entry => entry.text), ['Pinned preference']);
  const status = statusFor(manager, conversation, { snapshot: pinned });
  assert.equal(status.pinned, true);
  assert.equal(status.scope.user, 1);
  assert.doesNotMatch(status.snapshot, /Added after/);
  const search = searchFor(manager, conversation, 'preference', 8, { snapshot: pinned });
  assert.deepEqual(search.results.map(entry => entry.text), ['Pinned preference']);
  const empty = statusFor(manager, conversation, { snapshot: '' });
  assert.equal(empty.scope.user, 0);
  assert.doesNotMatch(empty.snapshot, /Pinned preference/);
});

test('a pinned memory view searches entries omitted from the resident snapshot', t => {
  const { manager, conversation } = fixture(t);
  remember(manager, conversation, { text: 'Omitted needle: use the blue deployment.', scope: 'workspace', importance: 'low' });
  for (let index = 0; index < 30; index++)
    remember(manager, conversation, { text: 'Resident filler ' + index + ' ' + 'x'.repeat(500), scope: 'workspace', importance: 'low' });
  const view = viewFor(manager, conversation);
  assert.ok(view.entries.length > 30);
  assert.ok(view.snapshot.length <= MAX_SNAPSHOT + 200);
  assert.doesNotMatch(view.snapshot, /Omitted needle/);
  const search = searchFor(manager, conversation, 'needle', 8, { view });
  assert.deepEqual(search.results.map(entry => entry.text), ['Omitted needle: use the blue deployment.']);
  remember(manager, conversation, { text: 'Newer needle must stay out.', scope: 'workspace', importance: 'low' });
  const pinned = compactView(view);
  const later = searchFor(manager, conversation, 'needle', 8, { view: pinned });
  assert.deepEqual(later.results.map(entry => entry.text), ['Omitted needle: use the blue deployment.']);
  const status = statusFor(manager, conversation, { view: pinned });
  assert.equal(status.pinned, true);
  assert.equal(status.scope.workspace, view.entries.length);
});

test('pinned memory keeps user and workspace scopes and searches omitted Unicode entries', t => {
  const { manager, conversation } = fixture(t);
  remember(manager, conversation, { text: '用户偏好：回答保持简洁。', scope: 'user', importance: 'critical' });
  remember(manager, conversation, { text: '部署备注：使用蓝色环境。', scope: 'workspace', importance: 'low' });
  for (let index = 0; index < 24; index++)
    remember(manager, conversation, { text: '缓存填充 ' + index + ' ' + 'x'.repeat(500), scope: 'workspace', importance: 'low' });
  const view = viewFor(manager, conversation);
  assert.ok(view.entries.some(entry => entry.text.includes('蓝色环境')));
  const status = statusFor(manager, conversation, { view });
  assert.equal(status.scope.user, 1);
  assert.equal(status.scope.workspace, 25);
  const search = searchFor(manager, conversation, '蓝色环境', 8, { view });
  assert.deepEqual(search.results.map(entry => [entry.scope, entry.importance]),
    [['workspace', 'low']]);
  const compact = compactView(view);
  remember(manager, conversation, { text: '蓝色环境 后来新增', scope: 'workspace', importance: 'critical' });
  const pinnedSearch = searchFor(manager, conversation, '蓝色环境', 8, { view: compact });
  assert.deepEqual(pinnedSearch.results.map(entry => entry.text), ['部署备注：使用蓝色环境。']);
});
