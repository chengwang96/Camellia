'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { levelsFor, thinkingFor, normalizeThinking, labelFor } = require('../src/shared/model-levels');

test('models without reasoning metadata use the three-level fallback regardless of their name', () => {
  for (const model of ['openai/gpt-6-astra', 'GPT-5.5-Codex', 'gpt-5.6-luna', 'glm-5.3', 'deepseek-v4.1-flash', 'kimi-k3', '']) {
    assert.deepEqual(levelsFor(model), ['low', 'medium', 'high']);
  }
});

test('reported Codex catalog efforts take precedence over the fallback', () => {
  const catalog = require('../src/engines/codex-metadata/models.json').models;
  for (const model of catalog) {
    const effort = (model.supported_reasoning_levels || []).map(level => level.effort);
    if (!effort.length) continue;
    assert.deepEqual(levelsFor(model.slug, { thinking: { values: effort } }), effort);
  }
});

test('thinking metadata preserves exact named levels, booleans and valid defaults', () => {
  const glm = { thinking: { values: ['low', 'high', 'max'], default: 'max' } };
  assert.deepEqual(levelsFor('glm-5.3', glm), ['low', 'high', 'max']);
  assert.deepEqual(thinkingFor('glm-5.3', glm), glm.thinking);
  const deepseek = { thinking: { values: ['none', 'low', 'high', 'max'], default: 'high' } };
  assert.deepEqual(levelsFor('deepseek-flash', deepseek), ['none', 'low', 'high', 'max']);
  assert.equal(labelFor('none', 'deepseek-flash', deepseek), 'Off');
  const toggle = { thinking: { values: [false, true], default: true } };
  assert.deepEqual(levelsFor('kimi-k2.6', toggle), ['none', 'high']);
  assert.equal(labelFor('none', 'kimi-k2.6', toggle), 'Off');
  assert.equal(labelFor('high', 'kimi-k2.6', toggle), 'On');
  assert.deepEqual(levelsFor('no-thinking', { thinking: { values: [false], default: false } }), ['none']);
  assert.deepEqual(levelsFor('explicit-empty', { thinking: { values: [] } }), []);
  assert.deepEqual(normalizeThinking({ values: ['max', 'max'], default: 'medium' }), { values: ['max'] });
  for (const values of [null, [''], ['low', 4], [' invalid '], [true, {}], new Array(33).fill('low')]) {
    assert.equal(normalizeThinking({ values }), undefined);
  }
});

test('pooled reasoning metadata intersects active reported routes, leaving unknown providers unknown', () => {
  const route = (thinking, enabled = true, keyEnabled = true) => ({ enabled, keys: [{ enabled: keyEnabled }], models: [{ id: 'glm-5.3', thinking }] });
  const catalog = { enabled: true, providers: [
    route({ values: ['low', 'high', 'max'], default: 'max' }),
    route(undefined),
    route({ values: ['medium'] }, false),
    route({ values: ['medium'] }, true, false),
  ] };
  assert.deepEqual(levelsFor('glm-5.3:cloud', catalog), ['low', 'high', 'max']);
  catalog.providers.push(route({ values: ['high', 'max'], default: 'high' }));
  assert.deepEqual(thinkingFor('glm-5.3', catalog), { values: ['high', 'max'] });
  const reported = { enabled: true, modelThinking: { 'glm-5.3': { values: ['high', 'max'], default: 'max' } } };
  assert.deepEqual(levelsFor('glm-5.3:cloud', reported), ['high', 'max']);
  reported.enabled = false;
  assert.deepEqual(levelsFor('glm-5.3', reported), ['low', 'medium', 'high']);
  catalog.providers.push(route({ values: [] }));
  assert.deepEqual(levelsFor('glm-5.3', catalog), []);
  catalog.enabled = false;
  assert.deepEqual(levelsFor('glm-5.3', catalog), ['low', 'medium', 'high']);
});

test('quick-switch settings use fetched levels, keep subscription efforts and reject stale selections', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings/api-settings.js'), 'utf8');
  const sandbox = { window: { CamelliaModelLevels: require('../src/shared/model-levels') },
    Option: function (text, value) { this.text = text; this.value = value; this.dataset = {}; } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function quickSwitchLadder('), source.indexOf('async function saveQuickSwitch(')), sandbox);
  const select = { options: [], replaceChildren() { this.options = []; }, add(option) { this.options.push(option); } };
  const router = { enabled: true, modelThinking: { 'glm-5.3': { values: ['low', 'high', 'max'], default: 'max' } } };
  sandbox.fillQuickSwitchLevels(select, 'claude', 'glm-5.3', 'medium', null, router);
  assert.deepEqual(select.options.map(option => option.value), ['', 'low', 'high', 'max']);
  assert.equal(select.value, '');
  const account = { models: [{ id: 'glm-5.3', supportedReasoningEfforts: ['high'] }] };
  sandbox.fillQuickSwitchLevels(select, 'codex', 'glm-5.3', 'high', account, router);
  assert.deepEqual(select.options.map(option => option.value), ['', 'high']);
  assert.equal(select.value, 'high');
  account.models[0].supportedReasoningEfforts = [];
  sandbox.fillQuickSwitchLevels(select, 'codex', 'glm-5.3', '', account, router);
  assert.deepEqual(select.options.map(option => option.value), ['']);
  router.modelThinking['kimi-k2.6'] = { values: [false, true] };
  sandbox.fillQuickSwitchLevels(select, 'pi', 'kimi-k2.6', 'none', null, router);
  assert.deepEqual(select.options.map(option => option.text), ['Not configured', 'Off', 'On']);
});
