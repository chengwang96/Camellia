'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./claude-harness.cjs');
const { translate } = require('../src/shared/i18n');

function setup(t) {
  const h = createHarness();
  h.configureApi();
  h.api.sharedConversations.prepare = async () => {};
  h.api.sharedConversations.generateTitle = async message => message;
  t.after(() => h.cleanup());
  return h;
}

const command = (h, payload) => h.call('conversation-command', { engine: 'claude', action: 'meta-op', payload });

test('a renamed legacy workspace preserves identity and resumes existing conversations from the new folder', async t => {
  const h = setup(t);
  const ws = h.call('claude-meta-op', { op: 'create-workspace', name: 'Display name', path: h.folder('Project') }).workspace;
  const sent = h.call('claude-send', { workspaceId: ws.id, prompt: 'Remember this conversation' });
  assert.equal(sent.ok, true, sent.error);
  const id = h.finishTurn();
  const nativeFile = h.seedSession('archived-project', ws.path, 'Keep archived history');
  const nativeContent = fs.readFileSync(nativeFile, 'utf8');
  h.call('claude-meta-op', { op: 'assign-session', sessionId: 'archived-project', workspaceId: ws.id });
  h.call('claude-meta-op', { op: 'toggle-pin', sessionId: id });
  h.call('claude-archive-session', { id: 'archived-project' });
  h.call('claude-meta-op', { op: 'toggle-collapse', workspaceId: ws.id });
  const next = path.join(h.root, 'Project renamed');
  fs.renameSync(ws.path, next);
  assert.equal((await h.call('claude-list-sessions')).workspaces[0].missing, true);
  const result = h.call('claude-meta-op', { op: 'relocate-workspace', id: ws.id, path: next });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.workspace.id, ws.id);
  assert.equal(result.workspace.name, ws.name);
  assert.equal(result.workspace.createdAt, ws.createdAt);
  assert.equal(result.meta.sessionWorkspace[id], ws.id);
  assert.equal(result.meta.sessionCwd[id], fs.realpathSync(next));
  assert.equal(result.meta.sessionCwd['archived-project'], fs.realpathSync(next));
  assert.ok(result.meta.archived['archived-project']);
  assert.ok(result.meta.pinned[id]);
  assert.ok(result.meta.collapsed[ws.id]);
  assert.equal(fs.readFileSync(nativeFile, 'utf8'), nativeContent);
  assert.equal((await h.call('claude-list-sessions')).workspaces[0].missing, false);
  assert.equal(h.call('claude-send', { sessionId: id, prompt: 'Continue after rename' }).ok, true);
  assert.equal(h.processes.at(-1).cwd, fs.realpathSync(next));
  assert.ok(h.processes.at(-1).args.includes('--resume'));
  assert.equal(h.finishTurn(), id);
  const restarted = createHarness(h.root);
  assert.equal(restarted.api.claudeSessionMeta().sessionCwd[id], fs.realpathSync(next));
  assert.equal(fs.existsSync(ws.path), false);
});

