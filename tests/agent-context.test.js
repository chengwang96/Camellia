'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDelegationPacket, promptWithPacket, settlementFor, recordSettlement, PACKET_MAX_CHARS,
} = require('../src/engines/agent-context');

test('delegation packets are bounded, quoted, and preserve the current request', () => {
  const rows = [
    { seq: 1, role: 'user', text: 'Earlier request' },
    { seq: 2, role: 'assistant', text: 'Earlier answer', artifacts: [{ path: '/tmp/a.js' }] },
    { seq: 3, role: 'user', text: 'Parent request' },
  ];
  const manager = {
    historyRows(parent, { reverse }) {
      return (reverse ? rows.slice().reverse() : rows)[Symbol.iterator]();
    },
  };
  const packet = buildDelegationPacket(manager, { id: 'parent', cwd: '/tmp/workspace' },
    { userSeq: 3, displayText: 'Parent request' });
  assert.equal(packet.version, 1);
  assert.equal(packet.parentConversationId, 'parent');
  assert.equal(packet.parentSeq, 3);
  assert.equal(packet.goal, 'Parent request');
  assert.deepEqual(packet.files, ['/tmp/a.js']);
  assert.ok(JSON.stringify(packet).length <= PACKET_MAX_CHARS);
  const prompt = promptWithPacket(packet, 'Child task');
  assert.match(prompt, /<delegation_context>/);
  assert.match(prompt, /historical context/);
  assert.match(prompt, /Current request:\nChild task/);
});

test('settlements retain status, evidence, files and test commands', () => {
  const settlement = settlementFor({ id: 'child', seq: 9 }, { requestId: 'request-1' }, {
    subtype: 'success', result: 'Ran node --test tests/context.test.js\nAll good',
    artifacts: [{ path: '/tmp/result.txt' }],
  });
  assert.equal(settlement.status, 'completed');
  assert.equal(settlement.childConversationId, 'child');
  assert.deepEqual(settlement.filesChanged, ['/tmp/result.txt']);
  assert.deepEqual(settlement.tests, ['node --test tests/context.test.js']);
  assert.deepEqual(settlement.evidence, [{ conversationId: 'child', seq: 9 }]);
});

test('recording a settlement updates both child and parent metadata', () => {
  const child = { id: 'child', seq: 9 };
  const parent = { id: 'parent', currentEngine: 'codex' };
  const manager = {
    items: new Map([['child', child], ['parent', parent]]),
    get(id) { return id === 'parent' ? parent : child; },
    save() {},
    onEvent() {},
    subagentView() { return []; },
    log() {},
  };
  const settlement = recordSettlement(manager, 'parent', child, { requestId: 'request-1' },
    { subtype: 'success', result: 'Done' });
  assert.equal(child.settlement, settlement);
  assert.equal(parent.childSettlements.length, 1);
  assert.equal(parent.childSettlements[0].summary, 'Done');
});
