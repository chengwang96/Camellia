'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const links = require('../src/renderer/chat/markdown-links.js');
global.window = {};
require('../src/renderer/shared/chat-controls.js');
const { sourceRegistry } = window.CamelliaChatControls;

test('a known source URL receives a numbered marker after its link', () => {
  const registry = {
    numberFor(url) { return url === 'https://example.com/a' ? 3 : 0; },
  };
  const html = links.renderInline('[First](https://example.com/a)', '', registry);
  assert.match(html, /data-chat-source="3"/);
  assert.match(html, /<a class="md-source-marker" href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer"[^>]*>3<\/a>/);
});

test('an unknown URL and a local file link do not receive a marker', () => {
  const registry = { numberFor() { return 0; } };
  assert.doesNotMatch(links.renderInline('[Other](https://example.org/b)', '', registry), /md-source-marker/);
  assert.doesNotMatch(links.renderInline('[Local](README.md)', repo, registry), /md-source-marker/);
});

test('the same URL keeps one marker when the registry is built from deduplicated sources', () => {
  const registry = {
    numberFor(url) { return url === 'https://example.com/a' ? 1 : 0; },
  };
  const html = links.renderInline(
    '[One](https://example.com/a) and [Again](https://example.com/a)',
    '',
    registry,
  );
  assert.equal((html.match(/md-source-marker/g) || []).length, 2);
  assert.equal((html.match(/rel="noopener noreferrer"[^>]*>1<\/a>/g) || []).length, 2);
});

test('the marker is a real external link so it can open the cited source', () => {
  const registry = { numberFor(url) { return url === 'https://example.com/a' ? 1 : 0; } };
  const html = links.renderInline('[First](https://example.com/a)', '', registry);
  assert.match(html, /class="md-source-marker" href="https:\/\/example\.com\/a"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('cited and fetched-only pages receive consecutive numbers in visible order', () => {
  const registry = sourceRegistry([
    { index: 1, url: 'https://example.net/unused' },
    { index: 27, url: 'https://example.com/a' },
    { index: 33, url: 'https://example.org/b' },
  ]);
  const html = links.renderInline(
    '[First](https://example.com/a) [Fetched](https://hospital.example/diet) '
    + '[Third](https://example.org/b) [Again](http://www.example.com/a/?utm_source=x#part)', '', registry);
  assert.deepEqual([...html.matchAll(/data-chat-source="(\d+)"/g)].map(match => Number(match[1])), [1, 2, 3, 1]);
});

test('file, mail and media links do not consume citation numbers', () => {
  const registry = sourceRegistry();
  const html = links.renderInline(
    '[Local](README.md) [Email](mailto:a@example.com) '
    + '[Image](https://example.com/image.png) [Video](https://example.com/clip.mp4) '
    + '[Source](https://example.com/a)', repo, registry);
  assert.deepEqual([...html.matchAll(/data-chat-source="(\d+)"/g)].map(match => Number(match[1])), [1]);
  assert.equal(registry.size, 1);
});

test('user and document links render without citation markers', () => {
  assert.doesNotMatch(links.renderInline('[Link](https://example.com/a)'), /md-source-marker|data-chat-source/);
});
