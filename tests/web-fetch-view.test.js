'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
global.document = {};
require('../src/renderer/shared/chat-controls.js');
const { webFetchView, webSearchView } = window.CamelliaChatControls;

test('a fetched page exposes its title, final URL, site and text', () => {
  const view = webFetchView('camellia_web_fetch', {
    ok: true,
    provider: 'deepseek',
    url: 'https://example.com/start',
    final_url: 'https://www.example.com/docs/page',
    title: 'Getting started',
    content: '# Hello\n\nBody text.',
    truncated: false,
  });
  assert.equal(view.title, 'Getting started');
  assert.equal(view.url, 'https://www.example.com/docs/page');
  assert.equal(view.site, 'example.com');
  assert.equal(view.provider, 'deepseek');
  assert.equal(view.content, '# Hello\n\nBody text.');
  assert.equal(view.truncated, false);
});

test('a local fallback is retained so the card can explain it', () => {
  const view = webFetchView('camellia_web_fetch', {
    ok: true,
    provider: 'local',
    url: 'https://example.com/page',
    title: 'Blocked page',
    content: 'Recovered locally',
    fallback_from: 'deepseek',
    fallback_reason: 'web_page_unavailable',
    connection_mode: 'auto',
  });
  assert.equal(view.provider, 'local');
  assert.equal(view.fallbackFrom, 'deepseek');
  assert.equal(view.fallbackReason, 'web_page_unavailable');
  assert.equal(view.connectionMode, 'auto');
});

test('a failed fetch keeps its code and fallback detail', () => {
  const view = webFetchView('camellia_web_fetch', {
    ok: false,
    error: 'HTTP 403 · blocked',
    code: 'web_fetch_blocked',
    url: 'https://example.com/page',
    fallback_from: 'deepseek',
    fallback_reason: 'web_fetch_blocked',
  });
  assert.equal(view.error, 'HTTP 403 · blocked');
  assert.equal(view.code, 'web_fetch_blocked');
  assert.equal(view.fallbackFrom, 'deepseek');
});

test('non-fetch tools and malformed output are ignored', () => {
  assert.equal(webFetchView('camellia_web_search', { ok: true }), null);
  assert.equal(webFetchView('camellia_web_fetch', 'not json'), null);
});

test('the native MCP envelope is unwrapped before the page card is built', () => {
  const payload = {
    ok: true,
    provider: 'deepseek',
    url: 'https://www.electronjs.org/docs/latest/api/safe-storage',
    title: 'safeStorage | Electron',
    content: '# safeStorage\n\nBody',
    truncated: false,
  };
  // Codex and other harnesses return the tool result as MCP content text.
  const envelope = JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
  const view = webFetchView('camellia_web_fetch', envelope);
  assert.equal(view.title, 'safeStorage | Electron');
  assert.equal(view.site, 'electronjs.org');
  assert.equal(view.content, '# safeStorage\n\nBody');
});

test('a search result inside the MCP envelope still becomes structured sources', () => {
  const envelope = JSON.stringify({
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        results: [
          { title: 'First', url: 'https://example.com/a', summary: 'one' },
          { title: 'Second', url: 'https://example.org/b', summary: 'two' },
        ],
      }),
    }],
  });
  const view = webSearchView('camellia_web_search', envelope);
  assert.equal(view.results.length, 2);
  assert.equal(view.results[1].title, 'Second');
});

test('a JSON-encoded MCP envelope still renders its fetched page', () => {
  const envelope = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({
    ok: true, url: 'https://example.com/page', title: 'Nested page', content: 'Body',
  }) }] });
  const view = webFetchView('camellia_web_fetch', JSON.stringify(envelope));
  assert.equal(view?.title, 'Nested page');
});
