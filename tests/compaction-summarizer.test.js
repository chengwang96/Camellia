'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompactionSummarizer } = require('../src/api/compaction-summarizer');

test('summary overflow classification uses the complete structured provider response', async () => {
  for (const [status, body, overflow] of [
    [400, { error: { code: 'input_too_long' } }, true],
    [422, { error: { message: 'Details: ' + 'x'.repeat(300) + '. Input is too long.' } }, true],
    [400, { error: { message: 'max_tokens is not supported' } }, false],
    [429, { error: { code: 'context_length_exceeded' } }, false],
    [400, { error: { message: 'Request too large on tokens per min (TPM). Maximum context length is 1000000 tokens.' } }, false],
  ]) {
    const summarizer = createCompactionSummarizer({ getRoute: () => ({ baseUrl: 'https://local.invalid', authToken: 'local-only' }),
      fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify(body) }) });
    await assert.rejects(summarizer.run({ model: 'fixture', system: 'Summarize', user: 'History', maxTokens: 128 }), error => error.overflow === overflow);
  }
});
