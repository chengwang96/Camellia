'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { usageDetails, requestUsageDetails } = require('../src/renderer/chat/turn-details');

test('turn usage counts uncached input, cache reads, cache writes and output exactly once', () => {
  const result = usageDetails({ input_tokens: 1000, cache_read_input_tokens: 7500,
    cache_creation_input_tokens: 1500, output_tokens: 2000 });
  assert.equal(result.total, 12000);
  assert.equal(result.cacheHit, 75);
});

test('omitted cache accounting remains unknown, while reported zero is visible', () => {
  const unknown = usageDetails({ input_tokens: 11861, output_tokens: 140 });
  assert.equal(unknown.total, 12001);
  assert.equal(unknown.cacheRead, null);
  assert.equal(unknown.cacheWrite, null);
  assert.equal(unknown.cacheHit, null);
  const reported = usageDetails({ input_tokens: 11861, output_tokens: 140,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(reported.total, 12001);
  assert.equal(reported.cacheHit, 0);
  assert.equal(reported.cacheRead, 0);
  assert.equal(reported.cacheWrite, 0);
  assert.equal(usageDetails({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }).cacheHit, 0);
});

test('unreported or invalid usage does not produce a zero-token claim', () => {
  for (const input of [null, {}, { input_tokens: NaN, output_tokens: -1 }, { input_tokens: '100' }]) {
    assert.equal(usageDetails(input), null);
  }
});

test('request usage keeps main, background and native child totals separate', () => {
  const details = requestUsageDetails({
    main: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    background: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 1 },
    children: { tokens: 60, tasks: 1 }, total: 1040,
  });
  assert.equal(details.total, 1040);
  assert.equal(details.main.total, 920);
  assert.equal(details.background.total, 60);
  assert.equal(details.backgroundTurns, 1);
  assert.equal(details.childTokens, 60);
  assert.equal(details.childTasks, 1);
  assert.equal(details.model.input, 150);
  assert.equal(details.model.output, 30);
  assert.equal(details.model.cacheRead, 800);
  assert.equal(details.model.total, 980);
  assert.equal(details.breakdown, true);
});

test('a request with no background or child work keeps the ordinary turn view', () => {
  const details = requestUsageDetails({
    main: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    background: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 0 },
    children: { tokens: 0, tasks: 0 }, total: 120,
  });
  assert.equal(details.breakdown, false);
  assert.equal(details.total, 120);
});
