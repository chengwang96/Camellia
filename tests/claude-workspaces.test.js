'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');

function setup(t) { const h = createHarness(); h.configureApi(); t.after(() => h.cleanup()); return h; }
function workspace(h, name) {
  const res = h.call('claude-meta-op', { op: 'create-workspace', name, path: h.folder(name) });
  assert.equal(res.ok, true);
  return res.workspace;
}
function send(h, payload) {
  const res = h.call('claude-send', { prompt: 'Workspace test', ...payload });
  assert.equal(res.ok, true, res.error);
  return h.finishTurn();
}

test('empty history still exposes saved workspaces with a stable IPC shape', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  const res = (await h.call('claude-list-sessions'));
  assert.equal(res.ok, true);
  assert.equal(res.sessions.length, 0);
  assert.equal(res.workspaces[0].id, ws.id);
  assert.equal(res.workspaces[0].sessionCount, 0);
});

test('validates folders, duplicates and assignment targets without changing metadata', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  for (const payload of [
    { op: 'create-workspace', name: '', path: ws.path },
    { op: 'create-workspace', name: 'Missing', path: path.join(h.root, 'missing') },
    { op: 'create-workspace', name: 'Relative', path: 'relative' },
    { op: 'create-workspace', name: 'Duplicate', path: ws.path + path.sep },
    { op: 'assign-session', sessionId: 'abc', workspaceId: 'missing' },
    { op: 'assign-session', sessionId: '__proto__', workspaceId: ws.id },
    { op: 'rename-workspace', id: 'missing', name: 'Missing' },
  ]) assert.equal(h.call('claude-meta-op', payload).ok, false);
  assert.equal(h.api.claudeSessionMeta().workspaces.length, 1);
  assert.equal(Object.keys(h.api.claudeSessionMeta().sessionWorkspace).length, 0);
});

test('new workspace and independent sessions use separate directories and survive restart', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  const grouped = send(h, { workspaceId: ws.id });
  assert.equal(h.processes.at(-1).cwd, ws.path);
  const free = send(h, { workspaceId: null });
  assert.equal(h.processes.at(-1).cwd, path.join(h.userData, 'claude-sessions'));
  assert.equal(h.call('claude-get-settings').cwd, undefined);
  h.call('claude-meta-op', { op: 'toggle-collapse', workspaceId: ws.id });
  const restarted = createHarness(h.root);
  assert.equal(restarted.api.claudeSessionMeta().sessionWorkspace[grouped], ws.id);
  assert.equal(restarted.api.claudeSessionMeta().sessionWorkspace[free], null);
  assert.equal((await restarted.call('claude-list-sessions')).workspaces[0].collapsed, true);
});

test('legacy sessions stay independent and retain cwd until explicitly moved', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  const legacyDir = h.folder('Legacy');
  h.seedSession('legacy', legacyDir);
  const loaded = await h.call('claude-load-session', 'legacy');
  assert.equal(loaded.workspaceId, null);
  assert.equal(loaded.cwd, legacyDir);
  h.call('claude-meta-op', { op: 'assign-session', sessionId: 'legacy', workspaceId: ws.id });
  send(h, { sessionId: 'legacy' });
  assert.equal(h.processes.at(-1).cwd, ws.path);
  h.call('claude-meta-op', { op: 'assign-session', sessionId: 'legacy', workspaceId: null });
  send(h, { sessionId: 'legacy' });
  assert.equal(h.processes.at(-1).cwd, path.join(h.userData, 'claude-sessions'));
  assert.equal(h.api.claudeSessionMeta().sessionWorkspace.legacy, null);
});

test('moving between workspaces resumes the same conversation using the destination cwd', async (t) => {
  const h = setup(t);
  const a = workspace(h, 'Project A'), b = workspace(h, 'Project B');
  const id = send(h, { workspaceId: a.id });
  const originalTranscript = h.api.getSession().sessionId;
  h.call('claude-meta-op', { op: 'assign-session', sessionId: id, workspaceId: b.id });
  assert.equal(send(h, { sessionId: id, workspaceId: a.id }), id);
  assert.equal(h.processes.at(-1).cwd, b.path);
  const resumeArg = h.processes.at(-1).args[h.processes.at(-1).args.indexOf('--resume') + 1];
  assert.equal(path.isAbsolute(resumeArg), true);
  assert.equal(path.basename(resumeArg, '.jsonl'), originalTranscript);
  assert.equal((await h.call('claude-list-sessions')).sessions.filter((s) => s.id === id).length, 1);
});

test('removing a workspace preserves transcripts, files and pinned conversations', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  const file = h.seedSession('keep-me', ws.path);
  const original = fs.readFileSync(file, 'utf8');
  h.call('claude-meta-op', { op: 'assign-session', sessionId: 'keep-me', workspaceId: ws.id });
  h.call('claude-meta-op', { op: 'toggle-pin', sessionId: 'keep-me' });
  h.call('claude-meta-op', { op: 'delete-workspace', id: ws.id });
  const res = (await h.call('claude-list-sessions'));
  assert.equal(res.workspaces.length, 0);
  assert.equal(res.sessions[0].workspaceId, null);
  assert.equal(res.sessions[0].pinned, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(ws.path), true);
  assert.equal((await h.call('claude-load-session', 'keep-me')).cwd, path.join(h.userData, 'claude-sessions'));
});

