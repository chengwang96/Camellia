'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { snapshotTranscript, findRollout, copyCodexState, copyCodexRollouts, copyGrokFork, copyKimiFork, copyDshFork } = require('../src/engines/native-fork');
const { removeTree } = require('./test-fs.cjs');
const { forkKimiNative } = require('../src/engines/kimi-session');
const { forkDshNative } = require('../src/engines/dsh-session');
const { randomUUID } = require('node:crypto');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-native-fork-unit-'));
  t.after(() => removeTree(root));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(source); fs.mkdirSync(target);
  return { root, source, target };
}

test('native transcript snapshots retain complete Unicode records and exclude a partial tail', t => {
  const { source, target } = fixture(t), input = path.join(source, 'history.jsonl'), output = path.join(target, 'history.jsonl');
  const complete = JSON.stringify({ text: '中文\u2028🧪\u2029history' }) + '\n';
  fs.writeFileSync(input, complete + '{"incomplete":');
  snapshotTranscript(input, output);
  assert.equal(fs.readFileSync(output, 'utf8'), complete);
  assert.equal(fs.readFileSync(input, 'utf8'), complete + '{"incomplete":');
});

test('native transcript snapshots do not absorb source appends during copying', t => {
  const { source, target } = fixture(t), input = path.join(source, 'history.jsonl'), output = path.join(target, 'history.jsonl');
  const complete = JSON.stringify({ text: 'a'.repeat(130000) }) + '\n';
  fs.writeFileSync(input, complete);
  const read = fs.readSync;
  let appended = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = read(...args);
    if (!appended) { appended = true; fs.appendFileSync(input, '{"later":"parent continuation"}\n'); }
    return result;
  });
  snapshotTranscript(input, output);
  assert.equal(fs.readFileSync(output, 'utf8'), complete);
  assert.match(fs.readFileSync(input, 'utf8'), /parent continuation/);
});

test('Codex native state backups include committed WAL history but exclude credentials and native goals', async t => {
  const { source, target } = fixture(t);
  const originalPath = path.join(source, 'sessions', 'rollout-source.jsonl');
  const state = new DatabaseSync(path.join(source, 'state_5.sqlite'));
  const history = new DatabaseSync(path.join(source, 'thread_history_1.sqlite'));
  state.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)');
  state.prepare('INSERT INTO threads VALUES(?, ?)').run('source-id', originalPath);
  fs.mkdirSync(path.dirname(originalPath), { recursive: true }); fs.writeFileSync(originalPath, '{}\n');
  const ancestorPath = path.join(source, 'sessions', 'rollout-ancestor.jsonl'); fs.writeFileSync(ancestorPath, '{}\n');
  state.prepare('INSERT INTO threads VALUES(?, ?)').run('ancestor-id', process.platform === 'win32' ? path.toNamespacedPath(ancestorPath) : ancestorPath);
  history.exec('PRAGMA journal_mode=WAL; CREATE TABLE items(text TEXT); INSERT INTO items VALUES(\'native WAL context\')');
  for (const name of ['auth.json', 'config.toml', 'goals_1.sqlite', 'queue_1.sqlite']) fs.writeFileSync(path.join(source, name), 'must not copy');
  await copyCodexState(source, target);
  const childPath = path.join(target, 'sessions', 'rollout-source.jsonl');
  copyCodexRollouts(source, target);
  const child = new DatabaseSync(path.join(target, 'state_5.sqlite'));
  const childHistory = new DatabaseSync(path.join(target, 'thread_history_1.sqlite'));
  try {
    assert.equal(child.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('source-id').rollout_path, childPath);
    assert.equal(state.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('source-id').rollout_path, originalPath);
    assert.equal(child.prepare('SELECT rollout_path FROM threads WHERE id = ?').get('ancestor-id').rollout_path, path.join(target, 'sessions', 'rollout-ancestor.jsonl'));
    assert.equal(childHistory.prepare('SELECT text FROM items').get().text, 'native WAL context');
    childHistory.exec("INSERT INTO items VALUES('child-only history')");
    assert.equal(history.prepare('SELECT count(*) AS n FROM items').get().n, 1);
    for (const name of ['auth.json', 'config.toml', 'goals_1.sqlite', 'queue_1.sqlite']) assert.equal(fs.existsSync(path.join(target, name)), false);
    await assert.rejects(copyCodexState(source, target), /already in use/);
  } finally { child.close(); childHistory.close(); state.close(); history.close(); }
});

