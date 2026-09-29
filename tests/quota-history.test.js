'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordQuota } = require('../src/engines/quota-history');
test('quota observations preserve actual values, coalesce per minute and expire after 30 days', () => {
  const limits = { group: { primary: { usedPercent: 25, windowDurationMins: 300 }, secondary: { usedPercent: 70 } } };
  let rows = recordQuota([], limits, 60000);
  assert.equal(rows[0].windows[0].usedPercent, 25);
  rows = recordQuota(rows, { group: { primary: { usedPercent: 40 } } }, 61000);
  assert.equal(rows.length, 1); assert.equal(rows[0].windows[0].usedPercent, 40);
  rows = recordQuota(rows, limits, 120000); assert.equal(rows.length, 2);
  assert.equal(recordQuota(rows, {}, 130000).length, 2);
  assert.equal(recordQuota(rows, limits, 32 * 86400000).length, 1);
});
