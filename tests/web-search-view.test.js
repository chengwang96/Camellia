'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
global.document = {};
require('../src/renderer/shared/chat-controls.js');
const { webSearchView, sourceRegistry, sourceKey } = window.CamelliaChatControls;

test('web search results are deduplicated, numbered and given a site label', () => {
  const view = webSearchView('camellia_web_search', {
    ok: true,
    provider: 'deepseek',
    results: [
      { title: 'First', url: 'https://www.example.com/a', summary: 'one', date: '2026-01-02' },
      { title: 'Duplicate', url: 'https://www.example.com/a', summary: 'ignored' },
      { title: 'Second', url: 'https://example.org/b', summary: 'two' },
    ],
  });
  assert.equal(view.error, '');
  assert.equal(view.provider, 'deepseek');
  assert.deepEqual(view.results.map(row => [row.index, row.title, row.site]), [
    [1, 'First', 'example.com'],
    [2, 'Second', 'example.org'],
  ]);
  assert.equal(view.results[0].date, '2026-01-02');
  assert.equal(view.results[1].summary, 'two');
});

test('web search output accepts a JSON string and drops invalid rows', () => {
  const view = webSearchView('camellia_web_search', JSON.stringify({
    ok: true,
    results: [
      null,
      { title: 'No URL' },
      { title: 'Bad URL', url: 'not a url' },
      { title: 'Good', url: 'https://example.net/page' },
    ],
    truncated: true,
  }));
  assert.deepEqual(view.results.map(row => row.url), ['https://example.net/page']);
  assert.equal(view.truncated, true);
});

test('web search reports a tool error and ignores non-search tools', () => {
  assert.deepEqual(webSearchView('camellia_web_search', { ok: false, error: 'quota' }), {
    error: 'quota', results: [],
  });
  assert.equal(webSearchView('camellia_web_fetch', { ok: true, results: [] }), null);
  assert.equal(webSearchView('camellia_web_search', 'not json'), null);
});

test('source registry numbers only cited URLs in reply order, ignoring search indexes', () => {
  const registry = sourceRegistry([
    { index: 1, url: 'https://example.net/unused' },
    { index: 27, title: 'First citation', url: 'https://example.com/a' },
    { index: 33, url: 'https://example.org/b' },
  ]);
  assert.equal(registry.size, 0);
  assert.equal(registry.numberFor('https://example.com/a'), 1);
  assert.equal(registry.numberFor('https://fetched.example/'), 2);
  assert.equal(registry.numberFor('https://example.org/b'), 3);
  assert.equal(registry.numberFor('http://www.example.com/a/?utm_source=x#part'), 1);
  assert.equal(registry.size, 3);
  assert.equal(registry.get('https://example.net/unused'), null);
  assert.equal(registry.get('https://example.com/a').index, 1);
  assert.equal(registry.get('https://example.com/a').title, 'First citation');
});

test('citation numbering restarts for a new reply and ignores non-web links', () => {
  const registry = sourceRegistry();
  assert.equal(registry.numberFor('file:///tmp/page.html'), 0);
  assert.equal(registry.numberFor('mailto:a@example.com'), 0);
  assert.equal(registry.numberFor('javascript:alert(1)'), 0);
  assert.equal(registry.numberFor('https://example.org/b'), 1);
  assert.equal(registry.numberFor('https://example.com/a'), 2);
  assert.equal(sourceRegistry().numberFor('https://example.com/a'), 1);
});

test('a missing or malformed legacy source snapshot cannot prevent reply citations', () => {
  for (const list of [null, {}, [null, false, 'old source']]) {
    assert.equal(sourceRegistry(list).numberFor('https://example.com/a'), 1);
  }
});

test('equivalent URL spellings share one source key', () => {
  const forms = [
    'https://example.com/a',
    'http://example.com/a',
    'https://www.example.com/a',
    'example.com/a',
    'www.example.com/a',
    'https://EXAMPLE.com/a/',
    'https://example.com/a#section',
    'https://example.com/a?utm_source=x&utm_campaign=y',
    'https://example.com/a?gclid=abc&ref=feed',
  ];
  assert.equal(new Set(forms.map(sourceKey)).size, 1);
  assert.equal(sourceKey('https://example.com/a?keep=1&utm_source=x'), 'https://example.com/a?keep=1');
});

test('a source key rejects non-web schemes and keeps meaningful query parameters', () => {
  assert.equal(sourceKey('file:///tmp/page.html'), '');
  assert.equal(sourceKey('javascript:alert(1)'), '');
  assert.equal(sourceKey('mailto:a@example.com'), '');
  assert.equal(sourceKey('https://example.com/search?q=router'), 'https://example.com/search?q=router');
});

test('search results deduplicate across equivalent URL spellings', () => {
  const view = webSearchView('camellia_web_search', {
    ok: true,
    results: [
      { title: 'Plain', url: 'https://example.com/a' },
      { title: 'Tracking', url: 'https://example.com/a?utm_source=x' },
      { title: 'WWW', url: 'http://www.example.com/a/' },
      { title: 'Fragment', url: 'https://example.com/a#part' },
    ],
  });
  assert.equal(view.results.length, 1);
  assert.equal(view.results[0].title, 'Plain');
  assert.equal(view.results[0].index, 1);
});