test('shared relocation updates root and nested directories across engines and groups while preserving history and native bindings', async t => {
  const h = setup(t), shared = h.api.sharedConversations;
  const ws = (await command(h, { op: 'create-workspace', name: 'Research', path: h.folder('Project') })).workspace;
  const sibling = h.folder('Project-other');
  const nested = h.folder(path.join('Project', 'nested'));
  const conversations = ['claude', 'codex', 'kimi', 'dsh', 'antigravity', 'pi'].map(engine => {
    const c = shared.create(engine, ws.id, engine + ' conversation');
    shared.append(c, { role: 'user', engine, text: 'Keep the original history' });
    c.segments[engine] = { nativeId: engine + '-native', cursor: 1 };
    c.modelSessions = { parked: { engine, nativeId: engine + '-parked', cursor: 0 } };
    shared.save(c);
    return c;
  });
  const sub = shared.create('codex', ws.id, 'Nested', nested);
  const movedOut = shared.create('kimi', null, 'Grouped elsewhere', ws.path);
  const external = shared.create('claude', ws.id, 'Other actual directory', sibling);
  const independent = shared.create('claude', null, 'Standalone unrelated');
  const history = new Map(conversations.map(c => [c.id, fs.readFileSync(path.join(shared.dir, c.id + '.jsonl'), 'utf8')]));
  await command(h, { op: 'toggle-pin', sessionId: conversations[0].id });
  await h.call('conversation-command', { engine: 'codex', action: 'archive-session', payload: { id: conversations[1].id } });
  const next = path.join(h.root, 'Renamed 研究');
  fs.renameSync(ws.path, next);
  const result = await command(h, { op: 'relocate-workspace', id: ws.id, path: next });
  assert.equal(result.ok, true, result.error);
  for (const c of conversations) {
    assert.equal(c.cwd, fs.realpathSync(next));
    assert.equal(c.workspaceId, ws.id);
    assert.equal(c.segments[c.origin].nativeId, c.origin + '-native');
    assert.equal(c.modelSessions.parked.nativeId, c.origin + '-parked');
    assert.equal(fs.readFileSync(path.join(shared.dir, c.id + '.jsonl'), 'utf8'), history.get(c.id));
    assert.equal(JSON.parse(fs.readFileSync(shared.file(c.id), 'utf8')).cwd, fs.realpathSync(next));
  }
  assert.equal(sub.cwd, path.join(fs.realpathSync(next), 'nested'));
  assert.equal(movedOut.cwd, fs.realpathSync(next));
  assert.equal(movedOut.workspaceId, null);
  assert.equal(external.cwd, sibling);
  assert.equal(independent.cwd, path.join(shared.dir, 'workspace'));
  assert.ok(result.meta.pinned[conversations[0].id]);
  assert.ok(result.meta.archived[conversations[1].id]);
  const restarted = createHarness(h.root);
  const loaded = await restarted.call('conversation-command', { engine: 'claude', action: 'load-session', payload: conversations[0].id });
  assert.equal(loaded.cwd, fs.realpathSync(next));
  assert.equal(loaded.messages[0].text, 'Keep the original history');
  assert.equal(fs.existsSync(ws.path), false);
});

test('relocation recognizes a missing nested folder through a symlinked ancestor', async t => {
  const h = setup(t), shared = h.api.sharedConversations;
  const parent = h.folder('actual-parent'), alias = path.join(h.root, 'alias-parent');
  fs.symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const original = path.join(parent, 'Project');
  fs.mkdirSync(path.join(original, 'nested'), { recursive: true });
  const ws = (await command(h, { op: 'create-workspace', name: 'Research', path: original })).workspace;
  const nested = shared.create('codex', ws.id, 'Nested alias', path.join(alias, 'Project', 'nested'));
  const sibling = shared.create('claude', null, 'Sibling', h.folder('actual-parent/Project-other'));
  const next = path.join(parent, 'Renamed');
  fs.renameSync(original, next);
  const result = await command(h, { op: 'relocate-workspace', id: ws.id, path: next });
  assert.equal(result.ok, true, result.error);
  assert.equal(nested.cwd, path.join(fs.realpathSync(next), 'nested'));
  assert.equal(sibling.cwd, path.join(parent, 'Project-other'));
  assert.equal(fs.existsSync(original), false);
});

test('relocation rejects invalid folders and duplicate workspaces without changing saved state', async t => {
  const h = setup(t), shared = h.api.sharedConversations;
  const ws = (await command(h, { op: 'create-workspace', name: 'Project', path: h.folder('Project') })).workspace;
  const other = (await command(h, { op: 'create-workspace', name: 'Other', path: h.folder('Other') })).workspace;
  const c = shared.create('claude', ws.id);
  const file = path.join(h.root, 'file.txt'); fs.writeFileSync(file, 'Not a folder');
  const before = JSON.stringify(shared.workspaces.sessionMeta());
  const saved = fs.readFileSync(shared.file(c.id), 'utf8');
  for (const payload of [
    { id: 'missing', path: other.path }, { id: ws.id, path: '' },
    { id: ws.id, path: 'relative' }, { id: ws.id, path: path.join(file, 'child') },
    { id: ws.id, path: file }, { id: ws.id, path: path.join(h.root, 'missing') },
    { id: ws.id, path: other.path + path.sep },
  ]) {
    const result = await command(h, { op: 'relocate-workspace', ...payload });
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(JSON.stringify(shared.workspaces.sessionMeta()), before);
    assert.equal(fs.readFileSync(shared.file(c.id), 'utf8'), saved);
  }
  assert.equal((await command(h, { op: 'relocate-workspace', id: ws.id, path: ws.path })).ok, true);
  assert.equal(shared.workspaces.sessionMeta().workspaces.length, 2);
});

