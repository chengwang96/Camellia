'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mobileTurnDetails } = require('../src/shared/mobile-turn-details');
const { usageDetails } = require('../src/renderer/chat/turn-details');

test('mobile accounting carries the recorded model and desktop token buckets without private fields', () => {
  const details = mobileTurnDetails({ role: 'assistant', turnMetrics: { duration_ms: 1250, model: 'recorded-model', total_cost_usd: 0.01, apiKey: 'private' },
    usage: { input_tokens: 1000, cache_read_input_tokens: 7500, cache_creation_input_tokens: 1500, output_tokens: 2000, secret: 'private' },
    lastCallUsage: { input_tokens: 99999 } });
  assert.deepEqual(details, { state: 'complete', duration_ms: 1250, model: 'recorded-model', total_cost_usd: 0.01,
    usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 7500, cache_creation_input_tokens: 1500 } });
  assert.equal(usageDetails(details.usage).total, 12000);
  assert.equal(usageDetails(details.usage).cacheHit, 75);
});

test('missing, zero and invalid accounting remain distinct on phones', () => {
  assert.equal(mobileTurnDetails({ role: 'assistant', lastCallUsage: { input_tokens: 2000 } }), null);
  assert.equal(mobileTurnDetails({ role: 'user', usage: { input_tokens: 100 } }), null);
  assert.equal(mobileTurnDetails({ role: 'assistant', usage: { input_tokens: '1', output_tokens: -2 } }), null);
  assert.deepEqual(mobileTurnDetails({ role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } }),
    { state: 'complete', usage: { input_tokens: 0, output_tokens: 0 } });
  const details = mobileTurnDetails({ role: 'assistant', turnMetrics: { duration_ms: NaN, model: '', total_cost_usd: -1 },
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: Infinity } });
  assert.deepEqual(details, { state: 'complete', usage: { input_tokens: 20, output_tokens: 5 } });
  assert.equal(usageDetails(details.usage).cacheHit, null);
});

test('stopped and failed turns retain accounting without a success claim', () => {
  for (const [result, state] of [[{ subtype: 'stopped' }, 'stopped'], [{ is_error: true }, 'error'], [{ subtype: 'error_max_turns' }, 'error']]) {
    const details = mobileTurnDetails({ role: 'assistant', runResult: { ...result, duration_ms: 5000, usage: { output_tokens: 42 } } });
    assert.deepEqual(details, { state, duration_ms: 5000, usage: { output_tokens: 42 } });
  }
});
