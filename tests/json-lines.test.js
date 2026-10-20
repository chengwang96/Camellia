'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const { once } = require('node:events');
const { jsonLines } = require('../src/shared/json-lines');

test('JSONL keeps Unicode separators, escaped newlines and split UTF-8 inside their record', async () => {
  const records = [{ text: '中文\u2028🧪\u2029\nnext\rline' }, { text: 'final🧪\u2028' }];
  const bytes = Buffer.from(records.map(JSON.stringify).join('\r\n'));
  const input = Readable.from([...bytes].map(byte => Buffer.from([byte])));
  const output = [];
  for await (const line of jsonLines(input)) output.push(JSON.parse(line));
  assert.deepEqual(output, records);
});

test('JSONL frames LF and CRLF, retains empty records and flushes the final record once', async () => {
  const chunks = ['first\r', '\n\n', 'third\n', 'last'];
  const output = [];
  for await (const line of jsonLines(Readable.from(chunks))) output.push(line);
  assert.deepEqual(output, ['first', '', 'third', 'last']);
});

test('JSONL preserves a large fragmented record and the next coalesced message', async () => {
  const text = '历史\u2028🧪\u2029'.repeat(100000);
  const bytes = Buffer.from(JSON.stringify({ text }) + '\n{}\n');
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8191) chunks.push(bytes.subarray(offset, offset + 8191));
  const output = [];
  for await (const line of jsonLines(Readable.from(chunks))) output.push(JSON.parse(line));
  assert.deepEqual(output, [{ text }, {}]);
});

test('JSONL destruction releases its source without reading subsequent records', async () => {
  const input = new PassThrough(), output = [];
  const lines = jsonLines(input);
  lines.on('data', line => output.push(line));
  input.write('{}\npartial');
  const closed = once(lines, 'close');
  lines.destroy();
  await closed;
  input.end('ignored\n');
  assert.deepEqual(output, ['{}']);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('error'), 0);
});

test('JSONL forwards source errors to its consumer and detaches', async () => {
  const input = new PassThrough(), lines = jsonLines(input);
  const failure = new Error('Read failed');
  const result = (async () => { for await (const line of lines) JSON.parse(line); })();
  input.destroy(failure);
  await assert.rejects(result, error => error === failure);
  assert.equal(input.listenerCount('error'), 0);
});
