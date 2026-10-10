'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Boundaries } = require('../src/renderer/chat/streaming-markdown');
const { createStream, split } = require('../src/shared/thinking-tags');

test('streaming boundaries retain unfinished block and inline syntax', () => {
  for (const source of [
    '```js\nfirst\n\nsecond\n',
    '$$a\n\nb\n', String.raw`\[a` + '\n\nb\n', String.raw`\(a` + '\n\nb\n',
    String.raw`$$\text{\$\$}` + '\n\nmore\n',
    String.raw`\[\begin{matrix}a\\[2pt]b` + '\n\nmore\n',
    '**a\n\nb\n', '*a\n\nb\n', '~~a\n\nb\n',
    '[label\n\nmore\n', '[label](url\n\nmore\n',
    '`*a\n\nb\n', '    code\n\n',
  ]) {
    const scanner = new Boundaries();
    for (let i = 1; i <= source.length; i++) scanner.scan(source.slice(0, i));
    assert.equal(scanner.cut, 0, source);
  }
});

test('streaming boundaries seal complete paragraphs, lists, tables and formulas', () => {
  for (const source of [
    'plain\n\n', '**bold**\n\n', '~~strike~~\n\n',
    '- first\n- second\n\n', '* first\n* second\n\n',
    '| a | b |\n| --- | --- |\n| c | d |\n\n',
    '```js\nfirst\n\nsecond\n```\n\n', '$$a\n\nb$$\n\n',
    String.raw`\[a` + '\n\nb' + String.raw`\]` + '\n\n',
    String.raw`\(a` + '\n\nb' + String.raw`\)` + '\n\n',
    String.raw`$$\text{\$\$}` + '\n\nb$$\n\n',
    '    code\n\n\n', '---\n\n',
  ]) {
    const scanner = new Boundaries();
    for (let i = 1; i <= source.length; i++) scanner.scan(source.slice(0, i));
    assert.equal(scanner.cut, source.length, source);
  }
});

test('long unfinished lines are searched only over newly appended characters', () => {
  const scanner = new Boundaries();
  let source = '';
  for (let i = 0; i < 1000; i++) {
    source += 'a'.repeat(100);
    scanner.scan(source);
    assert.equal(scanner.searched, source.length);
    assert.equal(scanner.lineStart, 0);
  }
  scanner.scan(source + '\n\n');
  assert.equal(scanner.cut, source.length + 2);
});

test('incremental thinking matches the existing splitter at every chunk boundary', () => {
  const sources = [
    'No tags, just a long answer.\n\n**Ready**.',
    'a<thinking>one</thinking>b<think>two</think>c',
    'Answer <thi', 'Answer </thinkin', '2 <',
    '<think attr="yes">Reasoning\n</think>Answer',
    '<THINKING>Reasoning</THINKING>Answer',
    'Use `<thinking>` and `</thinkin',
    'Use ``<thinking>`example`</thinking>`` in code.',
    'Example:\n```xml\n<think>code</think>\n```\n<think>real</think>answer',
    'Example:\n~~~xml\n<think>code</think>\n~~~~\n<think>real</think>answer',
    'Example:\n    <think>code</think>\n\t<thi\n<think>real</think>answer',
    String.raw`Use \<thinking>literal\</thinking>, then \\<think>real</think>answer`,
    '<thinking>Check `<thinking>` and `</thinking>` examples.\n```xml\n</thinking>\n```\nDone.</thinking>\nUse `<thinking>` in the answer.',
    'a<think>old</think><think>new streamed',
  ];
  for (const latestOnly of [false, true]) for (const source of sources) for (const width of [1, 2, 7, 31]) {
    const stream = createStream({ latestOnly });
    let partial = '';
    for (let i = 0; i < source.length; i += width) {
      const delta = source.slice(i, i + width);
      partial += delta;
      const { body, thinking } = stream.append(delta);
      assert.deepEqual({ body, thinking }, split(partial, { latestOnly }), JSON.stringify({ partial, latestOnly, width }));
    }
    assert.deepEqual(stream.finish(), split(source, { latestOnly }));
    stream.dispose();
  }
});

test('thinking-like XML in an open code block does not rescan previous output', () => {
  const stream = createStream({ latestOnly: true });
  let source = '```xml\n';
  stream.append(source);
  for (let i = 0; i < 500; i++) {
    const delta = '<think>literal</think>\n';
    source += delta;
    const state = stream.append(delta);
    assert.equal(state.body, source);
    if (i > 0) assert.equal(state.bodyDelta, delta);
  }
  source += '```\n<think>real</think>answer';
  const state = stream.append('```\n<think>real</think>answer');
  assert.equal(state.thinking, 'real');
  assert.deepEqual({ body: state.body, thinking: state.thinking }, split(source, { latestOnly: true }));
});
