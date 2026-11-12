'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { ConversationHistory } = require('../src/engines/conversation-history');
const { statusFor, searchFor, expandFor, retireBlock, restoreBlock, rewriteBlock } = require('../src/engines/context-retrieval');
const { validateTool } = require('../src/engines/goal-tools');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-context-retrieval-'));
  t.after(() => removeTree(root));
  const history = new ConversationHistory(root);
  const summary = path.join(root, 'summary.md');
  fs.writeFileSync(summary, '# Compacted context\n\nAuth refresh uses the refresh endpoint.\n');
  const conversation = { id: 'conversation', currentEngine: 'codex', segments: {} };
  history.appendAll(conversation.id, [
    { seq: 1, role: 'user', text: 'Need auth token refresh' },
    { seq: 2, role: 'assistant', text: 'Use the refresh endpoint' },
    { seq: 3, role: 'notice', engine: 'codex', text: 'Context compacted', file: summary,
      compaction: { native: false, state: 'completed' } },
    { seq: 4, role: 'user', text: 'After compaction' },
    { seq: 5, role: 'assistant', text: 'New answer' },
  ]);
  return { root, history, conversation, summary };
}

test('portable compaction blocks expose source ranges and recover exact rows', t => {
  const { root, history, conversation } = fixture(t);
  const status = statusFor(history, conversation);
  assert.equal(status.blocks.length, 1);
  assert.equal(status.blocks[0].blockId, 'b1');
  assert.equal(status.blocks[0].fromSeq, 1);
  assert.equal(status.blocks[0].toSeq, 2);
  assert.ok(status.blocks[0].summaryTokens > 0);
  assert.ok(status.blocks[0].originalTokens > 0);
  const expanded = expandFor(history, conversation, root, { blockId: 'b1' });
  assert.equal(expanded.messages.length, 2);
  assert.equal(expanded.messages[0].text, 'Need auth token refresh');
  assert.equal(expanded.messages[1].text, 'Use the refresh endpoint');
  assert.match(expanded.note, /Quoted historical data/);
});

test('context search finds summaries and originals, and large expansion can be exported', t => {
  const { root, history, conversation } = fixture(t);
  const search = searchFor(history, conversation, 'refresh endpoint', 8);
  assert.ok(search.results.some(result => result.source === 'summary'));
  assert.ok(search.results.some(result => result.source === 'original'));
  const exported = expandFor(history, conversation, root, { blockId: 'b1', toFile: true, maxChars: 1024 });
  assert.ok(exported.file && fs.existsSync(exported.file));
  assert.equal(exported.text, undefined);
  assert.match(fs.readFileSync(exported.file, 'utf8'), /Need auth token refresh/);
});

test('exact expansion and file export keep long original rows intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-context-long-row-'));
  t.after(() => removeTree(root));
  const history = new ConversationHistory(root);
  const summary = path.join(root, 'summary.md');
  fs.writeFileSync(summary, '# Compacted context\n');
  const conversation = { id: 'conversation', currentEngine: 'codex', segments: {} };
  const original = 'A'.repeat(5000) + 'TAIL_MARKER' + 'B'.repeat(5000);
  history.appendAll(conversation.id, [
    { seq: 1, role: 'user', text: original },
    { seq: 2, role: 'notice', engine: 'codex', text: 'Context compacted', file: summary,
      compaction: { native: false, state: 'completed' } },
  ]);
  const inline = expandFor(history, conversation, root, { blockId: 'b1' });
  assert.equal(inline.messages[0].text, original);
  assert.equal(inline.chars, original.length);
  assert.equal(inline.truncated, false);
  const exported = expandFor(history, conversation, root, { blockId: 'b1', toFile: true, maxChars: 512 });
  const text = fs.readFileSync(exported.file, 'utf8');
  assert.match(text, /TAIL_MARKER/);
  assert.match(text, new RegExp(original));
  assert.equal(exported.chars, original.length);
  assert.equal(exported.truncated, false);
});

test('expanding a range keeps tool call/result pairs together and records the pinned first user', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-context-pairs-'));
  t.after(() => removeTree(root));
  const history = new ConversationHistory(root);
  const summary = path.join(root, 'summary.md');
  fs.writeFileSync(summary, '# Compacted context\n\nThe first request was preserved.\n');
  const conversation = { id: 'conversation', currentEngine: 'codex', segments: {} };
  history.appendAll(conversation.id, [
    { seq: 1, role: 'user', text: 'First user request' },
    { seq: 2, role: 'tool', text: JSON.stringify({ type: 'tool_use', id: 'pair-1', name: 'Read' }) },
    { seq: 3, role: 'tool', text: JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'pair-1', content: 'result' }] } }) },
    { seq: 4, role: 'notice', engine: 'codex', text: 'Context compacted', file: summary,
      compaction: { native: false, state: 'completed' } },
  ]);
  const status = statusFor(history, conversation);
  assert.equal(status.firstUserSeq, 1);
  assert.equal(status.firstUserPinned, true);
  const explicit = expandFor(history, conversation, root, { fromSeq: 3, toSeq: 3 });
  assert.equal(explicit.fromSeq, 2);
  assert.equal(explicit.toSeq, 3);
  assert.equal(explicit.pairExpanded, true);
  assert.deepEqual(explicit.messages.map(message => message.seq), [2, 3]);
  const block = expandFor(history, conversation, root, { blockId: 'b1' });
  assert.equal(block.firstUserPinned, true);
  assert.equal(block.messages[0].role, 'user');
  assert.equal(block.messages[0].text, 'First user request');
});

test('context tool schemas require the current turn token and reject unknown fields', () => {
  assert.doesNotThrow(() => validateTool('camellia_context_status', { run_token: 'turn-token' }));
  assert.throws(() => validateTool('camellia_context_status', {}), /Missing argument: run_token/);
  assert.throws(() => validateTool('camellia_context_expand', { run_token: 'turn-token', unexpected: true }), /Unexpected argument/);
});

test('portable block retirement and rewrite are reversible metadata operations', t => {
  const { root, history, conversation, summary } = fixture(t);
  conversation.segments = { codex: { compactFile: summary, cursor: 3, isolated: true } };
  const before = statusFor(history, conversation);
  assert.equal(before.activeBlockId, 'b1');
  assert.equal(before.blocks[0].active, true);
  const retired = retireBlock(history, conversation, 'b1');
  assert.equal(retired.blockId, 'b1');
  const afterRetire = statusFor(history, conversation);
  assert.equal(afterRetire.blocks[0].retired, true);
  assert.equal(conversation.segments.codex.summaryRetired.blockId, 'b1');
  const restored = restoreBlock(history, conversation, 'b1');
  assert.equal(restored.active, true);
  assert.equal(conversation.segments.codex.summaryRetired, undefined);
  const rewritten = rewriteBlock(history, conversation, 'b1', '# New working context\n\nShort summary');
  assert.ok(fs.existsSync(rewritten.previousSummaryFile));
  assert.match(fs.readFileSync(summary, 'utf8'), /Short summary/);
  assert.ok(statusFor(history, conversation).blocks[0].rewrittenAt);
});
