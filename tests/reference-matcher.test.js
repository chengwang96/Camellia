'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { referenceMatcher } = require('../src/main/reference-matcher');

test('reference matcher preserves substring semantics, shared prefixes and overlapping Unicode matches', () => {
  const terms = ['a', 'aa', 'aaa', 'abc.def', 'abc.def/long', '[x]', '😀', '😀中文', '中文', '1234567😀tail', 'path/to/first', 'path/to/second'];
  const samples = ['aaa', 'zabc.def/long[x]', '😀中文 1234567😀tail', 'path/to/second path/to/first', 'not present'];
  const matcher = referenceMatcher(terms);
  for (const text of samples) matcher.inspect(text);
  assert.deepEqual([...matcher.found].sort(), terms.filter(term => samples.some(text => text.includes(term))).sort());
  assert.doesNotThrow(() => referenceMatcher([]).inspect('anything'));
});

test('reference matcher handles thousands of candidate paths without repeated whole-source searches', () => {
  const terms = Array.from({ length: 10000 }, (_, index) => `c:/data/conversations/${index}/file.txt`);
  const matcher = referenceMatcher(terms);
  matcher.inspect('padding'.repeat(100000) + terms[9999]);
  matcher.inspect(terms[3456]);
  assert.deepEqual([...matcher.found].sort(), [terms[9999], terms[3456]].sort());
});
