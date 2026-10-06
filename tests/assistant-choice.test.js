'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/renderer/shared/assistant-choice');

test('completed plain-text choices become a reply prompt', () => {
  const text = '正式 APK 需要长期沿用同一把签名密钥。你已有 Camellia Android 的 release keystore 吗？若有，请提供文件路径和别名；若没有，我可以在本机生成并配置。\n\n'
    + '- 没有，请在本机生成（推荐）\n- 已有，稍后提供路径和别名\n\n2026-10-05 03:32（香港时间）';
  assert.deepEqual(parse(text), { question: '正式 APK 需要长期沿用同一把签名密钥。你已有 Camellia Android 的 release keystore 吗？若有，请提供文件路径和别名；若没有，我可以在本机生成并配置。',
    options: ['没有，请在本机生成（推荐）', '已有，稍后提供路径和别名'] });
  assert.deepEqual(parse('Which format should I use?\n\n1. CSV\n2. JSON'), { question: 'Which format should I use?', options: ['CSV', 'JSON'] });
});

test('ordinary lists and completed work do not create reply prompts', () => {
  assert.equal(parse('Here are the changes:\n\n- Fixed the build\n- Updated the tests'), null);
  assert.equal(parse('Which format?\n\n- CSV\n- JSON\n\nI saved the CSV file.'), null);
  assert.equal(parse('Which format?\n\n```text\n- CSV\n- JSON\n```'), null);
  assert.equal(parse('Which format?\n\n- CSV'), null);
});
