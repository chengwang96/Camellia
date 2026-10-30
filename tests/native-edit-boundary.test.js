'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { removeTree } = require('./test-fs.cjs');
const { claudeEditBoundary, grokEditBoundary, nativeEditOptions, nativeEditingSupported } = require('../src/engines/native-edit-boundary');

function transcript(t, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-edit-boundary-'));
  t.after(() => removeTree(root));
  const file = path.join(root, 'history.jsonl');
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('native editing is enabled only for a verified runtime version or newer', () => {
  assert.equal(nativeEditingSupported('claude', '2.1.312'), true);
  assert.equal(nativeEditingSupported('claude', '2.2.0'), true);
  assert.equal(nativeEditingSupported('claude', '2.1.291'), false);
  assert.equal(nativeEditingSupported('grok', '1.0.70'), true);
  assert.equal(nativeEditingSupported('grok', '1.0.69'), false);
  assert.equal(nativeEditingSupported('grok', ''), false);
  assert.equal(nativeEditingSupported('kimi', '2.4.0'), true);
  assert.equal(nativeEditingSupported('kimi', '2.1.1'), false);
});

test('Claude keeps the exact parent entry, including completed tool results and structured output', async t => {
  const kept = randomUUID(), dropped = randomUUID();
  const file = transcript(t, [
    { type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'tool_use', id: 'kept-tool' }] } },
    { type: 'user', uuid: kept, message: { content: [{ type: 'tool_result', tool_use_id: 'kept-tool', content: 'Kept output' }] } },
    { type: 'user', uuid: dropped, parentUuid: kept, message: { content: 'Current instructions\n\n修改原请求\u2028保留换行' } },
    { type: 'user', uuid: randomUUID(), message: { content: [{ type: 'tool_result', content: 'Superseded work' }] } },
    { type: 'user', isSidechain: true, uuid: randomUUID(), message: { content: 'Another agent' } },
  ]);
  assert.deepEqual(await claudeEditBoundary(file, '修改原请求\u2028保留换行'), { resumeSessionAt: kept, resumeDropsTurn: dropped });
});

test('Claude refuses a stale request, a history bridge, and the first native turn', async t => {
  for (const [content, parentUuid] of [
    ['A newer request', randomUUID()],
    ['Conversation context from earlier turns follows as JSON data.\n\nOriginal request', randomUUID()],
    ['Original request', null],
  ]) {
    const file = transcript(t, [{ type: 'user', uuid: randomUUID(), parentUuid, message: { content } }]);
    assert.equal(await claudeEditBoundary(file, 'Original request'), null);
  }
});

function user(index, text) {
  return { method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex: index } } } };
}

test('Grok uses the native prompt index, including gaps from cancelled turns and chunked text', async t => {
  const file = transcript(t, [user(0, 'Earlier request'), user(3, 'Memory instructions\n\n'), user(3, 'Original request')]);
  assert.deepEqual(await grokEditBoundary(file, 'Original request'), { targetPromptIndex: 2 });
});

test('Grok refuses to cut a stale request or a first native turn', async t => {
  const file = transcript(t, [user(0, 'Original request'), user(1, 'Newer request')]);
  assert.equal(await grokEditBoundary(file, 'Original request'), null);
  const first = transcript(t, [user(0, 'Original request')]);
  assert.equal(await grokEditBoundary(first, 'Original request'), null);
});

test('missing and incomplete native histories never manufacture an edit boundary', async t => {
  const file = transcript(t, [user(1, 'Original request')]);
  fs.appendFileSync(file, '{"method":');
  assert.equal(await grokEditBoundary(file, 'Original request'), null);
  assert.equal(await claudeEditBoundary(file + '.missing', 'Original request'), null);
});

test('native boundary options accept zero and reject malformed or foreign options', () => {
  assert.deepEqual(nativeEditOptions('grok', { targetPromptIndex: 0, fork: false }), { targetPromptIndex: 0 });
  for (const targetPromptIndex of [-1, 1.5, '0', NaN, Infinity]) assert.equal(nativeEditOptions('grok', { targetPromptIndex }), null);
  assert.equal(nativeEditOptions('claude', { resumeSessionAt: 'unknown', resumeDropsTurn: randomUUID() }), null);
  assert.equal(nativeEditOptions('codex', { targetPromptIndex: 0 }), null);
  assert.deepEqual(nativeEditOptions('kimi', { undoCount: 1, undoDigest: 'b'.repeat(64) }), { undoCount: 1, undoDigest: 'b'.repeat(64) });
  for (const undoCount of [0, 2, '1']) assert.equal(nativeEditOptions('kimi', { undoCount, undoDigest: 'b'.repeat(64) }), null);
  assert.equal(nativeEditOptions('kimi', { undoCount: 1, undoDigest: '../history' }), null);
  assert.deepEqual(nativeEditOptions('dsh', { atSeq: 0 }), { atSeq: 0 });
  for (const atSeq of [-1, 0.5, '0', NaN, Infinity]) assert.equal(nativeEditOptions('dsh', { atSeq }), null);
});
