'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROVIDERS, activeSessionId, canonicalSessionUrl, navigationAllowed,
  normalizeProfile, normalizeSessions, providerFor,
} = require('../src/shared/web-providers.js');

test('web providers use separate persistent sessions and official entry pages', () => {
  assert.equal(providerFor('deepseek').startUrl, 'https://chat.deepseek.com/');
  assert.equal(providerFor('kimi').startUrl, 'https://www.kimi.com/');
  assert.notEqual(PROVIDERS.deepseek.partition, PROVIDERS.kimi.partition);
  assert.match(PROVIDERS.deepseek.partition, /^persist:/);
  assert.match(PROVIDERS.kimi.partition, /^persist:/);
  for (const provider of [PROVIDERS.deepseek, PROVIDERS.kimi]) {
    assert.ok(provider.layout.readySelectors.length > 0);
  }
  assert.equal(PROVIDERS.deepseek.webRTCIPHandlingPolicy, undefined);
  assert.equal(PROVIDERS.kimi.webRTCIPHandlingPolicy, 'disable_non_proxied_udp');
  assert.equal(providerFor('unknown'), null);
});

test('navigation stays on each provider and its authentication domains', () => {
  assert.equal(navigationAllowed(PROVIDERS.deepseek, 'https://chat.deepseek.com/a/chat/s/abc'), true);
  assert.equal(navigationAllowed(PROVIDERS.deepseek, 'https://account.deepseek.com/sign-in'), true);
  assert.equal(navigationAllowed(PROVIDERS.deepseek, 'https://www.kimi.com/chat/abc'), false);
  assert.equal(navigationAllowed(PROVIDERS.kimi, 'https://www.kimi.com/chat/abc'), true);
  assert.equal(navigationAllowed(PROVIDERS.kimi, 'https://auth.kimi.com/login'), true);
  assert.equal(navigationAllowed(PROVIDERS.kimi, 'https://accounts.google.com/o/oauth2/auth'), true);
  assert.equal(navigationAllowed(PROVIDERS.kimi, 'http://www.kimi.com/chat/abc'), false);
  assert.equal(navigationAllowed(PROVIDERS.kimi, 'https://kimi.com.evil.example/chat/abc'), false);
  assert.equal(navigationAllowed(PROVIDERS.kimi, 'javascript:alert(1)'), false);
});

test('web history URLs are canonicalized and deduplicated without query strings', () => {
  const provider = PROVIDERS.deepseek;
  const url = canonicalSessionUrl(provider, 'https://chat.deepseek.com/a/chat/s/abc?token=private#fragment');
  assert.equal(url, 'https://chat.deepseek.com/a/chat/s/abc');
  assert.equal(activeSessionId(provider, url), 'abc');
  const sessions = normalizeSessions(provider, [
    { url: 'https://chat.deepseek.com/a/chat/s/abc?first=1', title: ' First ' },
    { url: 'https://chat.deepseek.com/a/chat/s/abc?second=2', title: 'Duplicate' },
    { url: 'https://example.com/a/chat/s/other', title: 'Not DeepSeek' },
    { url: 'https://chat.deepseek.com/a/chat/s/with space', title: 'Second' },
  ]);
  assert.deepEqual(sessions, [
    { id: 'abc', title: 'First', url: 'https://chat.deepseek.com/a/chat/s/abc' },
    { id: 'with%20space', title: 'Second', url: 'https://chat.deepseek.com/a/chat/s/with%20space' },
  ]);
});

test('web layout profiles reject executable or network-loading CSS', () => {
  const provider = PROVIDERS.kimi;
  assert.ok(normalizeProfile(provider, {
    historyAnchorSelector: 'a.history', titleSelector: '.title', css: '[data-hidden]{display:none}',
  }));
  assert.equal(normalizeProfile(provider, {
    historyAnchorSelector: 'a.history', css: 'body{background:url(https://tracker.example/p)}',
  }), null);
  assert.equal(normalizeProfile(provider, {
    historyAnchorSelector: 'a.history', css: '@import "https://tracker.example/style.css"',
  }), null);
  assert.equal(normalizeProfile(provider, {
    historyAnchorSelector: '', css: '',
  }), null);
});

test('the mobile remote gateway does not expose the desktop Web surface', () => {
  for (const file of ['preload.js', 'desktop.js', 'commands.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/main/remote', file), 'utf8');
    assert.doesNotMatch(source, /web[-_ ]?surface|webSurface/i, file);
  }
});
