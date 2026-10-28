'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { zstdCompressSync, zstdDecompressSync, createZstdDecompress, constants } = require('node:zlib');
const { zstdFrameValidator } = require('../src/shared/zstd-frames');

async function validate(bytes, chunkSize = bytes.length || 1) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) chunks.push(bytes.subarray(offset, offset + chunkSize));
  const output = [];
  await pipeline(Readable.from(chunks), zstdFrameValidator(), new Writable({
    write(chunk, _encoding, done) { output.push(chunk); done(); },
  }));
  return Buffer.concat(output);
}

test('frame validation preserves native empty, raw, compressed, checksum and multi-block frames across chunk boundaries', async () => {
  for (const payload of [Buffer.alloc(0), Buffer.from('hello'), Buffer.from('重复内容\n'.repeat(50000))]) {
    for (const checksum of [0, 1]) {
      const frame = zstdCompressSync(payload, { params: { [constants.ZSTD_c_checksumFlag]: checksum } });
      assert.deepEqual(await validate(frame, 1), frame);
      assert.deepEqual(await validate(frame), frame);
      assert.deepEqual(zstdDecompressSync(frame), payload);
    }
  }
});

test('frame validation accepts streaming headers, every dictionary/content-size field width, and RLE blocks', async () => {
  for (let sizeFlag = 0; sizeFlag < 4; sizeFlag++) {
    for (let dictionaryFlag = 0; dictionaryFlag < 4; dictionaryFlag++) {
      const payload = Buffer.alloc(sizeFlag === 1 ? 256 : 5, 97);
      const size = Buffer.alloc([1, 2, 4, 8][sizeFlag]);
      size.writeUIntLE(sizeFlag === 1 ? payload.length - 256 : payload.length, 0, Math.min(size.length, 6));
      const block = Buffer.alloc(3);
      block.writeUIntLE((payload.length << 3) | 1, 0, 3);
      const frame = Buffer.concat([
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20 | (sizeFlag << 6) | dictionaryFlag]),
        Buffer.alloc([0, 1, 2, 4][dictionaryFlag]), size, block, payload,
      ]);
      assert.deepEqual(zstdDecompressSync(frame), payload);
      assert.deepEqual(await validate(frame, 1), frame);
    }
  }
  const streaming = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x29, 0, 0]), Buffer.from('hello')]);
  const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, 0x2b, 0, 0, 97]);
  assert.equal(zstdDecompressSync(streaming).toString(), 'hello');
  assert.equal(zstdDecompressSync(rle).toString(), 'aaaaa');
  assert.deepEqual(await validate(streaming, 2), streaming);
  assert.deepEqual(await validate(rle, 1), rle);
});

test('frame validation accepts concatenated frames and skippable metadata frames', async () => {
  const skip = Buffer.from([0x5f, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
  const emptySkip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
  const frames = Buffer.concat([skip, zstdCompressSync(Buffer.from('first')), emptySkip, zstdCompressSync(Buffer.from('second'))]);
  assert.deepEqual(await validate(frames, 1), frames);
  const output = [];
  await pipeline(Readable.from([frames]), zstdFrameValidator(), createZstdDecompress(), new Writable({
    write(chunk, _encoding, done) { output.push(chunk); done(); },
  }));
  assert.equal(Buffer.concat(output).toString(), 'firstsecond');
});

test('frame validation rejects every truncated header, block and checksum, plus unknown magic and reserved block types', async () => {
  const frame = zstdCompressSync(Buffer.from('complete frame\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 1, 2]);
  for (const bytes of [frame, skip]) {
    for (let length = 0; length < bytes.length; length++) {
      await assert.rejects(validate(bytes.subarray(0, length), 1), /invalid or incomplete Zstandard frame/);
    }
  }
  await assert.rejects(validate(Buffer.from('invalid frame')), /invalid or incomplete Zstandard frame/);
  await assert.rejects(validate(Buffer.concat([frame, Buffer.from([0])])), /invalid or incomplete Zstandard frame/);
  await assert.rejects(validate(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0])), /invalid or incomplete Zstandard frame/);
});
