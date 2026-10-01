'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { contextOverflow, contextOverflowText } = require('../src/shared/context-overflow');

// Real provider wordings that mean "this request is over a context limit".
const overflow = [
  'maximum context length is 8192 tokens',
  "This model's maximum context length is 16385 tokens. However, your messages resulted in 20000 tokens.",
  'Request failed: context_length_exceeded, maximum context length reached',
  'Invalid request: context length exceeds the window',
  'Internal error: turn failed: pi-ai detected context overflow',
  'The input token count (250000) exceeds the maximum number of tokens allowed (1048576).',
  'Input token count exceeds the maximum number of tokens.',
  'Your request exceeded the maximum input length.',
  'This model supports at most 1048576 input tokens.',
  'Input is too long.',
  'prompt is too long: 300000 tokens > 200000 maximum',
  'The request is invalid: prompt token count of 200000 exceeds the limit of 128000',
  'Input is longer than the model context length.',
  'range of input length should be [1, 1048576]',
  'Request payload size exceeds the limit: 1048576 bytes',
  'Input exceeds the maximum length of 1048576 characters.',
  'too many tokens',
  'The request is too large for the model',
];

// Similar-looking messages that are not context errors: billing/rate limits, a
// declared window, an output budget, or ordinary usage reporting. A false
// positive here would spend a summary request the provider never asked for.
const unrelated = [
  'Request too large for model gpt-4o in organization org-x on tokens per min (TPM): Limit 10000, Used 20000',
  'Maximum tokens per request: 4096',
  'max_tokens is the output budget for this turn',
  'context window: 200000 tokens',
  'The assistant used 12345 tokens in this reply.',
  'Token usage: 5000 input, 800 output',
  'Please increase your rate limit quota.',
  'Compaction summary request limit reached',
  'Connection failed or timed out',
];

test('context overflow recognizes provider wordings', () => {
  for (const message of overflow) {
    assert.ok(contextOverflowText(message), message);
    assert.equal(contextOverflow({ is_error: true, result: message }), true, message);
  }
});

test('context overflow ignores unrelated provider errors', () => {
  for (const message of unrelated) {
    assert.ok(!contextOverflowText(message), message);
    assert.equal(contextOverflow({ is_error: true, result: message }), false, message);
  }
});

test('context overflow requires an error result', () => {
  assert.equal(contextOverflow({ result: 'maximum context length is 8192 tokens' }), false);
  assert.equal(contextOverflow({ is_error: false, result: 'maximum context length is 8192 tokens' }), false);
  assert.equal(contextOverflow({ is_error: true, result: '' }), false);
});
