'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SharedConversations } = require('../src/engines/shared-conversations');
const { listDesktopSessions, readRolloutMessages, importDesktopSessions, desktopStatePath } = require('../src/main/codex-desktop-import');

function stateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-import-test-'));
  let db;
  t.after(() => { try { db?.close(); } catch {} fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const file = path.join(root, 'state_5.sqlite');
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    created_at_ms INTEGER, updated_at_ms INTEGER)`);
  return { root, file, get db() { return db; }, close: () => db.close() };
}

function addThread(db, { id, title = '', first = '', cwd = 'D:/work', source = 'vscode', archived = 0, rollout = '' }) {
  db.prepare(`INSERT INTO threads (id, rollout_path, title, first_user_message, cwd, source, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rollout, title, first, cwd, source, archived, 1789000000, 1789000000);
}

function writeRollout(root, name, rows) {
  const file = path.join(root, name);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const responseItem = (role, text, at = '2026-09-16T10:00:00.000Z') =>
  ({ timestamp: at, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('desktop session listing skips subagents, archived rows and missing rollouts', t => {
  const { root, file, db, close } = stateFixture(t);
  const rollout = writeRollout(root, 'a.jsonl', [responseItem('user', 'hello')]);
  addThread(db, { id: 'main', title: 'Main chat', rollout });
  addThread(db, { id: 'sub', source: '{"subagent":{"other":"x"}}', rollout });
  addThread(db, { id: 'archived', archived: 1, rollout });
  addThread(db, { id: 'gone', first: 'No file left', rollout: path.join(root, 'missing.jsonl') });
  close();
  const sessions = listDesktopSessions(file);
  assert.deepEqual(sessions.map(s => s.id), ['main', 'gone']);
  assert.equal(sessions[0].title, 'Main chat');
  assert.equal(sessions[1].importable, false);
  assert.equal(sessions[1].title, 'No file left');
  assert.deepEqual(listDesktopSessions(file, { excludeIds: new Set(['main']) }).map(s => s.id), ['gone']);
});

test('rollout parsing keeps user and assistant text, unwraps the desktop request wrapper, skips environment blocks', t => {
  const { root } = stateFixture(t);
  const rollout = writeRollout(root, 'b.jsonl', [
    { type: 'session_meta', payload: { id: 'x' } },
    responseItem('user', '# Files mentioned by the user:\n\n## a.png: C:/a.png\n\n## My request:\n do the thing ', '2026-09-16T10:00:01.000Z'),
    { timestamp: '2026-09-16T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignored</environment_context>' }] } },
    responseItem('assistant', 'working on it', '2026-09-16T10:00:03.000Z'),
    responseItem('assistant', 'working on it', '2026-09-16T10:00:03.100Z'),
    { timestamp: '2026-09-16T10:00:04.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', text: 'duplicate copy' } } },
  ]);
  const messages = readRolloutMessages(rollout);
  assert.deepEqual(messages.map(m => m.role + ':' + m.text), ['user:do the thing', 'assistant:working on it']);
  assert.equal(messages[0].at, Date.parse('2026-09-16T10:00:01.000Z'));
});

test('import creates shared conversations with codex history and skips re-imports', t => {
  const { root, file, db, close } = stateFixture(t);
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const rollout = writeRollout(root, 'c.jsonl', [responseItem('user', 'first question'), responseItem('assistant', 'first answer')]);
  addThread(db, { id: 'thread-1', title: 'Imported chat', cwd, rollout });
  close();
  const dir = path.join(root, 'conversations');
  let config = {};
  const shared = new SharedConversations({ dir, loadConfig: () => config, saveConfig: p => { config = { ...config, ...p }; },
    drivers: { codex: { settings: () => ({ connection: 'api', model: 'fixture' }) } } });
  const result = importDesktopSessions(shared, file, ['thread-1']);
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
