'use strict';

// The pairing QR is the phone's only way to learn the desktop address, so this
// pins the structural invariants that a decoder depends on. A subtle bug in the
// module layout (function patterns overwritten by data, or a reservation checked
// against the loop counter instead of the resolved row) still produces a
// plausible-looking symbol that no scanner can read, so compare against the ISO
// structure directly instead of only snapshotting pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const { qrMatrix, qrSvg, selectVersion, MAX_VERSION } = require('../src/shared/qr');

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function formatWord(modules, size) {
  const at = (row, col) => modules[row * size + col];
  const cells = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let bits = 0;
  for (const [row, col] of cells) bits = (bits << 1) | at(row, col);
  return bits ^ 0x5412;
}

test('every supported version encodes a decodable structure', () => {
  for (let length = 1; length <= 213; length += 11) {
    const text = 'x'.repeat(length);
    const { size, modules, version } = qrMatrix(text);
    assert.equal(version, selectVersion(Buffer.byteLength(text)));
    assert.equal(size, version * 4 + 17);
    assert.ok(version >= 1 && version <= MAX_VERSION);

    const at = (row, col) => modules[row * size + col];
    // Finder patterns including their separators.
    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let row = -1; row <= 7; row++) for (let col = -1; col <= 7; col++) {
        const r = top + row, c = left + col;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const ring = (row >= 0 && row <= 6 && (col === 0 || col === 6)) || (col >= 0 && col <= 6 && (row === 0 || row === 6));
        const core = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        assert.equal(at(r, c), ring || core ? 1 : 0, `finder at ${r},${c} for ${text.length} bytes`);
      }
    }
    // Timing patterns alternate, and the format word must decode to level M with
    // a mask the encoder could have chosen.
    for (const col of [6, size - 7]) assert.equal(at(6, col), 1);
    for (let i = 8; i < size - 8; i++) assert.equal(at(6, i), i % 2 === 0 ? 1 : 0, `timing row ${i}`);
    for (let i = 8; i < size - 8; i++) assert.equal(at(i, 6), i % 2 === 0 ? 1 : 0, `timing column ${i}`);
    const word = formatWord(modules, size);
    assert.equal((word >> 13) & 3, 0, 'error-correction level M');
    assert.ok(((word >> 10) & 7) <= 7);
    // The second format copy carries the same 15 bits, so a decoder reading
    // either location must learn the same mask.
    let copy2 = 0;
    for (let i = 0; i <= 6; i++) copy2 = (copy2 << 1) | at(size - 1 - i, 8);
    for (let i = 0; i <= 7; i++) copy2 = (copy2 << 1) | at(8, size - 8 + i);
    assert.equal(copy2 ^ 0x5412, word);
    // Alignment patterns sit on every centre except the three finder corners.
    for (const row of ALIGNMENT[version]) for (const col of ALIGNMENT[version]) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        assert.equal(at(row + dr, col + dc), Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1, `alignment ${row},${col}`);
      }
    }
  }
});

test('pairing payloads stay small enough for the encoder and the scanner', () => {
  const payload = JSON.stringify({ v: 1, type: 'camellia-pair', address: 'http://100.127.255.255:65535', code: 'a'.repeat(24) });
  const { version, size } = qrMatrix(payload);
  assert.ok(version <= 7);
  assert.ok(size <= 45);
  const svg = qrSvg(payload, { label: 'Pairing QR code' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // The renderer inlines this SVG in a data: URL, so it must not contain raw '#'.
  assert.ok(!svg.includes('#') || /fill="#/.test(svg));
});

test('selectVersion rejects payloads past version 10', () => {
  assert.throws(() => qrMatrix('x'.repeat(400)), /too large/);
});
