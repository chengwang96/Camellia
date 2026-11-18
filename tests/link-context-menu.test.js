'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachLinkContextMenu, webLink } = require('../src/main/link-context-menu');
const { translate } = require('../src/shared/i18n');

function createHarness(language = 'zh-CN', openExternal = null) {
  const contents = new EventEmitter();
  const templates = [];
  const popups = [];
  const copied = [];
  const opened = [];
  const errors = [];
  attachLinkContextMenu(contents, {
    Menu: { buildFromTemplate: template => {
      templates.push(template);
      return { popup: options => popups.push(options) };
    } },
    clipboard: { writeText: value => copied.push(value) },
    openExternal: openExternal || (async value => opened.push(value)),
    uiText: text => translate(text, language),
    onError: error => errors.push(error),
  });
  return { contents, templates, popups, copied, opened, errors, language,
    open: overrides => contents.emit('context-menu', {}, {
      isEditable: false, mediaType: 'none', linkURL: 'https://pubpeer.com/publications/abc',
      linkText: 'PubPeer 页面',
      frame: {}, ...overrides,
    }) };
}

test('web link menu opens the browser, copies the label and URL, and follows the current language', async () => {
  const harness = createHarness();
  const frame = {};
  harness.open({ frame });
  assert.deepEqual(harness.templates[0].map(item => item.label), ['在浏览器中打开', '复制文本', '复制链接']);
  assert.equal(harness.popups[0].frame, frame);
  harness.templates[0][0].click();
  harness.templates[0][1].click();
  harness.templates[0][2].click();
  await Promise.resolve();
  assert.deepEqual(harness.opened, ['https://pubpeer.com/publications/abc']);
  assert.deepEqual(harness.copied, ['PubPeer 页面', 'https://pubpeer.com/publications/abc']);
  assert.deepEqual(harness.errors, []);

  const english = createHarness('en');
  english.open();
  assert.deepEqual(english.templates[0].map(item => item.label), ['Open in browser', 'Copy text', 'Copy link']);
});

test('link menu ignores editing, images, plain text and non-web protocols', () => {
  const harness = createHarness();
  for (const overrides of [
    { isEditable: true },
    { mediaType: 'image' },
    { linkURL: '' },
    { linkURL: 'mailto:hello@example.com' },
    { linkURL: 'file:///D:/Code/Camellia/README.md' },
    { linkURL: 'javascript:alert(1)' },
    { linkURL: 'https://user:secret@example.com/private' },
    { linkURL: 'not a URL' },
  ]) harness.open(overrides);
  assert.equal(harness.templates.length, 0);
  assert.equal(harness.popups.length, 0);
});

test('link URL normalization preserves query strings and rejects credentials', () => {
  assert.equal(webLink('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(webLink('HTTP://EXAMPLE.COM/path'), 'http://example.com/path');
  assert.equal(webLink('https://user:pass@example.com/'), null);
  assert.equal(webLink('ftp://example.com/file'), null);
  assert.equal(webLink(''), null);
});

test('copy text is disabled when the link has no visible label', () => {
  const harness = createHarness();
  harness.open({ linkText: '' });
  assert.equal(harness.templates[0][1].label, '复制文本');
  assert.equal(harness.templates[0][1].enabled, false);
  assert.equal(harness.templates[0][2].enabled, undefined);
});

test('browser failures are reported without escaping the menu click', async () => {
  const error = new Error('no browser');
  const harness = createHarness('en', () => { throw error; });
  harness.open();
  assert.doesNotThrow(() => harness.templates[0][0].click());
  assert.deepEqual(harness.errors, [error]);
});
