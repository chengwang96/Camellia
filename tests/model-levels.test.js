'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { levelsFor } = require('../src/shared/model-levels');

test('API-routed reasoning levels widen for GPT-5.5+ and stay conservative otherwise', () => {
  assert.deepEqual(levelsFor('openai/openai/gpt-6-astra'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(levelsFor('openai/openai/gpt-5.6-sol'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(levelsFor('GPT-5.5-Codex'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(levelsFor('gpt-5.1'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor('o4-mini'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor('deepseek-v4.1-flash'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor('kimi-k3'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor(''), ['low', 'medium', 'high']);
});
