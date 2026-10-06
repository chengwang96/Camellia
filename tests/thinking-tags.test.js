'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { split } = require('../src/shared/thinking-tags');

test('a closed thinking block is lifted out of the answer', () => {
  const { body, thinking } = split('<thinking>**Locating files**</thinking>\nThe answer.');
  assert.equal(body, '\nThe answer.');
  assert.equal(thinking, '**Locating files**');
});

test('an unclosed thinking block still folds its text away', () => {
  const { body, thinking } = split('<thinking>still reasoning');
  assert.equal(body, '');
  assert.equal(thinking, 'still reasoning');
});

test('several blocks fold together in order and plain text is untouched', () => {
  assert.deepEqual(split('a<thinking>one</thinking>b<thinking>two</thinking>c'),
    { body: 'abc', thinking: 'one\n\ntwo' });
  const plain = split('A price of 5 < 6 and a <code> tag.');
  assert.equal(plain.body, 'A price of 5 < 6 and a <code> tag.');
  assert.equal(plain.thinking, '');
});

test('latest-only rendering keeps the last segment without changing the answer', () => {
  const source = 'a<thinking>one</thinking>b<think>two</think>c';
  assert.deepEqual(split(source, { latestOnly: true }), { body: 'abc', thinking: 'two' });
  assert.deepEqual(split(source), { body: 'abc', thinking: 'one\n\ntwo' });
  assert.deepEqual(split('<thinking>old</thinking><thinking>new streamed', { latestOnly: true }),
    { body: '', thinking: 'new streamed' });
  assert.deepEqual(split('<thinking>old</thinking><thinking>', { latestOnly: true }),
    { body: '', thinking: '' });
});

test('a streamed half-written delimiter is held back until it completes', () => {
  assert.equal(split('Answer <thi').body, 'Answer ');
  assert.equal(split('Answer </thinkin').body, 'Answer ');
  // A bare "<" is ordinary prose, not a tag being typed.
  assert.equal(split('2 <').body, '2 <');
});

test('inline code mentioning thinking tags preserves the whole answer', () => {
  for (const source of [
    'It is the new `<thinking>` parser. The rest of the answer.',
    'Native thinking blocks, plus `<think>` in text. Details follow.',
    'An example: `<think>reason</think>` stays literal.',
    'Use ``<thinking>`example`</thinking>`` in code.',
    'A multiline `<thinking>\nexample\n</thinking>` remains code.',
  ]) {
    assert.deepEqual(split(source), { body: source, thinking: '' });
  }
});

test('fenced and indented code never becomes reasoning', () => {
  for (const source of [
    'An example:\n```xml\n<thinking>reason</thinking>\n```\nThe answer.',
    'An example:\n~~~xml\n<think>reason</think>\n~~~~\nThe answer.',
    'An example:\n````xml\n```\n<thinking>reason</thinking>\n````\nThe answer.',
    'An example:\n    <thinking>reason</thinking>\nThe answer.',
    'An example:\n\t<think>reason</think>\nThe answer.',
  ]) {
    assert.deepEqual(split(source), { body: source, thinking: '' });
  }
});

test('escaped thinking tags are literal while unescaped blocks still fold', () => {
  const literal = String.raw`Use \<thinking>reason\</thinking> in prose.`;
  assert.deepEqual(split(literal), { body: literal, thinking: '' });
  assert.deepEqual(split(String.raw`\\<thinking>real reasoning</thinking>Answer.`),
    { body: String.raw`\\Answer.`, thinking: 'real reasoning' });
});

test('genuine reasoning and literal code examples can share a message', () => {
  const source = '<thinking>Check `<thinking>` and `</thinking>` examples.\n```xml\n</thinking>\n```\nDone.</thinking>\nUse `<thinking>` in the answer.';
  assert.deepEqual(split(source), {
    body: '\nUse `<thinking>` in the answer.',
    thinking: 'Check `<thinking>` and `</thinking>` examples.\n```xml\n</thinking>\n```\nDone.',
  });
  assert.deepEqual(split('Use `<thinking>` first.\n<think>Real reasoning.</think>Answer.'),
    { body: 'Use `<thinking>` first.\nAnswer.', thinking: 'Real reasoning.' });
});

test('streaming code examples stay literal before their delimiters finish', () => {
  for (const source of [
    'Use `<thi',
    'Use `<thinking>',
    'Use `<thinking>` and `</thinkin',
    'An example:\n```xml\n<thinking>reason',
    'An example:\n~~~xml\n<thi',
    'An example:\n    <thi',
    String.raw`Use \<thi`,
  ]) {
    assert.deepEqual(split(source), { body: source, thinking: '' });
  }
  const source = 'Use `<thinking>` in code, then <thi';
  assert.deepEqual(split(source), { body: 'Use `<thinking>` in code, then ', thinking: '' });
});
