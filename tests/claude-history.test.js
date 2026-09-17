'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeHistory } = require('../src/engines/claude-history');
const { createHarness } = require('./claude-harness.cjs');

test('unchanged history uses cached heads; edits, renames and deletions invalidate correctly', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const file = h.seedSession('cached', h.folder('project'), 'Initial title');
  let reads = 0;
  const counted = Object.create(fs);
  counted.readSync = (...args) => { reads++; return fs.readSync(...args); };
  const history = new ClaudeHistory(path.join(h.home, '.claude', 'projects'), counted);
  const scan = async () => (await history.list()).map(entry => history.head(entry.file, entry));
  assert.equal((await scan())[0].title, 'Initial title');
  assert.equal((await scan())[0].title, 'Initial title');
  assert.equal(reads, 1);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: 'new folder', message: { role: 'user', content: 'Edited title' } }));
  assert.ok((await scan()).some(head => head.title === 'Edited title'));
  assert.ok(reads > 1);
  fs.unlinkSync(file);
  await history.list();
  assert.equal(history.heads.has(file), false);
});

test('long conversations display the newest 200 messages, skip metadata, and retain original cwd', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const cwd = h.folder('project');
  const file = h.seedSession('long', cwd);
  const rows = [];
  for (let i = 0; i < 310; i++) rows.push({ type: i % 2 ? 'assistant' : 'user', cwd,
    message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `消息 ${i} 中文🧪` }] } });
  rows.push({ type: 'user', isMeta: true, message: { role: 'user', content: 'hidden' } });
  rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'hidden result' }] } });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\ninvalid partial');
  const res = await h.call('claude-load-session', 'long');
  assert.equal(res.ok, true, res.error);
  assert.equal(res.messages.length, 200);
  assert.equal(res.messages[0].text, '消息 110 中文🧪');
  assert.equal(res.messages.at(-1).text, '消息 309 中文🧪');
  assert.equal(res.truncated, true);
  assert.equal(res.cwd, cwd);
});

test('newest duplicate transcript wins and invalid IDs cannot escape the history root', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  h.seedSession('same', h.folder('old'), 'older', 1000);
  const recent = h.seedSession('same', h.folder('new'), 'newer', 2000);
  const history = new ClaudeHistory(path.join(h.home, '.claude', 'projects'));
  assert.equal(history.find('same'), recent);
  assert.equal((await h.call('claude-list-sessions')).sessions.length, 1);
  for (const id of ['../same', '..', '__proto__', 'C:\\file', '']) {
    assert.equal(history.find(id), null);
    assert.equal((await h.call('claude-load-session', id)).ok, false);
    assert.equal(h.call('claude-rename-session', { id, title: 'bad' }).ok, false);
  }
});

test('history ignores vanished files but surfaces filesystem errors', async t => {
  const h = createHarness(); t.after(() => h.cleanup());
  const file = h.seedSession('unreadable', h.folder('project'));
  const error = Object.assign(new Error('Access denied to transcript'), { code: 'EACCES' });
  const fileSystem = Object.create(fs);
  fileSystem.statSync = () => { throw error; };
  Object.defineProperty(fileSystem, 'promises', { value: {
    ...fs.promises, stat: async () => { throw error; },
  } });
  const history = new ClaudeHistory(path.join(h.home, '.claude', 'projects'), fileSystem);
  await assert.rejects(history.list(), { code: 'EACCES' });
  assert.throws(() => history.find('unreadable'), { code: 'EACCES' });
  error.code = 'ENOENT';
  assert.deepEqual(await history.list(), []);
  assert.equal(history.find('unreadable'), null);
  assert.equal(fs.existsSync(file), true, 'The test only simulates a concurrent deletion');
});
