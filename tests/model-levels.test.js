'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { levelsFor } = require('../src/shared/model-levels');

test('API-routed reasoning levels widen for GPT-5.5+ and stay conservative otherwise', () => {
  assert.deepEqual(levelsFor('openai/openai/gpt-6-astra'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(levelsFor('openai/openai/gpt-5.6-sol'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  // Not every model exposes every level: 5.5 stops at xhigh and the luna tier
  // has no ultra.
  assert.deepEqual(levelsFor('GPT-5.5-Codex'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(levelsFor('gpt-5.6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(levelsFor('gpt-5.1'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor('o4-mini'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor('deepseek-v4.1-flash'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor('kimi-k3'), ['low', 'medium', 'high']);
  assert.deepEqual(levelsFor(''), ['low', 'medium', 'high']);
});

test('model ladders stay in step with the Codex catalog', () => {
  const catalog = require('../src/engines/codex-metadata/models.json').models;
  for (const model of catalog) {
    const effort = (model.supported_reasoning_levels || []).map(level => level.effort);
    if (!effort.length) continue;
    assert.deepEqual(levelsFor(model.slug), effort,
      `levelsFor(${model.slug}) must match its catalog reasoning levels`);
  }
});
