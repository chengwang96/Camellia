'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { ConversationHistory } = require('../src/engines/conversation-history');
const { snapshotForConversation, nodeForConversation, eventsForConversation } = require('../src/engines/context-ledger');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-context-ledger-'));
  t.after(() => removeTree(root));
  const history = new ConversationHistory(root);
  const conversation = { id: 'conversation', currentEngine: 'codex', handoffs: [] };
  history.appendAll(conversation.id, [
    { seq: 1, role: 'user', text: 'Old request' },
    { seq: 2, role: 'assistant', text: 'Old answer' },
    { seq: 3, role: 'user', text: 'Current request', attachments: [{ name: 'screen.png', isImage: true }] },
    { seq: 4, role: 'tool', text: JSON.stringify({ type: 'gui:tool', name: 'bash', status: 'completed', output: 'ok' }) },
    { seq: 5, role: 'assistant', text: 'Current answer', runResult: { result: 'Current answer' }, lastCallUsage: { input_tokens: 9000, output_tokens: 100, context_window: 200000 } },
    { seq: 6, role: 'notice', text: 'Context compacted', engine: 'codex', compaction: { native: true, state: 'completed' } },
  ]);
  return { root, history, conversation };
}

test('context snapshots account for the current turn, opaque residual and attachments', t => {
  const { history, conversation } = fixture(t);
  const snapshot = snapshotForConversation({ historyStore: history, conversation, engine: 'codex',
    settings: { model: 'fixture', connection: 'api' },
    pressure: { source: 'usage', used: 15000, cap: 200000 },
    instructionsText: 'Follow the workspace instructions.', summaryText: 'A compacted summary.' });
  assert.equal(snapshot.turnSeq, 3);
  assert.equal(snapshot.pressure.source, 'usage');
  assert.equal(snapshot.usage.inputTokens, 9000);
  assert.ok(snapshot.pressure.used >= 15000);
  assert.ok(snapshot.categories.some(category => category.id === 'conversation'));
  assert.ok(snapshot.categories.some(category => category.id === 'tool-results'));
  assert.ok(snapshot.categories.some(category => category.id === 'attachments'));
  assert.ok(snapshot.categories.some(category => category.id === 'compaction'));
  assert.ok(snapshot.categories.some(category => category.id === 'engine-managed' && category.status === 'opaque'));
  assert.ok(snapshot.nodes.some(node => node.seq === 4 && node.category === 'tool-results'));
  assert.ok(snapshot.events.some(event => event.kind === 'compact'));
  assert.ok(snapshot.warnings.some(warning => /not individually observable/.test(warning)));
});

test('historical snapshots stop at the next user turn and node content is bounded and redacted', t => {
  const { history, conversation } = fixture(t);
  const snapshot = snapshotForConversation({ historyStore: history, conversation, engine: 'codex',
    settings: { model: 'fixture', connection: 'api' }, turnSeq: 1 });
  assert.equal(snapshot.turnSeq, 1);
  assert.ok(snapshot.nodes.every(node => node.seq === 1 || node.seq === 2));
  assert.ok(!snapshot.nodes.some(node => node.seq === 3));

  history.appendAll(conversation.id, [{ seq: 7, role: 'user', text: 'api_key=sk-12345678901234567890' }]);
  const node = nodeForConversation(history, conversation, 'n:7');
  assert.match(node.content, /\[redacted\]/);
  assert.doesNotMatch(node.content, /sk-12345678901234567890/);
});

test('events include handoffs and are bounded', t => {
  const { history, conversation } = fixture(t);
  conversation.handoffs.push({ from: 'claude', to: 'codex', at: 10, status: 'complete' });
  const events = eventsForConversation(history, conversation, 10);
  assert.ok(events.some(event => event.kind === 'handoff'));
  assert.ok(events.length <= 10);
});

test('context events use the summary index instead of scanning transcript bodies', t => {
  const history = {
    summaries(id, { limit }) {
      assert.equal(id, 'conversation');
      assert.equal(limit, 9);
      return [
        { seq: 5000, role: 'notice', text: 'Context compacted', compaction: { state: 'completed' } },
        { seq: 2500, role: 'notice', text: 'Context compacted', compaction: { state: 'completed' } },
      ];
    },
    iterate() { throw new Error('the event list must not scan transcript rows'); },
  };
  const conversation = { id: 'conversation', handoffs: [{ from: 'claude', to: 'codex', at: 10 }],
    childSettlements: [], contextEvents: [] };
  const events = eventsForConversation(history, conversation, 10);
  assert.deepEqual(events.map(event => event.seq), [null, 5000, 2500]);
});

test('a long transcript with no events does not parse message bodies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-context-events-long-'));
  t.after(() => removeTree(root));
  const history = new ConversationHistory(root);
  const conversation = { id: 'long', handoffs: [], childSettlements: [], contextEvents: [] };
  history.appendAll(conversation.id, Array.from({ length: 5000 }, (_, index) => ({
    seq: index + 1, role: index === 0 ? 'user' : 'assistant', text: 'row body ' + index,
  })));
  const parsed = history.metrics.parsedRows;
  assert.deepEqual(eventsForConversation(history, conversation, 20), []);
  assert.equal(history.metrics.parsedRows, parsed);
});