test('older workspace and pinned sessions are retained beyond the recent-history limit', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  for (let i = 0; i < 65; i++) h.seedSession('recent-' + i, ws.path, 'Recent ' + i, Date.now() - i * 1000);
  h.seedSession('old-grouped', ws.path, 'Old grouped', 100000);
  h.seedSession('old-pinned', ws.path, 'Old pinned', 100000);
  h.call('claude-meta-op', { op: 'assign-session', sessionId: 'old-grouped', workspaceId: ws.id });
  h.call('claude-meta-op', { op: 'toggle-pin', sessionId: 'old-pinned' });
  const res = (await h.call('claude-list-sessions'));
  assert.equal(res.sessions.length, 62);
  assert.equal(res.workspaces[0].sessionCount, 1);
  assert.equal(res.sessions.some((s) => s.id === 'old-grouped'), true);
  assert.equal(res.sessions.some((s) => s.id === 'old-pinned'), true);
  h.call('claude-meta-op', { op: 'assign-session', sessionId: 'old-grouped', workspaceId: null });
  assert.equal((await h.call('claude-list-sessions', { limits: { recent: 120 } })).sessions.some((s) => s.id === 'old-grouped' && s.workspaceId === null), true);
});

test('forking an active conversation starts a new process and inherits its workspace', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  const original = send(h, { workspaceId: ws.id });
  const fork = send(h, { sessionId: original, fork: true });
  assert.notEqual(fork, original);
  assert.equal(h.processes.length, 2);
  assert.equal(h.api.claudeSessionMeta().sessionWorkspace[original], ws.id);
  assert.equal(h.api.claudeSessionMeta().sessionWorkspace[fork], ws.id);
});

test('missing workspaces fail explicitly and busy conversations cannot be reassigned', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  const id = send(h, { workspaceId: ws.id });
  h.call('claude-send', { sessionId: id, prompt: 'Still running' });
  assert.equal(h.call('claude-meta-op', { op: 'assign-session', sessionId: id, workspaceId: null }).ok, false);
  assert.equal(h.call('claude-meta-op', { op: 'delete-workspace', id: ws.id }).ok, false);
  h.finishTurn();
  fs.rmdirSync(ws.path);
  const res = h.call('claude-send', { sessionId: id, prompt: 'Missing folder' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Working directory does not exist/);
  assert.equal(h.api.claudeSessionMeta().sessionWorkspace[id], ws.id);
});

test('goal execution follows the explicitly selected workspace and conversation', async (t) => {
  const h = setup(t);
  const a = workspace(h, 'Project A'), b = workspace(h, 'Project B');
  send(h, { workspaceId: a.id });
  const res = h.call('claude-goal-start', { objective: 'New goal in B', sessionId: null, workspaceId: b.id });
  assert.equal(res.ok, true);
  assert.equal(res.goal.sessionId, null);
  h.api.claudeGoalDrive();
  assert.equal(h.processes.at(-1).cwd, b.path);
  assert.equal(h.processes.at(-1).args.includes('--resume'), false);
});

test('late events from a replaced CLI cannot affect the new conversation', async (t) => {
  const h = setup(t);
  const a = workspace(h, 'Project A'), b = workspace(h, 'Project B');
  send(h, { workspaceId: a.id });
  const oldSession = h.api.getSession();
  const newId = send(h, { workspaceId: b.id });
  h.events.length = 0;
  oldSession.sendChannel({ type: 'result', is_error: true });
  oldSession.emitLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: newId }));
  assert.equal(h.events.length, 0);
  assert.equal(h.api.claudeSessionMeta().sessionWorkspace[newId], b.id);
});

test('removing a paused goal workspace also detaches its pending conversation', async (t) => {
  const h = setup(t);
  const ws = workspace(h, 'Project A');
  h.call('claude-goal-start', { objective: 'Pending goal', sessionId: null, workspaceId: ws.id });
  h.call('claude-goal-pause');
  h.call('claude-meta-op', { op: 'delete-workspace', id: ws.id });
  assert.equal(h.call('claude-goal-get').goal.workspaceId, null);
  h.call('claude-goal-resume');
  h.api.claudeGoalDrive();
  assert.equal(h.processes.at(-1).cwd, path.join(h.userData, 'claude-sessions'));
});

test('a manual result cannot complete or adopt a pending goal conversation', async t => {
  const h = setup(t);
  h.call('claude-goal-start', { objective: 'Pending goal', maxRounds: 5 });
  h.call('claude-send', { prompt: 'A separate manual turn' });
  h.api.getSession().emitLine(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'manual', result: '<goal:complete>' }));
  const goal = h.call('claude-goal-get').goal;
  assert.equal(goal.phase, 'active');
  assert.equal(goal.sessionId, null);
  assert.equal(goal.roundsStarted, 0);
});

test('an unavailable goal workspace does not consume a round before a process starts', async t => {
  const h = setup(t), ws = workspace(h, 'Removed folder');
  h.call('claude-goal-start', { objective: 'Goal', workspaceId: ws.id });
  fs.rmdirSync(ws.path);
  h.api.claudeGoalDrive();
  const goal = h.call('claude-goal-get').goal;
  assert.equal(goal.phase, 'blocked');
  assert.equal(goal.roundsStarted, 0);
  assert.equal(h.processes.length, 0);
});
