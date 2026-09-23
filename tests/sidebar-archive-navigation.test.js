'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude-sidebar.js'), 'utf8');
const archiveSource = source.slice(
  source.indexOf('  function sidebarGroupKey('),
  source.indexOf('  // ---------- local Codex desktop session import ----------'));

// Runs the real sidebar archive handler against a scripted history list.
// `pages` are the session lists reported by successive loadSessionHistory calls.
function fixture({ sessions, sessionId = 'open', archiveOk = true, canChange = true, openResult = true,
  pagination = {}, pages = [], listFails = false }) {
  const state = { sessions, archived: [], opened: [], created: [], status: [], limits: [] };
  const context = {
    sessionHistory: sessions,
    workspaces: [],
    context: { sessionId },
    pagination,
    limits: {},
    canChangeContext: () => canChange,
    setStatus: text => state.status.push(text),
    chatApi: { archiveSession: async ({ id, archived }) => {
      state.archived.push({ id, archived });
      return archiveOk ? { ok: true } : { ok: false, error: 'Archive failed' };
    } },
    loadSessionHistory: async () => {
      if (listFails) return false;
      state.limits.push({ ...context.limits });
      if (pages.length) state.sessions = pages.shift();
      else state.sessions = state.sessions.filter(entry => !state.archived.some(row => row.id === entry.id));
      context.sessionHistory = state.sessions;
      return true;
    },
    // Mirrors the real opener: it claims the context on success and clears it
    // when the history cannot be loaded.
    openHistorySession: async id => {
      state.opened.push(id);
      context.context.sessionId = openResult ? id : null;
      return openResult;
    },
    newSession: async workspaceId => { state.created.push(workspaceId); },
  };
  vm.runInNewContext(archiveSource, context);
  return { context, state };
}

const workspace = id => ({ id: 's-' + id, title: id, workspaceId: 'ws' });

test('archiving the open workspace conversation opens the one below it', async () => {
  const sessions = [workspace('first'), workspace('second'), workspace('third')];
  const { context, state } = fixture({ sessions, sessionId: 's-second' });
  await context.archiveSession(sessions[1]);
  assert.deepEqual(state.archived, [{ id: 's-second', archived: true }]);
  assert.deepEqual(state.opened, ['s-third']);
  assert.deepEqual(state.created, []);
  assert.deepEqual(state.status, ['Session archived']);
});

test('archiving the last conversation of a workspace opens the one above it', async () => {
  const sessions = [workspace('first'), workspace('second')];
  const { context, state } = fixture({ sessions, sessionId: 's-second' });
  await context.archiveSession(sessions[1]);
  assert.deepEqual(state.opened, ['s-first']);
  assert.deepEqual(state.created, []);
});

test('archiving the only conversation of a workspace opens that workspace new-session page', async () => {
  const sessions = [{ id: 'only', title: 'Only', workspaceId: 'ws' }, { id: 'other', title: 'Other', workspaceId: 'other-ws' }];
  const { context, state } = fixture({ sessions, sessionId: 'only' });
  await context.archiveSession(sessions[0]);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.created, ['ws']);
});

test('standalone conversations follow the same rule and fall back to a standalone draft', async () => {
  const shared = [{ id: 'one', title: 'One', workspaceId: null }, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' }];
  const { context, state } = fixture({ sessions: shared, sessionId: 'two' });
  await context.archiveSession(shared[1]);
  assert.deepEqual(state.opened, ['three']);
  assert.deepEqual(state.created, []);

  const solo = [{ id: 'solo', title: 'Solo', workspaceId: null }];
  const second = fixture({ sessions: solo, sessionId: 'solo' });
  await second.context.archiveSession(solo[0]);
  assert.deepEqual(second.state.opened, []);
  assert.deepEqual(second.state.created, [null]);
});

test('a pinned conversation still navigates inside its workspace', async () => {
  const sessions = [
    { id: 'pin-a', title: 'Pin A', pinned: true, workspaceId: 'ws' },
    { id: 'pin-b', title: 'Pin B', pinned: true, workspaceId: 'other' },
    workspace('workspace-row'),
  ];
  const { context, state } = fixture({ sessions, sessionId: 'pin-a' });
  await context.archiveSession(sessions[0]);
  assert.deepEqual(state.opened, ['s-workspace-row']);
  assert.deepEqual(state.created, []);
});

test('archiving the last conversation of a pinned workspace opens its draft page', async () => {
  const sessions = [{ id: 'pin-a', title: 'Pin A', pinned: true, workspaceId: 'ws' },
    { id: 'unrelated', title: 'Unrelated', workspaceId: 'other' }];
  const { context, state } = fixture({ sessions, sessionId: 'pin-a' });
  await context.archiveSession(sessions[0]);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.created, ['ws']);
});

test('archiving a conversation other than the open one keeps the current one', async () => {
  const sessions = [workspace('open-row'), workspace('other')];
  const { context, state } = fixture({ sessions, sessionId: 's-open-row' });
  await context.archiveSession(sessions[1]);
  assert.deepEqual(state.archived, [{ id: 's-other', archived: true }]);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.created, []);
  assert.deepEqual(state.status, ['Session archived']);
});

test('a neighbor that is gone, archived elsewhere, or unreadable falls back to the new-session page', async () => {
  const sessions = [workspace('first'), workspace('second')];
  const gone = fixture({ sessions, sessionId: 's-first', pages: [[]] });
  await gone.context.archiveSession(sessions[0]);
  assert.deepEqual(gone.state.opened, []);
  assert.deepEqual(gone.state.created, ['ws']);

  const unreadable = fixture({ sessions, sessionId: 's-first', openResult: false, pages: [[sessions[1]]] });
  await unreadable.context.archiveSession(sessions[0]);
  assert.deepEqual(unreadable.state.opened, ['s-second']);
  assert.deepEqual(unreadable.state.created, ['ws']);
});

test('the last row of a loaded page pulls the next history page before falling back', async () => {
  const sessions = [workspace('first')];
  const older = workspace('older');
  const newest = workspace('newest');
  const { context, state } = fixture({
    sessions, sessionId: 's-first', pages: [[sessions[0], older, newest], [older, newest]],
    pagination: { ws: { total: 3, loaded: 1, hasMore: true } },
  });
  await context.archiveSession(sessions[0]);
  assert.deepEqual(state.limits[0], { ws: 61 });
  assert.deepEqual(state.opened, ['s-older']);
  assert.deepEqual(state.created, []);
});


test('a failed or blocked archive changes nothing', async () => {
  const sessions = [workspace('first'), workspace('second')];
  const failed = fixture({ sessions, sessionId: 's-first', archiveOk: false });
  await failed.context.archiveSession(sessions[0]);
  assert.deepEqual(failed.state.opened, []);
  assert.deepEqual(failed.state.created, []);
  assert.deepEqual(failed.state.status, ['Archive failed']);

  const blocked = fixture({ sessions, sessionId: 's-first', canChange: false });
  await blocked.context.archiveSession(sessions[0]);
  assert.deepEqual(blocked.state.archived, []);
  assert.deepEqual(blocked.state.status, []);
});
