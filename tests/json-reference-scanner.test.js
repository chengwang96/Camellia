'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonReferenceScanner } = require('../src/main/json-reference-scanner');

function read(source, width) {
  const strings = []; let current = '';
  const reader = new JsonReferenceScanner((text, first, last) => {
    if (first) current = '';
    current += text;
    if (last) strings.push(current);
  });
  for (let i = 0; i < source.length; i += width) reader.write(source.slice(i, i + width));
  reader.end();
  return strings;
}

test('decodes JSON keys and values across every kind of escape and token boundary', () => {
  const source = ' {"path":"C:\\\\notes\\u002f\\u6d4b\\u8bd5\\ud83d\\ude00.txt",'
    + '"escaped":"\\\"\\\\\\/\\b\\f\\n\\r\\t","empty":"",'
    + '"values":[true,false,null,-12.5e+3,0,1E-2,{},[]]}\r\n42\n\n';
  const row = JSON.parse(source.split('\r\n')[0]);
  const expected = ['path', row.path, 'escaped', row.escaped, 'empty', '', 'values'];
  for (const width of [1, 2, 3, 7, 16384, source.length]) assert.deepEqual(read(source, width), expected);
});

test('rejects malformed or incomplete rows instead of authorizing cleanup', () => {
  for (const source of ['{"x":}', '{"x" 1}', '{1:2}', '{"x":1,}', '[1,]', '[,1]', '{}{}',
    'true false', '01', '-01', '1.', '1e', '1e+', '-.', 'tru', 'truex', 'nul', 'NaN',
    '"\\q"', '"\\u00xz"', '"\\u123"', '"a\nb"', '"open', '{"a":1', '[1\n2]',
    '"\\', '{"a": [1,2}\n', '\u00a0{}']) {
    for (const width of [1, 3, source.length]) {
      assert.throws(() => read(source, width), /reference JSON/, JSON.stringify({ source, width }));
    }
  }
});

test('preserves every string conservatively including duplicate keys and empty rows', () => {
  assert.deepEqual(read('\n {"path":"first", "path":"second"}\n"third"\n', 1),
    ['path', 'first', 'path', 'second', 'third']);
  assert.deepEqual(read(' \r\n\t', 1), []);
});

test('large strings and number tokens are streamed without record-sized buffering', () => {
  let characters = 0, maxChunk = 0, ending = '';
  const scanner = new JsonReferenceScanner(text => {
    characters += text.length; maxChunk = Math.max(maxChunk, text.length);
    ending = (ending + text).slice(-64);
  });
  const block = 'x'.repeat(65536);
  scanner.write('["');
  for (let i = 0; i < 528; i++) scanner.write(block);
  scanner.write('\\u002fretained-asset.txt",');
  for (let i = 0; i < 528; i++) scanner.write('1'.repeat(65536));
  scanner.write(']\n'); scanner.end();
  assert.equal(characters, 528 * 65536 + '/retained-asset.txt'.length);
  assert.ok(ending.endsWith('/retained-asset.txt'));
  assert.ok(maxChunk <= 32768);
});

test('keeps surrogate pairs intact at a decoded chunk boundary and bounds nesting', () => {
  const observed = [];
  const scanner = new JsonReferenceScanner(text => observed.push(text));
  scanner.write('"' + 'x'.repeat(16383) + '\\ud83d');
  scanner.write('\\ude00end"'); scanner.end();
  assert.equal(observed.join(''), 'x'.repeat(16383) + '😀end');
  assert.ok(observed.every(text => !/[\ud800-\udbff]$/.test(text)));
  const deep = new JsonReferenceScanner(() => {}, { maxDepth: 4 });
  assert.throws(() => deep.write('[[[[['), /reference JSON/);
});