test('Codex rollout discovery stays within the native session tree and rejects path-like identities', t => {
  const { source } = fixture(t), directory = path.join(source, 'sessions', '2026', '10', '30');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'rollout-time-source-id.jsonl'); fs.writeFileSync(file, '{}\n');
  assert.equal(findRollout(source, 'source-id'), file);
  assert.equal(findRollout(source, '../source-id'), null);
  assert.equal(findRollout(source, 'missing-id'), null);
});

test('Grok copies only the newly forked native session into the child home', async t => {
  const { source, target } = fixture(t), directory = path.join(source, 'sessions', 'workspace', 'fork-id');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'updates.jsonl'); fs.writeFileSync(file, '{"kept":"context"}\n');
  fs.writeFileSync(path.join(source, 'auth.json'), 'must not copy');
  await copyGrokFork(file, source, target);
  fs.appendFileSync(file, '{"later":"source append"}\n');
  assert.equal(fs.readFileSync(path.join(target, 'sessions', 'workspace', 'fork-id', 'updates.jsonl'), 'utf8'), '{"kept":"context"}\n');
  assert.equal(fs.existsSync(path.join(target, 'auth.json')), false);
  await assert.rejects(copyGrokFork(path.join(source, 'outside', 'updates.jsonl'), source, target), /Invalid native Grok fork location/);
});

test('Kimi relocates the native fork index and leaves source history and credentials independent', async t => {
  const { source, target, root } = fixture(t), directory = path.join(source, 'sessions', 'workspace', 'session_fork');
  fs.mkdirSync(path.join(directory, 'agents', 'main'), { recursive: true });
  const journal = path.join(directory, 'agents', 'main', 'wire.jsonl'); fs.writeFileSync(journal, '{"kept":"native context"}\n');
  fs.writeFileSync(path.join(directory, 'state.json'), '{"id":"session_fork"}');
  const index = { sessionId: 'session_fork', sessionDir: directory, workDir: root };
  fs.writeFileSync(path.join(source, 'session_index.jsonl'), JSON.stringify(index) + '\n');
  fs.writeFileSync(path.join(source, 'auth.json'), 'must not copy');
  await copyKimiFork(source, target, 'session_fork');
  const relocated = JSON.parse(fs.readFileSync(path.join(target, 'session_index.jsonl'), 'utf8'));
  assert.equal(path.resolve(relocated.sessionDir), path.join(target, 'sessions', 'workspace', 'session_fork'));
  assert.equal(relocated.workDir, root);
  fs.appendFileSync(journal, '{"later":"parent"}\n');
  assert.equal(fs.readFileSync(path.join(relocated.sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf8'), '{"kept":"native context"}\n');
  assert.equal(fs.existsSync(path.join(target, 'auth.json')), false);
});

test('Kimi forks through the source lease and cold-rebinds only the child MCP server', async () => {
  const calls = [], source = { sessionId: 'session_source', ready: Promise.resolve(),
    agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } }, spec: { env: { KIMI_CODE_HOME: '/unused' } },
    request: async (method, params) => { calls.push({ method, params }); return method === 'session/fork' ? { sessionId: 'session_child' } : {}; },
    kill: () => assert.fail('Forking must not kill the source process') };
  const sourceBridge = { config: { command: 'node', args: ['source.js'], env: { OWNER: 'source' } } };
  const childBridge = { config: { command: 'node', args: ['child.js'], env: { OWNER: 'child' } } };
  const fork = await forkKimiNative({ sessionId: source.sessionId, sourceConversationId: 'source', conversationId: 'child', cwd: '/workspace',
    settings: {}, goalBridge: childBridge, sourceGoalBridge: sourceBridge, registerSession() {},
    ensureSource: opts => { assert.equal(opts.conversationId, 'source'); assert.equal(opts.goalBridge, sourceBridge); return source; } });
  assert.equal(fork.nativeId, 'session_child');
  assert.equal(source.sessionId, 'session_source');
  assert.deepEqual(calls.map(call => call.method), ['session/fork', 'session/close', 'session/resume', 'session/close']);
  for (const call of calls.slice(1)) assert.equal(call.params.sessionId, 'session_child');
  assert.deepEqual(calls[2].params.mcpServers[0].env, [{ name: 'OWNER', value: 'child' }]);
});

test('Kimi refuses a fork when it cannot close the child before rebinding tools', async () => {
  let resumed = false;
  const source = { ready: Promise.resolve(), agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } },
    request: async method => {
      if (method === 'session/fork') return { sessionId: 'session_child' };
      if (method === 'session/close') throw new Error('Child still busy');
      if (method === 'session/resume') resumed = true;
    } };
  await assert.rejects(forkKimiNative({ sessionId: 'session_source', ensureSource: () => source, registerSession() {} }), /Child still busy/);
  assert.equal(resumed, false);
});

