'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translate } = require('../src/shared/i18n.js');

test('web source cards are translated instead of falling back to English', () => {
  assert.equal(translate('Search failed', 'zh-CN'), '搜索失败');
  assert.equal(translate('Page fetch failed', 'zh-CN'), '页面抓取失败');
  assert.equal(translate('Local fetch', 'zh-CN'), '本机抓取');
  assert.equal(translate('DeepSeek fetch', 'zh-CN'), 'DeepSeek 抓取');
});

test('source counts keep their numeric slot', () => {
  assert.equal(translate('1 source', 'zh-CN'), '1 条来源');
  assert.equal(translate('{0} sources', 'zh-CN').replace('{0}', 4), '4 条来源');
});

test('fetch detail strings keep their placeholders and truncation warning', () => {
  assert.equal(translate('Fell back from {0}', 'zh-CN').replace('{0}', 'deepseek'), '已从 deepseek 回退');
  assert.equal(translate('{0} characters read', 'zh-CN').replace('{0}', 4499), '已读取 4499 个字符');
  assert.equal(translate('Content was truncated by the fetcher.', 'zh-CN'), '抓取时内容已被截断。');
  assert.equal(translate('The page returned no readable text.', 'zh-CN'), '该页面没有可读正文。');
});

test('the English UI keeps the original wording', () => {
  assert.equal(translate('1 source', 'en'), '1 source');
  assert.equal(translate('Local fetch', 'en'), 'Local fetch');
});