for (const group of ['workspace', 'standalone']) test('relocation refuses a busy ' + group + ' conversation using the old directory', async t => {
  const h = setup(t), shared = h.api.sharedConversations;
  const ws = (await command(h, { op: 'create-workspace', name: 'Project', path: h.folder('Project') })).workspace;
  const c = shared.create('claude', group === 'workspace' ? ws.id : null, 'Busy', ws.path);
  shared.active.set(c.id, { facade: { gen: 1 }, permissions: new Map() });
  const before = JSON.stringify(shared.workspaces.sessionMeta());
  try {
    const result = await command(h, { op: 'relocate-workspace', id: ws.id, path: h.folder('Replacement') });
    assert.equal(result.ok, false);
    assert.match(result.error, /Stop conversations/);
    assert.equal(JSON.stringify(shared.workspaces.sessionMeta()), before);
    assert.equal(c.cwd, ws.path);
  } finally { shared.active.delete(c.id); }
});

test('a missing shared workspace is never recreated by a new send, and existing sends resume after relocation', async t => {
  const h = setup(t), shared = h.api.sharedConversations;
  const ws = (await command(h, { op: 'create-workspace', name: 'Project', path: h.folder('Project') })).workspace;
  const c = shared.create('claude', ws.id);
  const first = await h.call('conversation-command', { engine: 'claude', action: 'send', payload: { sessionId: c.id, prompt: 'Remember the first turn' } });
  assert.equal(first.ok, true, first.error);
  h.finishTurn();
  const nativeId = c.segments.claude.nativeId;
  const next = path.join(h.root, 'Renamed'); fs.renameSync(ws.path, next);
  const before = shared.items.size;
  for (const payload of [{ workspaceId: ws.id, prompt: 'New' }, { sessionId: c.id, prompt: 'Continue' }]) {
    const result = await h.call('conversation-command', { engine: 'claude', action: 'send', payload });
    assert.equal(result.ok, false);
    assert.match(result.error, /[Rr]elocate/);
    assert.equal(shared.items.size, before);
    assert.equal(fs.existsSync(ws.path), false);
  }
  assert.equal((await command(h, { op: 'relocate-workspace', id: ws.id, path: next })).ok, true);
  const result = await h.call('conversation-command', { engine: 'claude', action: 'send', payload: { sessionId: c.id, prompt: 'Continue after moving' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sessionId, c.id);
  assert.equal(h.processes.at(-1).cwd, fs.realpathSync(next));
  assert.ok(h.processes.at(-1).args.includes('--resume'));
  assert.equal(h.finishTurn(), nativeId);
});

test('restart recovers a conversation whose path file was not saved after workspace metadata', async t => {
  const h = setup(t), shared = h.api.sharedConversations;
  const ws = (await command(h, { op: 'create-workspace', name: 'Project', path: h.folder('Project') })).workspace;
  const c = shared.create('claude', ws.id);
  const next = path.join(h.root, 'Renamed'); fs.renameSync(ws.path, next);
  // Simulate stopping after the authoritative config write, before c.json.
  assert.equal(shared.workspaces.metaOp({ op: 'relocate-workspace', id: ws.id, path: next }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(shared.file(c.id), 'utf8')).cwd, ws.path);
  const restarted = createHarness(h.root);
  assert.equal(restarted.api.sharedConversations.get(c.id).cwd, fs.realpathSync(next));
  assert.equal(JSON.parse(fs.readFileSync(shared.file(c.id), 'utf8')).cwd, fs.realpathSync(next));
});

test('relocation labels and validation errors are translated for Chinese workspaces', () => {
  for (const source of ['Folder not found', 'Relocate folder…', 'Relocate workspace folder',
    'Workspace folder relocated', 'Folder does not exist. Choose another folder.', 'This folder is already a workspace'])
    assert.notEqual(translate(source, 'zh-CN'), source);
  assert.equal(translate('Working directory not found. Relocate the folder from the workspace menu: D:\\研究', 'zh-CN'),
    '找不到工作目录，请在工作区菜单中重新定位目录：D:\\研究');
});
