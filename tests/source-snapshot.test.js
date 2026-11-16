'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');

const searchOutput = {
  ok: true,
  provider: 'deepseek',
  results: [
    { title: 'First', url: 'https://example.com/a', summary: 'one' },
    { title: 'Duplicate', url: 'http://www.example.com/a/?utm_source=x', summary: 'ignored' },
    { title: 'Second', url: 'https://example.org/b', summary: 'two' },
  ],
};

for (const encoded of [false, true]) test('source snapshots survive an MCP envelope' + (encoded ? ' inside a JSON string' : ''), async t => {
  const h = fixture(t);
  const run = await h.manager.send('claude', { prompt: 'Find two sources' });
  const session = h.sessions.claude;
  const envelope = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(searchOutput) }] });
  h.manager.capture('claude', {
    type: 'gui:tool', id: 'search-mcp', name: 'camellia_web_search',
    input: { query: 'two sources' }, status: 'completed', output: encoded ? JSON.stringify(envelope) : envelope,
    session_id: session.sessionId, runId: session.gen,
  });
  h.manager.capture('claude', {
    type: 'result', subtype: 'success', is_error: false, result: 'Found sources.',
    session_id: session.sessionId, runId: session.gen,
  });
  await run.done;
  const assistant = h.manager.rows(h.manager.get(run.sessionId)).filter(row => row.role === 'assistant').at(-1);
  assert.deepEqual(assistant.sources?.map(source => source.title), ['First', 'Second']);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-source-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    removeTree(root);
  });
  const sessions = {};
  const drivers = Object.fromEntries(ENGINES.map(engine => [engine, {
    settings: () => ({ model: 'fixture' }), saveSettings: value => value,
    ensure(opts) {
      const session = {
        gen: 1, sessionId: opts.sessionId || 'source-' + engine, running: false,
        settings: { cwd: opts.cwd }, opts,
        sendUserMessage() { session.running = true; return true; },
        interrupt() {}, answerPermission() { return true; },
      };
      sessions[engine] = session;
      return session;
    },
  }]));
  const manager = new SharedConversations({
    dir: root, skillsDir: path.join(root, 'skills'),
    loadConfig: () => ({}), saveConfig: () => {}, drivers,
  });
  return { manager, sessions };
}

test('a finished turn stores a deduplicated source snapshot on its assistant row', async t => {
  const h = fixture(t);
  const run = await h.manager.send('claude', { prompt: 'Find two sources' });
  const session = h.sessions.claude;
  h.manager.capture('claude', {
    type: 'gui:tool', id: 'search-1', name: 'camellia_web_search',
    input: { query: 'two sources' }, status: 'completed', output: JSON.stringify(searchOutput),
    session_id: session.sessionId, runId: session.gen,
  });
  h.manager.capture('claude', {
    type: 'result', subtype: 'success', is_error: false,
    result: 'See [First](https://example.com/a) and [Second](https://example.org/b).',
    session_id: session.sessionId, runId: session.gen,
  });
  await run.done;

  const conversation = h.manager.get(run.sessionId);
  const assistant = h.manager.rows(conversation).filter(row => row.role === 'assistant').at(-1);
  assert.ok(assistant, 'assistant row exists');
  assert.equal(assistant.sources.length, 2);
  assert.deepEqual(assistant.sources.map(source => source.title), ['First', 'Second']);
  assert.deepEqual(assistant.sources.map(source => source.key), ['https://example.com/a', 'https://example.org/b']);
  assert.equal(assistant.sources[0].summary, 'one');

  const reloaded = new SharedConversations({
    dir: h.manager.dir, skillsDir: path.join(h.manager.dir, 'skills'),
    loadConfig: () => ({}), saveConfig: () => {}, drivers: {},
  });
  const persisted = reloaded.rows(reloaded.get(run.sessionId))
    .filter(row => row.role === 'assistant').at(-1);
  assert.equal(persisted.sources.length, 2);
  assert.equal(persisted.sources[1].url, 'https://example.org/b');
});
