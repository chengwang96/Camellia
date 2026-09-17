'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { translate, normalizeLanguage } = require('../src/shared/i18n');
const { createHarness } = require('./claude-harness.cjs');

test('UI translations preserve values and fall back to English for unknown copy', () => {
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(normalizeLanguage('fr'), 'en');
  assert.equal(translate('  Settings\n', 'zh-CN'), '  设置\n');
  assert.equal(translate('Download & open Codex', 'zh-CN'), '下载并进入 Codex');
  assert.equal(translate('Providers: 2 · Keys: 3', 'zh-CN'), '供应商：2 · Key：3');
  assert.equal(translate('gpt-5.4', 'zh-CN'), 'gpt-5.4');
  assert.equal(translate('constructor', 'zh-CN'), 'constructor');
  assert.equal(translate('Recommended · 5 minutes', 'zh-CN'), '推荐 · 5 分钟');
  assert.equal(translate('270 seconds shared across each engine’s 3 tasks · 250K tokens per task attempt', 'zh-CN'), '每个引擎的 3 个任务共用 270 秒 · 每次任务尝试 250K Token');
  assert.equal(translate('Ready', 'en'), 'Ready');
});

test('language preference persists, broadcasts, and preserves other settings', () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').language, 'en');
    assert.equal(first.call('workbench-save-settings', { language: 'zh-CN', theme: 'dark', autoRefreshBalances: false }).ok, true);
    assert.ok(first.events.some(event => event.channel === 'dsh:language-changed' && event.data === 'zh-CN'));
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').language, 'zh-CN');
    assert.equal(reopened.call('workbench-settings').theme, 'dark');
    assert.equal(reopened.call('workbench-settings').autoRefreshBalances, false);
    // Older callers that do not send a language must retain the saved choice.
    assert.equal(reopened.call('workbench-save-settings', { theme: 'light' }).ok, true);
    assert.equal(reopened.call('workbench-settings').language, 'zh-CN');
    assert.equal(reopened.call('workbench-save-settings', { language: 'en' }).ok, true);
    assert.equal(reopened.call('workbench-settings').language, 'en');
  } finally { first.cleanup(); }
});
