'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { entriesOf, searchHistory, recentFiles, buildHistoryIndex } = require('../src/main/conversation-index');

const cwd = path.resolve('/project');

function rows() {
  return [
    { role: 'user', seq: 1, text: '帮我调整试讲 PPT 的配色，顺便更新构建脚本' },
    { role: 'tool', seq: 2, text: JSON.stringify({ type: 'gui:tool', id: 't1', name: 'apply_patch', status: 'completed',
      input: { patch: '*** Begin Patch\n*** Update File: outputs/UDP与TCP试讲.pptx\n*** End Patch' } }) },
    { role: 'tool', seq: 3, text: JSON.stringify({ type: 'gui:tool', id: 't2', name: 'Write', status: 'completed', input: { file_path: 'tools/build-deck.cjs' } }) },
    { role: 'tool', seq: 4, text: JSON.stringify({ type: 'gui:tool', id: 't3', name: 'Write', status: 'completed', input: { file_path: 'tools/broken.cjs' } }) },
    { role: 'tool', seq: 5, text: JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true }] } }) },
    { role: 'assistant', seq: 6, text: '调整完成。' },
    { role: 'user', seq: 7, text: '再帮我看下年报数据' },
    { role: 'tool', seq: 8, text: JSON.stringify({ type: 'gui:tool', id: 't4', name: 'create_file', status: 'completed', input: { path: '年报分析.md' } }) },
    { role: 'assistant', seq: 9, text: '已生成年报分析。' },
    { role: 'assistant', seq: 10, text: '内部草稿', internal: true },
  ];
}

test('history records the files a turn wrote together with the words around it', () => {
  const entries = entriesOf(rows(), { cwd, sessionId: 's1', title: '试讲材料' });
  assert.deepEqual(entries.map(entry => path.basename(entry.path)).sort(),
    ['UDP与TCP试讲.pptx', 'build-deck.cjs', '年报分析.md']);
  // A failed write is not a file the conversation produced.
  assert.equal(entries.some(entry => entry.path.includes('broken.cjs')), false);
  // Relative paths resolve against the conversation folder.
  assert.ok(entries.every(entry => path.isAbsolute(entry.path)));
  assert.match(entries.find(entry => entry.path.includes('试讲')).description, /配色/);
  assert.match(entries.find(entry => entry.path.includes('年报')).description, /年报数据/);
});

test('a path is recovered even though the artifact filter would hide it', () => {
  // `tools/build-deck.cjs` is edited source: the normal artifact panel drops it,
  // but the user's own file must still be findable.
  const entries = entriesOf(rows(), { cwd, sessionId: 's1', title: '试讲材料' });
  assert.ok(entries.some(entry => entry.path.endsWith('build-deck.cjs')));
});

test('search matches names, titles and descriptions without reading file contents', () => {
  const entries = entriesOf(rows(), { cwd, sessionId: 's1', title: '试讲材料' });
  const byName = searchHistory({ query: '试讲', entries, cwd });
  // Name matches rank above description-only matches, but a turn's other files
  // are still returned: they share the words the user used to describe it.
  assert.deepEqual(byName.map(entry => path.basename(entry.path)), ['UDP与TCP试讲.pptx', 'build-deck.cjs']);
  // The user remembers the topic, not the name.
  const byDescription = searchHistory({ query: '配色', entries, cwd });
  assert.deepEqual(byDescription.map(entry => path.basename(entry.path)), ['UDP与TCP试讲.pptx', 'build-deck.cjs']);
  // The conversation title is part of the index too.
  assert.deepEqual(searchHistory({ query: '试讲材料 配色', entries, cwd }).map(entry => path.basename(entry.path)),
    ['UDP与TCP试讲.pptx', 'build-deck.cjs']);
  // Every term has to match; an unrelated second word is not a hit.
  assert.deepEqual(searchHistory({ query: '试讲 完全无关', entries, cwd }), []);
  assert.deepEqual(searchHistory({ query: 'build-deck', entries, cwd }).map(entry => path.basename(entry.path)), ['build-deck.cjs']);
});

test('a file under the current conversation folder outranks an older one elsewhere', () => {
  const entries = [
    ...entriesOf(rows(), { cwd, sessionId: 's1', title: '试讲材料' }),
    { path: path.resolve('/elsewhere/report.md'), descriptions: ['report 试讲 配色'], titles: new Set(), sessions: new Set(['s2']) },
  ];
  const ranked = searchHistory({ query: '试讲 配色', entries, cwd });
  assert.ok(ranked[0].path.startsWith(cwd), ranked.map(entry => entry.path));
  assert.equal(ranked.length, 3);
  assert.equal(path.basename(ranked.at(-1).path), 'report.md');
});

test('an empty query lists the most recently produced files, live ones first', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { removeTree } = require('./test-fs.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-recent-'));
  t.after(() => removeTree(root));
  const older = path.join(root, '旧的.md');
  const newer = path.join(root, '新的.md');
  const gone = path.join(root, '已删除.md');
  fs.writeFileSync(older, 'a');
  fs.writeFileSync(newer, 'b');
  const entries = [
    { path: older, descriptions: [], titles: new Set(), sessions: new Set(['s1']), at: 1000 },
    { path: newer, descriptions: [], titles: new Set(), sessions: new Set(['s1']), at: 5000 },
    { path: gone, descriptions: [], titles: new Set(), sessions: new Set(['s1']), at: 9000 },
  ];
  const recent = searchHistory({ query: '   ', entries, cwd: root });
  // Newest first, and a file that no longer exists is not allowed to lead.
  assert.deepEqual(recent.map(entry => path.basename(entry.path)), ['新的.md', '旧的.md', '已删除.md']);
  assert.deepEqual(recent.map(entry => Boolean(entry.exists)), [true, true, false]);
  assert.deepEqual(recentFiles({ entries, cwd: root, limit: 2 }).map(entry => path.basename(entry.path)), ['新的.md', '旧的.md']);
});

test('equal timestamps preserve newest conversation and newest turn order', t => {
  const fs = require('node:fs'), os = require('node:os');
  const { removeTree } = require('./test-fs.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-recent-tie-'));
  t.after(() => removeTree(root));
  const names = ['a-old-conversation.md', 'b-old-turn.md', 'z-new-turn.md'];
  for (const name of names) fs.writeFileSync(path.join(root, name), name);
  const row = name => ({ role: 'assistant', text: name, at: 1000, artifacts: [{ path: path.join(root, name) }] });
  const histories = { older: [row(names[0])], newer: [row(names[1]), row(names[2])] };
  const manager = { get: id => ({ id, cwd: root }), rows: conversation => histories[conversation.id] };
  const entries = buildHistoryIndex(manager, { sessions: [{ id: 'newer' }, { id: 'older' }] });
  assert.deepEqual(recentFiles({ entries }).map(entry => path.basename(entry.path)), [...names].reverse());
});
