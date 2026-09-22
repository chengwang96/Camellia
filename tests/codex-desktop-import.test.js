'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SharedConversations } = require('../src/engines/shared-conversations');
const { listDesktopSessions, readRolloutMessages, importDesktopSessions, syncDesktopSession, desktopStatePath } = require('../src/main/codex-desktop-import');

function stateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-import-test-'));
  let db;
  t.after(() => { try { db?.close(); } catch {} fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const file = path.join(root, 'state_5.sqlite');
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    created_at_ms INTEGER, updated_at_ms INTEGER)`);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '')`);
  return { root, file, get db() { return db; }, close: () => db.close() };
}

function addThread(db, { id, title = '', name = '', first = '', cwd = 'D:/work', source = 'vscode', archived = 0, projectId = null, rollout = '' }) {
  db.prepare(`INSERT INTO threads (id, rollout_path, title, name, first_user_message, cwd, source, archived, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rollout, title, name, first, cwd, source, archived, projectId, 1789000000, 1789000000);
}

function addProject(db, { id, name = '', roots = [] }) {
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
  for (const [position, rootPath] of roots.entries()) {
    db.prepare('INSERT INTO project_roots (project_id, position, path) VALUES (?, ?, ?)').run(id, position, rootPath);
  }
}

function writeRollout(root, name, rows) {
  const file = path.join(root, name);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function sharedFixture(root) {
  const dir = path.join(root, 'conversations');
  let config = {};
  return new SharedConversations({ dir, loadConfig: () => config, saveConfig: p => { config = { ...config, ...p }; },
    drivers: { codex: { settings: () => ({ connection: 'api', model: 'fixture' }) } } });
}

const responseItem = (role, text, at = '2026-09-16T10:00:00.000Z') =>
  ({ timestamp: at, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('desktop session listing skips subagents, archived rows, unnamed rows and missing rollouts', t => {
  const { root, file, db, close } = stateFixture(t);
  const rollout = writeRollout(root, 'a.jsonl', [responseItem('user', 'hello')]);
  addThread(db, { id: 'main', name: 'Main chat', rollout });
  addThread(db, { id: 'sub', name: 'Subagent', source: '{"subagent":{"other":"x"}}', rollout });
  addThread(db, { id: 'archived', name: 'Archived', archived: 1, rollout });
  addThread(db, { id: 'unnamed', title: 'Generated title', first: 'First message', rollout });
  addThread(db, { id: 'gone', name: 'No file left', rollout: path.join(root, 'missing.jsonl') });
  close();
  const sessions = listDesktopSessions(file);
  assert.deepEqual(sessions.map(s => s.id), ['main', 'gone']);
  assert.equal(sessions[0].title, 'Main chat');
  assert.equal(sessions[1].importable, false);
  assert.equal(sessions[1].title, 'No file left');
  assert.deepEqual(listDesktopSessions(file, { excludeIds: new Set(['main']) }).map(s => s.id), ['gone']);
});

test('only the user-visible name is used, and cwd falls back to a matching project root', t => {
  const { root, file, db, close } = stateFixture(t);
  const rollout = writeRollout(root, 'n.jsonl', [responseItem('user', 'hello')]);
  const projectDir = path.join(root, 'proj'); fs.mkdirSync(projectDir);
  addProject(db, { id: 'p1', name: 'ARDS', roots: [projectDir, path.join(root, 'secondary')] });
  addThread(db, { id: 'named', title: 'Raw title wrapper', name: '## My request:\n real working session', cwd: projectDir, rollout });
  addThread(db, { id: 'plain', name: 'No project here', rollout });
  close();
  const sessions = listDesktopSessions(file);
  const named = sessions.find(s => s.id === 'named');
  assert.equal(named.title, 'real working session');
  assert.deepEqual(named.project, { id: 'p1', name: 'ARDS', path: projectDir });
  assert.equal(sessions.find(s => s.id === 'plain').project, null);
});

test('desktop session listing is capped and reports truncation', t => {
  const { root, file, db, close } = stateFixture(t);
  const rollout = writeRollout(root, 'limit.jsonl', [responseItem('user', 'hello')]);
  for (let index = 0; index < 3; index++) addThread(db, { id: 'limit-' + index, name: 'Session ' + index, rollout });
  close();
  const sessions = listDesktopSessions(file, { maxSessions: 2 });
  assert.equal(sessions.length, 2);
  assert.equal(sessions.truncated, true);
});

test('desktop assignments recover pending project migrations and reuse the database workspace', async t => {
  const { root, file, db, close } = stateFixture(t);
  const projectDir = path.join(root, 'project'); fs.mkdirSync(projectDir);
  const outputDir = path.join(root, 'output'); fs.mkdirSync(outputDir);
  const rollout = writeRollout(root, 'assigned.jsonl', [responseItem('user', 'hello')]);
  addProject(db, { id: 'migrated', name: 'Workspace', roots: [projectDir] });
  addThread(db, { id: 'assigned', name: 'Moved into workspace', cwd: outputDir, rollout });
  addThread(db, { id: 'sibling', name: 'Workspace sibling', cwd: projectDir, rollout });
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { legacy: { name: 'Old name', rootPaths: [projectDir] } },
    'thread-project-assignments': { assigned: { projectId: 'legacy', projectKind: 'local' } },
  }));
  close();
  const sessions = listDesktopSessions(file);
  assert.deepEqual(sessions.map(session => session.project), [
    { id: 'migrated', name: 'Workspace', path: projectDir },
    { id: 'migrated', name: 'Workspace', path: projectDir },
  ]);
  const shared = sharedFixture(root);
  const result = await importDesktopSessions(shared, file, ['assigned', 'sibling']);
  assert.equal(result.imported.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(shared.workspaces.sessionMeta().workspaces.length, 1);
  const records = result.imported.map(item => shared.get(item.id));
  assert.ok(records[0].workspaceId);
  assert.equal(records[0].workspaceId, records[1].workspaceId);
});

test('legacy roots and secondary roots are recognized without grouping explicitly projectless or remote threads', t => {
  const { root, file, db, close } = stateFixture(t);
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const legacy = path.join(root, 'legacy');
  const rollout = writeRollout(root, 'roots.jsonl', [responseItem('user', 'hello')]);
  addProject(db, { id: 'database', name: 'Database', roots: [primary, secondary] });
  for (const [id, cwd] of [['secondary', secondary], ['legacy', legacy], ['loose', primary], ['remote', primary]]) {
    addThread(db, { id, name: id, cwd, rollout });
  }
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { legacy: { name: 'Legacy workspace', rootPaths: [legacy] } },
    'projectless-thread-ids': ['loose'],
    'thread-project-assignments': { remote: { projectId: 'remote', projectKind: 'remote' } },
  }));
  close();
  const sessions = new Map(listDesktopSessions(file).map(session => [session.id, session]));
  assert.deepEqual(sessions.get('secondary').project, { id: 'database', name: 'Database', path: primary });
  assert.deepEqual(sessions.get('legacy').project, { id: 'legacy', name: 'Legacy workspace', path: legacy });
  assert.equal(sessions.get('loose').project, null);
  assert.equal(sessions.get('remote').project, null);
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), '{invalid');
  assert.equal(listDesktopSessions(file).find(session => session.id === 'secondary').project.id, 'database');
});

test('rollout parsing keeps user and assistant text, unwraps the desktop request wrapper, skips environment blocks', async t => {
  const { root } = stateFixture(t);
  const rollout = writeRollout(root, 'b.jsonl', [
    { type: 'session_meta', payload: { id: 'x' } },
    responseItem('user', '# Files mentioned by the user:\n\n## a.png: C:/a.png\n\n## My request:\n do the thing ', '2026-09-16T10:00:01.000Z'),
    { timestamp: '2026-09-16T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignored</environment_context>' }] } },
    responseItem('assistant', 'working on it', '2026-09-16T10:00:03.000Z'),
    responseItem('assistant', 'working on it', '2026-09-16T10:00:03.100Z'),
    { timestamp: '2026-09-16T10:00:04.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', text: 'duplicate copy' } } },
  ]);
  const messages = await readRolloutMessages(rollout);
  assert.deepEqual(messages.map(m => m.role + ':' + m.text), ['user:do the thing', 'assistant:working on it']);
  assert.equal(messages[0].at, Date.parse('2026-09-16T10:00:01.000Z'));
});

test('import creates shared conversations with codex history and skips re-imports', async t => {
  const { root, file, db, close } = stateFixture(t);
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const rollout = writeRollout(root, 'c.jsonl', [responseItem('user', 'first question'), responseItem('assistant', 'first answer')]);
  addThread(db, { id: 'thread-1', name: 'Imported chat', cwd, rollout });
  close();
  const shared = sharedFixture(root);
  const result = await importDesktopSessions(shared, file, ['thread-1']);
  assert.equal(result.imported.length, 1);
  const c = result.imported[0];
  const record = shared.get(c.id);
  assert.equal(record.origin, 'codex');
  assert.equal(record.currentEngine, 'codex');
  assert.equal(record.importedFrom, 'codex-desktop');
  assert.equal(record.importThreadId, 'thread-1');
  assert.equal(record.cwd, cwd);
  assert.deepEqual(shared.messages(record).map(m => m.role + ':' + m.text), ['user:first question', 'assistant:first answer']);
  assert.equal(listDesktopSessions(file, { excludeIds: new Set(['thread-1']) }).length, 0);
});

test('importing a project thread creates one workspace reused by sibling threads', async t => {
  const { root, file, db, close } = stateFixture(t);
  const projectDir = path.join(root, 'ards-work'); fs.mkdirSync(projectDir);
  addProject(db, { id: 'p1', name: 'ARDS', roots: [projectDir] });
  const r1 = writeRollout(root, 'p1.jsonl', [responseItem('user', 'q1')]);
  const r2 = writeRollout(root, 'p2.jsonl', [responseItem('user', 'q2')]);
  addThread(db, { id: 'pt-1', name: 'session one', projectId: 'p1', rollout: r1 });
  addThread(db, { id: 'pt-2', name: 'session two', projectId: 'p1', rollout: r2 });
  close();
  const shared = sharedFixture(root);
  const result = await importDesktopSessions(shared, file, ['pt-1', 'pt-2']);
  assert.equal(result.imported.length, 2);
  const first = shared.get(result.imported[0].id);
  const second = shared.get(result.imported[1].id);
  assert.ok(first.workspaceId);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(first.cwd, fs.realpathSync(projectDir));
  const workspaces = shared.workspaces.sessionMeta().workspaces;
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].name, 'ARDS');
  assert.equal(workspaces[0].path, fs.realpathSync(projectDir));
});

test('workspace lookup matches by real path so symlinked project roots still reuse', async t => {
  const { root, file, db, close } = stateFixture(t);
  const real = path.join(root, 'real-proj'); fs.mkdirSync(real);
  const link = path.join(root, 'link-proj');
  try { fs.symlinkSync(real, link, 'dir'); } catch { t.skip('symlink creation unavailable'); return; }
  addProject(db, { id: 'p1', name: 'Linked', roots: [link] });
  const r1 = writeRollout(root, 'l1.jsonl', [responseItem('user', 'q1')]);
  const r2 = writeRollout(root, 'l2.jsonl', [responseItem('user', 'q2')]);
  addThread(db, { id: 'lt-1', name: 'one', projectId: 'p1', rollout: r1 });
  addThread(db, { id: 'lt-2', name: 'two', projectId: 'p1', rollout: r2 });
  close();
  const shared = sharedFixture(root);
  const result = await importDesktopSessions(shared, file, ['lt-1', 'lt-2']);
  assert.equal(result.imported.length, 2);
  assert.equal(result.skipped.length, 0);
  const first = shared.get(result.imported[0].id);
  const second = shared.get(result.imported[1].id);
  assert.ok(first.workspaceId);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(shared.workspaces.sessionMeta().workspaces.length, 1);
});

test('manual sync overwrites the Camellia copy, retires segments and updates the title', async t => {
  const { root, file, db, close } = stateFixture(t);
  const rollout = writeRollout(root, 's.jsonl', [responseItem('user', 'old question'), responseItem('assistant', 'old answer')]);
  addThread(db, { id: 'sync-1', name: 'before rename', rollout });
  const shared = sharedFixture(root);
  const result = await importDesktopSessions(shared, file, ['sync-1']);
  const record = shared.get(result.imported[0].id);
  shared.append(record, { role: 'user', engine: 'codex', text: 'local only turn', displayText: 'local only turn', attachments: [] });
  record.segments = { codex: { native: 'abc' } };
  shared.save(record);
  writeRollout(root, 's.jsonl', [responseItem('user', 'old question'), responseItem('assistant', 'old answer'), responseItem('user', 'new question'), responseItem('assistant', 'new answer')]);
  db.prepare('UPDATE threads SET name = ? WHERE id = ?').run('after rename', 'sync-1');
  close();
  const synced = await syncDesktopSession(shared, file, record.id);
  assert.equal(synced.messages, 4);
  assert.equal(synced.title, 'after rename');
  const after = shared.get(record.id);
  assert.deepEqual(shared.messages(after).map(m => m.role + ':' + m.text),
    ['user:old question', 'assistant:old answer', 'user:new question', 'assistant:new answer']);
  assert.deepEqual(after.segments, {});
  assert.equal(after.retiredSegments.length, 1);
  assert.ok(fs.existsSync(path.join(root, 'conversations', record.id + '.jsonl.pre-sync')));
});

test('sync rejects conversations that were not imported from the desktop app', async t => {
  const { root, file, db, close } = stateFixture(t);
  close();
  const shared = sharedFixture(root);
  const c = shared.create('codex', null, 'local chat');
  await assert.rejects(() => syncDesktopSession(shared, file, c.id), /not imported/);
});

test('desktopStatePath points inside the user home .codex directory', () => {
  assert.equal(desktopStatePath('/home/u'), path.join('/home/u', '.codex', 'state_5.sqlite'));
});

test('large tool-heavy histories stream into conversations even above the old batch limit', async t => {
  const { root, file, db, close } = stateFixture(t);
  const rollout = writeRollout(root, 'large.jsonl', [responseItem('user', 'Large history question')]);
  const toolLine = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(1024 * 1024) } }) + '\n';
  for (let index = 0; index < 65; index++) fs.appendFileSync(rollout, toolLine);
  fs.appendFileSync(rollout, JSON.stringify(responseItem('assistant', 'Large history answer')) + '\n');
  const ids = Array.from({ length: 8 }, (_, index) => 'large-' + index);
  for (const id of ids) addThread(db, { id, name: id, rollout });
  close();
  const before = fs.statSync(rollout);
  const sessions = listDesktopSessions(file);
  assert.ok(sessions.every(session => session.importable && session.rolloutBytes > 64 * 1024 * 1024));
  assert.ok(sessions.reduce((total, session) => total + session.rolloutBytes, 0) > 512 * 1024 * 1024);
  const shared = sharedFixture(root);
  const result = await importDesktopSessions(shared, file, ids);
  assert.equal(result.imported.length, ids.length);
  assert.deepEqual(result.skipped, []);
  for (const item of result.imported) {
    assert.deepEqual(shared.messages(shared.get(item.id)).map(message => message.text), ['Large history question', 'Large history answer']);
  }
  const synced = await syncDesktopSession(shared, file, result.imported[0].id);
  assert.equal(synced.messages, 2);
  assert.equal(fs.statSync(rollout).size, before.size);
  assert.equal(fs.statSync(rollout).mtimeMs, before.mtimeMs);
});

test('extracted-text safety limits apply after filtering and use UTF-8 bytes', async t => {
  const { root } = stateFixture(t);
  const rollout = writeRollout(root, 'limits.jsonl', [
    { type: 'response_item', payload: { type: 'function_call_output', output: 'ignored'.repeat(100) } },
    responseItem('user', '你好'), responseItem('assistant', '好'),
  ]);
  assert.equal((await readRolloutMessages(rollout, null, { maxMessageBytes: 9, maxMessageCount: 2 })).length, 2);
  await assert.rejects(readRolloutMessages(rollout, null, { maxMessageBytes: 8 }), /Extracted conversation exceeds/);
  await assert.rejects(readRolloutMessages(rollout, null, { maxMessageCount: 1 }), /Extracted conversation exceeds/);
  await assert.rejects(readRolloutMessages(rollout, () => { throw new Error('write failed'); }), /write failed/);
  assert.equal((await readRolloutMessages(rollout)).length, 2);
});

test('unreadable history rejects cleanly and a failed import leaves no partial conversation', async t => {
  const { root, file, db, close } = stateFixture(t);
  const missing = path.join(root, 'missing.jsonl');
  addThread(db, { id: 'missing', name: 'Missing', rollout: missing });
  addThread(db, { id: 'directory', name: 'Directory', rollout: root });
  close();
  assert.ok(listDesktopSessions(file).every(session => !session.importable));
  await assert.rejects(readRolloutMessages(missing), /ENOENT/);
  const shared = sharedFixture(root);
  const result = await importDesktopSessions(shared, file, ['missing']);
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(shared.items.size, 0);
});