test('DSH copies only a closed fork and referenced attachment storage, leaving the source independent', async t => {
  const { source, target } = fixture(t), id = 'session-' + randomUUID();
  const directory = path.join(source, 'sessions', 'project', id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'v4.jsonl'), '{"native":"event-prefix"}\n');
  fs.writeFileSync(path.join(directory, 'session.lock'), 'not part of child state');
  fs.mkdirSync(path.join(source, 'attachments', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(source, 'attachments', 'v1', 'hash'), 'image-bytes');
  fs.writeFileSync(path.join(source, '.credentials.yaml'), 'must not copy');
  await copyDshFork(source, target, id);
  const copied = path.join(target, 'sessions', 'project', id, 'v4.jsonl');
  assert.equal(fs.readFileSync(copied, 'utf8'), '{"native":"event-prefix"}\n');
  fs.appendFileSync(path.join(directory, 'v4.jsonl'), '{"later":"source"}\n');
  assert.doesNotMatch(fs.readFileSync(copied, 'utf8'), /later/);
  assert.equal(fs.readFileSync(path.join(target, 'attachments', 'v1', 'hash'), 'utf8'), 'image-bytes');
  assert.equal(fs.existsSync(path.join(target, 'sessions', 'project', id, 'session.lock')), false);
  assert.equal(fs.existsSync(path.join(target, '.credentials.yaml')), false);
  await assert.rejects(copyDshFork(source, target, '../source'), /identity/);
});

for (const canceled of [false, true]) test('DSH native fork closes only its child and forwards the exact event boundary' + (canceled ? ' when canceled' : ''), async t => {
  const { source, target } = fixture(t), childId = 'session-' + randomUUID(), calls = [];
  const directory = path.join(source, 'sessions', 'project', childId);
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'v4.jsonl'), '{}\n');
  let cancel;
  const goalBridge = { config: { command: 'node', args: ['child'], env: { OWNER: 'child' } } };
  const session = { spec: { nativeHistory: true, env: { DSH_HOME: source } }, ready: Promise.resolve(), sessionId: 'source',
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'session/camellia_fork') { if (canceled) cancel.kill(); return { sessionId: childId }; }
      return {};
    } };
  const pending = forkDshNative({ ensureSource: () => session, targetHome: target, sessionId: 'source', sourceConversationId: 'parent',
    cwd: '/workspace', settings: {}, boundary: { atSeq: 19 }, goalBridge, registerSession: owned => { cancel = owned; } });
  if (canceled) await assert.rejects(pending, /canceled/);
  else assert.equal((await pending).nativeId, childId);
  assert.deepEqual(calls.map(call => call.method), ['session/camellia_fork', 'session/close']);
  assert.equal(calls[0].params.atSeq, 19);
  assert.equal(calls[1].params.sessionId, childId);
  assert.deepEqual(calls[0].params.mcpServers[0].env, [{ name: 'OWNER', value: 'child' }]);
  assert.equal(session.sessionId, 'source');
});

test('DSH forks through its captured running source when the child has new next-turn settings', async t => {
  const { source, target } = fixture(t), childId = 'session-' + randomUUID(), calls = [];
  const directory = path.join(source, 'sessions', 'project', childId);
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'v4.jsonl'), '{}\n');
  const session = { spec: { nativeHistory: true, env: { DSH_HOME: source } }, ready: Promise.resolve(),
    sessionId: 'source', running: true, settings: { thinkingBudget: 'low' },
    request: async (method, params) => { calls.push({ method, params }); return method === 'session/camellia_fork' ? { sessionId: childId } : {}; } };
  const fork = await forkDshNative({ sessionId: 'source', sourceConversationId: 'parent', sourceSession: session,
    ensureSource: () => { throw new Error('Fork must not reconfigure or restart its running source'); },
    targetHome: target, cwd: '/workspace', settings: { thinkingBudget: 'high' }, boundary: { atSeq: 19 }, registerSession() {} });
  assert.equal(fork.nativeId, childId);
  assert.equal(session.running, true);
  assert.equal(session.settings.thinkingBudget, 'low');
  assert.deepEqual(calls.map(call => call.method), ['session/camellia_fork', 'session/close']);
  assert.equal(calls[1].params.sessionId, childId);
});

test('DSH never replaces an unavailable captured source with a newly configured process', async () => {
  for (const sourceSession of [{ sessionId: 'other' }, { sessionId: 'source', dead: true }])
    await assert.rejects(forkDshNative({ sessionId: 'source', sourceSession,
      ensureSource() { assert.fail('A stale active source must not be restarted by its fork'); } }), /captured DSH fork source/);
});
