'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachExternalNavigation } = require('../src/main/external-navigation');

function fixture(openExternal) {
  const contents = new EventEmitter();
  const opened = [], errors = [];
  contents.setWindowOpenHandler = handler => { contents.openWindow = handler; };
  attachExternalNavigation(contents, { openExternal: openExternal || (url => opened.push(url)), onError: error => errors.push(error.message) });
  function navigate(eventName, details, legacyURL) {
    const event = { ...details, prevented: false, preventDefault() { this.prevented = true; } };
    contents.emit(eventName, event, legacyURL);
    return event;
  }
  return { contents, opened, errors, navigate };
}

test('a PDF link replacing the app is cancelled and sent to the system browser once', () => {
  const { navigate, opened } = fixture();
  const url = 'https://item.taobao.com/item.htm?id=522572645353';
  assert.equal(navigate('will-frame-navigate', { url, isMainFrame: true }).prevented, false);
  assert.deepEqual(opened, []);
  assert.equal(navigate('will-navigate', { url, isMainFrame: true }).prevented, true);
  assert.deepEqual(opened, [url]);
});

test('same-frame PDF links also leave the preview in place', () => {
  const { navigate, opened } = fixture();
  const url = 'https://s.taobao.com/search?q=TCT40-16T';
  assert.equal(navigate('will-frame-navigate', { url, isMainFrame: false }).prevented, true);
  assert.deepEqual(opened, [url]);
});

test('new-tab links use the same external browser policy without creating an app window', () => {
  const { contents, opened } = fixture();
  for (const url of ['https://example.com/product', 'http://example.com/help', 'mailto:person@example.com'])
    assert.deepEqual(contents.openWindow({ url }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/product', 'http://example.com/help', 'mailto:person@example.com']);
});

test('local PDF and sandboxed document frames still load normally', () => {
  const { navigate, opened } = fixture();
  for (const url of ['file:///C:/outputs/report.pdf', 'file:///C:/outputs/report.pdf#page=2', 'about:blank', 'about:srcdoc', 'data:text/html,document', 'chrome-extension://pdf-viewer/index.html'])
    assert.equal(navigate('will-frame-navigate', { url, isMainFrame: false }).prevented, false, url);
  assert.deepEqual(opened, []);
});

test('non-web links cannot replace the workbench or launch system protocols', () => {
  const { contents, navigate, opened } = fixture();
  for (const url of ['javascript:alert(1)', 'file:///C:/other.pdf', 'data:text/html,other', 'ms-settings:display', 'not a URL']) {
    assert.equal(navigate('will-navigate', { url }).prevented, true, url);
    assert.deepEqual(contents.openWindow({ url }), { action: 'deny' });
  }
  assert.deepEqual(opened, []);
});

test('mail links open in the system mail handler without replacing the app', () => {
  const { navigate, opened } = fixture();
  assert.equal(navigate('will-navigate', { url: 'mailto:someone@example.com' }).prevented, true);
  assert.deepEqual(opened, ['mailto:someone@example.com']);
});

test('legacy navigation arguments still protect the app', () => {
  const { navigate, opened } = fixture();
  assert.equal(navigate('will-navigate', {}, 'https://example.com/legacy').prevented, true);
  assert.deepEqual(opened, ['https://example.com/legacy']);
});

test('external browser failures are reported without unhandled rejections or navigation', async () => {
  for (const openExternal of [() => { throw new Error('browser unavailable'); }, () => Promise.reject(new Error('browser unavailable'))]) {
    const { contents, navigate, errors } = fixture(openExternal);
    assert.equal(navigate('will-navigate', { url: 'https://example.com/' }).prevented, true);
    assert.deepEqual(contents.openWindow({ url: 'https://example.com/' }), { action: 'deny' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, ['browser unavailable', 'browser unavailable']);
  }
});
