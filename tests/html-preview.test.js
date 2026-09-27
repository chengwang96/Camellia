'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceDocument } = require('../src/renderer/chat/html-preview');

test('HTML preview permits inline interactions without app or remote script access', () => {
  const html = sourceDocument({ url: 'file:///C:/reports/page.html', text: '<button onclick="this.textContent=42">Run</button>' });
  assert.match(html, /script-src &#39;unsafe-inline&#39;/);
  assert.match(html, /connect-src &#39;none&#39;/);
  assert.match(html, /worker-src &#39;none&#39;/);
  assert.match(html, /form-action &#39;none&#39;/);
  assert.doesNotMatch(html, /https:|unsafe-eval|allow-same-origin/);
  assert.match(html, /<base href="file:\/\/\/C:\/reports\/page.html">/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<button'));
});

test('static mode disallows scripts and untrusted remote bases are not inserted', () => {
  assert.match(sourceDocument({ text: '<script>alert(1)</script>' }, false), /script-src &#39;none&#39;/);
  for (const url of ['https://example.com', 'file://server/share', 'javascript:alert(1)', 'invalid']) assert.doesNotMatch(sourceDocument({ url }), /<base /);
});
