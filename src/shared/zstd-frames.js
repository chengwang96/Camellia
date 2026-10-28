'use strict';

const { Transform } = require('node:stream');

// Node's Zstandard decoder can finish successfully on a truncated frame. Check
// frame boundaries before forwarding bytes; the native decoder still validates
// block contents and checksums. Keep output chunks within a frame: some Node
// versions stop at the first frame when several arrive together. Only four
// header bytes are buffered at a time.
function zstdFrameValidator() {
  const header = Buffer.alloc(4);
  let state = 'magic', needed = 4, have = 0, remaining = 0, afterSkip = '';
  let checksum = false, frames = 0;
  const invalid = () => new Error('Could not import Codex history: invalid or incomplete Zstandard frame.');
  function expect(next) {
    if (next === 'finish') { frames++; next = 'magic'; }
    state = next;
    needed = next === 'descriptor' ? 1 : next === 'block' ? 3 : 4;
    have = 0;
  }
  function skip(count, next) {
    remaining = count;
    afterSkip = next;
    if (remaining) state = 'skip';
    else expect(next);
  }
  function advance() {
    if (state === 'magic') {
      const magic = header.readUInt32LE(0);
      if (magic === 0xfd2fb528) expect('descriptor');
      else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) expect('skip-size');
      else throw invalid();
    } else if (state === 'descriptor') {
      const descriptor = header[0];
      const singleSegment = Boolean(descriptor & 32);
      checksum = Boolean(descriptor & 4);
      const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
      const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6];
      skip((singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes, 'block');
    } else if (state === 'block') {
      const block = header.readUIntLE(0, 3);
      const last = Boolean(block & 1);
      const type = (block >>> 1) & 3;
      if (type === 3) throw invalid();
      skip(type === 1 ? 1 : block >>> 3, last ? (checksum ? 'checksum' : 'finish') : 'block');
    } else if (state === 'skip-size') {
      skip(header.readUInt32LE(0), 'finish');
    } else if (state === 'checksum') {
      expect('finish');
    }
  }
  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        let offset = 0, start = 0;
        while (offset < chunk.length) {
          const completed = frames;
          if (state === 'skip') {
            const count = Math.min(remaining, chunk.length - offset);
            offset += count;
            remaining -= count;
            if (!remaining) expect(afterSkip);
          } else {
            const count = Math.min(needed - have, chunk.length - offset);
            chunk.copy(header, have, offset, offset + count);
            offset += count;
            have += count;
            if (have === needed) advance();
          }
          if (frames !== completed) {
            this.push(chunk.subarray(start, offset));
            start = offset;
          }
        }
        if (start < chunk.length) this.push(chunk.subarray(start));
        done();
      } catch (error) { done(error); }
    },
    flush(done) {
      done(state === 'magic' && have === 0 && frames > 0 ? null : invalid());
    },
  });
}

module.exports = { zstdFrameValidator };
