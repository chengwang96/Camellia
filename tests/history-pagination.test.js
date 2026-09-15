'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { writeJson } = require('../src/shared/json-store');
const { createHarness } = require('./claude-harness.cjs');

test('1,350 conversations are paged by group, collapsed workspaces read no heads and older sessions remain accessible', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const dir = h.folder('large-project');
  const ws = h.call('claude-meta-op', { op: 'create-workspace', name: 'Large project', path: dir }).workspace;
  const meta = h.api.claudeSessionMeta();
  for (let i = 0; i < 1350; i++) {
    const id = 'history-' + i;
    h.seedSession(id, dir, 'Conversation ' + i, 2000000 - i * 1000);
    if (i < 1200) meta.sessionWorkspace[id] = ws.id;
    else if (i >= 1280) meta.pinned[id] = 1;
  }
  meta.collapsed[ws.id] = true;
  const save = () => writeJson(path.join(h.userData, 'desktop-config.json'), { claudeMeta: meta });
  save();
  let headsRead = 0;
  const cacheHead = ClaudeHistory.prototype.cacheHead;
  t.mock.method(ClaudeHistory.prototype, 'cacheHead', function (...args) { headsRead++; return cacheHead.apply(this, args); });
  t.mock.method(fs, 'readdirSync', () => { throw new Error('history listing must not enumerate synchronously'); });
  const first = await h.call('claude-list-sessions');
  assert.equal(first.ok, true, first.error);
  assert.equal(first.sessions.length, 120);
  assert.equal(headsRead, 120);
  assert.equal(first.workspaces[0].sessionCount, 1200);
  assert.equal(first.pagination[ws.id].loaded, 0);
  assert.equal(first.pagination.recent.total, 80);
  assert.equal(first.pagination.pinned.total, 70);
  assert.equal(first.latestSessionId, 'history-0');

  meta.collapsed[ws.id] = false; save();
  const opened = await h.call('claude-list-sessions');
  assert.equal(opened.sessions.length, 180);
  assert.equal(headsRead, 180);
  const more = await h.call('claude-list-sessions', { limits: { [ws.id]: 120, recent: 120, pinned: 120 } });
  assert.equal(more.sessions.length, 270);
  assert.equal(headsRead, 270);
  assert.equal(more.pagination[ws.id].hasMore, true);
  assert.equal(more.pagination.recent.hasMore, false);
  assert.equal(more.pagination.pinned.hasMore, false);
  const active = await h.call('claude-list-sessions', { activeSessionId: 'history-1199' });
  assert.equal(active.sessions.find(s => s.id === 'history-1199').workspaceId, ws.id);
  assert.equal(headsRead, 271);
  meta.archived['history-0'] = 1; save();
  const end = await h.call('claude-list-sessions', { limits: { [ws.id]: 1200 } });
  assert.equal(end.pagination[ws.id].total, 1199);
  assert.equal(end.pagination[ws.id].hasMore, false);
  assert.equal(end.workspaces[0].sessionCount, 1199);
  assert.ok(end.sessions.some(s => s.id === 'history-1199'));
  assert.equal(end.latestSessionId, 'history-1');
});

test('overlapping history scans share a promise; later scans see newly written transcripts', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const history = new ClaudeHistory(path.join(h.home, '.claude', 'projects'));
  const first = history.list(), second = history.list();
  assert.equal(first, second);
  assert.equal((await first).length, 0);
  h.seedSession('new', h.folder('project'));
  assert.equal((await history.list())[0].id, 'new');
});
