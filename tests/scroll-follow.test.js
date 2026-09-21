'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');

test('stream following survives consecutive programmatic scroll events', () => {
  assert.doesNotMatch(source, /programmaticScroll/);
  assert.match(source, /if \(running && \(userScrollActive \|\| performance\.now\(\) < userScrollIntentUntil\)\) followRunOutput = nearBottom\(\)/);
  assert.match(source, /new ResizeObserver\(\(\) => \{\s*if \(running && followRunOutput\) scrollToLatest\(\);/);
});

test('explicitly submitted messages scroll again after the next layout', () => {
  assert.match(source, /function scrollToLatest\(\) \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?chatScroll\.scrollTop = chatScroll\.scrollHeight;/);
  assert.match(source, /if \(meta\.scrollToBottom\) scrollToLatest\(\);/);
});
