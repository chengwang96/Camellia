'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planCompaction, takeFragment, summaryLimit } = require('../src/engines/compaction-plan');

test('retains recent complete interactions under an independent budget', () => {
  const rows = [
    { seq: 1, role: 'user', text: 'Old task' }, { seq: 2, role: 'tool', text: 'x'.repeat(5000) },
    { seq: 3, role: 'user', text: 'Recent task' }, { seq: 4, role: 'tool', text: 'Recent result' },
    { seq: 5, role: 'assistant', text: 'Recent answer' },
  ];
  const plan = planCompaction(rows, 12000);
  assert.deepEqual(plan.recent.map(row => row.sourceSeq), [3, 4, 5]);
  assert.deepEqual(plan.units.flat().map(row => row.sourceSeq), [1, 2]);
  assert.equal(planCompaction(rows, 500).recent.length, 0);
  assert.equal(rows[0].sourceSeq, undefined);
  assert.equal(summaryLimit(1000000), 12000);
  assert.equal(summaryLimit(9000), 3000);
});

test('packs complete tool interactions without splitting JSON or mutating the source', () => {
  const units = [[{ role: 'tool', text: 'call' }, { role: 'tool', text: 'result' }], [{ role: 'user', text: 'Next' }]];
  const limit = JSON.stringify({ history: units[0] }).length;
  const first = takeFragment(units, limit);
  assert.deepEqual(JSON.parse(first.text).history, units[0]);
  assert.deepEqual(first.remaining, [units[1]]);
  assert.equal(first.splitRecords, 0);
  assert.equal(units.length, 2);
});

test('oversized records become lossless JSON fragments with stable offsets and attachments', () => {
  const original = '中文😀\\\"\n'.repeat(1000);
  let remaining = [[{ role: 'tool', text: original, sourceSeq: 7, attachments: [{ path: 'local.txt' }] }]];
  let restored = '', count = 0;
  while (remaining.length) {
    assert.ok(++count < 100);
    const result = takeFragment(remaining, 700);
    assert.ok(result.text.length <= 700);
    const row = JSON.parse(result.text).history[0];
    assert.equal(row.sourceSeq, 7);
    assert.equal(row.fragment.offset, restored.length);
    assert.equal(row.fragment.total, original.length);
    assert.equal(row.attachments[0].path, 'local.txt');
    assert.ok(!/[\uD800-\uDBFF]$/.test(row.text));
    restored += row.text;
    remaining = result.remaining;
  }
  assert.equal(restored, original);
});

test('oversized metadata fails explicitly instead of silently dropping history', () => {
  assert.throws(() => takeFragment([[{ text: 'small', attachments: [{ path: 'x'.repeat(2000) }] }]], 500), /metadata too large/);
});
