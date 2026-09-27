'use strict';

// Minimal QR Code encoder (byte mode, error-correction level M, versions 1–10).
// It exists so the desktop can render a pairing QR without pulling in a runtime
// dependency; the payload is a short JSON object, so the smaller version range
// is enough. The Android client decodes these codes with ZXing.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaQr = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const MAX_VERSION = 10;

  // Block structure for error-correction level M: [ecCodewordsPerBlock, [[blockCount, dataCodewords], ...]].
  const LEVEL_M = [
    null,
    { ec: 10, groups: [[1, 16]] },
    { ec: 16, groups: [[1, 28]] },
    { ec: 26, groups: [[1, 44]] },
    { ec: 18, groups: [[2, 32]] },
    { ec: 24, groups: [[2, 43]] },
    { ec: 16, groups: [[4, 27]] },
    { ec: 18, groups: [[4, 31]] },
    { ec: 22, groups: [[2, 38], [2, 39]] },
    { ec: 22, groups: [[3, 36], [2, 37]] },
    { ec: 26, groups: [[4, 43], [1, 44]] },
  ];
  const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
  const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function tables() {
    let x = 1;
    for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  const gfMultiply = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

  function utf8(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    const escaped = encodeURIComponent(text);
    const bytes = [];
    for (let i = 0; i < escaped.length; i++) {
      if (escaped[i] === '%') { bytes.push(parseInt(escaped.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(escaped.charCodeAt(i));
    }
    return Uint8Array.from(bytes);
  }

  function dataCapacity(version) {
    return LEVEL_M[version].groups.reduce((total, [count, size]) => total + count * size, 0);
  }

  function selectVersion(byteLength) {
    for (let version = 1; version <= MAX_VERSION; version++) {
      const countBits = version <= 9 ? 8 : 16;
      if (4 + countBits + byteLength * 8 <= dataCapacity(version) * 8) return version;
    }
    throw new Error('QR payload is too large');
  }

  function encodeData(bytes, version) {
    const capacity = dataCapacity(version);
    const capacityBits = capacity * 8;
    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);
    for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const out = new Uint8Array(capacity);
    for (let i = 0; i < bits.length; i += 8) {
      let value = 0;
      for (let bit = 0; bit < 8; bit++) value = (value << 1) | bits[i + bit];
      out[i / 8] = value;
    }
    for (let i = bits.length / 8, pad = 0; i < capacity; i++, pad++) out[i] = pad % 2 === 0 ? 0xec : 0x11;
    return out;
  }

  function generatorPolynomial(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const factor = [1, GF_EXP[i]];
      const next = new Array(poly.length + 1).fill(0);
      for (let a = 0; a < poly.length; a++) for (let b = 0; b < factor.length; b++) next[a + b] ^= gfMultiply(poly[a], factor[b]);
      poly = next;
    }
    return poly;
  }

  function errorCorrection(data, degree) {
    const generator = generatorPolynomial(degree);
    const result = new Uint8Array(data.length + degree);
    result.set(data);
    for (let i = 0; i < data.length; i++) {
      const factor = result[i];
      if (!factor) continue;
      for (let j = 1; j < generator.length; j++) result[i + j] ^= gfMultiply(generator[j], factor);
    }
    return result.slice(data.length);
  }

  function codewords(version, data) {
    const spec = LEVEL_M[version];
    const blocks = [];
    let offset = 0;
    for (const [count, size] of spec.groups) for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: block, ec: errorCorrection(block, spec.ec) });
    }
    const total = blocks.reduce((sum, block) => sum + block.data.length + block.ec.length, 0) + REMAINDER_BITS[version];
    const out = new Uint8Array(total);
    let p = 0;
    const longest = Math.max(...blocks.map(block => block.data.length));
    for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.data.length) out[p++] = block.data[i];
    for (let i = 0; i < spec.ec; i++) for (const block of blocks) out[p++] = block.ec[i];
    return out.slice(0, p);
  }

  function baseMatrix(version) {
    const size = version * 4 + 17;
    const modules = new Uint8Array(size * size);
    const reserved = new Uint8Array(size * size);
    const set = (row, col, value) => { modules[row * size + col] = value; reserved[row * size + col] = 1; };
    const finder = (row, col) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, dark ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) { const value = i % 2 === 0 ? 1 : 0; set(6, i, value); set(i, 6, value); }
    const centers = ALIGNMENT[version];
    for (const row of centers) for (const col of centers) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
    }
    for (let i = 0; i <= 8; i++) { if (i !== 6) { set(8, i, 0); set(i, 8, 0); } }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
    set(size - 8, 8, 1);
    if (version >= 7) for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3), col = size - 11 + (i % 3);
      set(row, col, 0); set(col, row, 0);
    }
    return { size, modules, reserved };
  }

  function placeData(matrix, version, data) {
    const { size, modules, reserved } = matrix;
    let index = 0;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (let offset = 0; offset < size; offset++) for (let c = 0; c < 2; c++) {
        const current = col - c;
        const row = ((col + 1) & 2) === 0 ? size - 1 - offset : offset;
        // Reservation is directional: the zigzag visits some pairs bottom-up, so
        // the check must use the resolved row, not the loop counter.
        if (reserved[row * size + current]) continue;
        let dark = 0;
        if (index < data.length * 8) dark = (data[index >>> 3] >>> (7 - (index & 7))) & 1;
        index++;
        modules[row * size + current] = dark;
      }
    }
  }

  const maskBit = (mask, row, col) => {
    switch (mask) {
      case 0: return (row + col) % 2 === 0;
      case 1: return row % 2 === 0;
      case 2: return col % 3 === 0;
      case 3: return (row + col) % 3 === 0;
      case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5: return (row * col) % 2 + (row * col) % 3 === 0;
      case 6: return ((row * col) % 2 + (row * col) % 3) % 2 === 0;
      default: return ((row + col) % 2 + (row * col) % 3) % 2 === 0;
    }
  };

  function applyMask(matrix, mask) {
    const { size, modules, reserved } = matrix;
    const out = modules.slice();
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      if (reserved[row * size + col]) continue;
      if (maskBit(mask, row, col)) out[row * size + col] ^= 1;
    }
    return out;
  }

  function formatBits(mask) {
    const data = (ECC_BITS.M << 3) | mask;
    let bits = data << 10;
    for (let i = 14; i >= 10; i--) if ((bits >>> i) & 1) bits ^= 0x537 << (i - 10);
    return ((data << 10) | bits) ^ 0x5412;
  }

  function versionBits(version) {
    let bits = version << 12;
    for (let i = 17; i >= 12; i--) if ((bits >>> i) & 1) bits ^= 0x1f25 << (i - 12);
    return (version << 12) | bits;
  }

  // Format information is 15 bits: the mask pattern and error-correction level
  // plus a BCH remainder, XORed with a fixed pattern. Its two copies have very
  // specific positions; a decoder reads them first to learn the mask, so getting
  // them wrong makes the symbol undecodable even when the data is correct.
  function drawFormat(modules, version, mask) {
    const size = version * 4 + 17;
    const bits = formatBits(mask);
    const bit = index => (bits >>> index) & 1;
    // Bit 14 is placed first; the top-left copy reads left to right along row 8,
    // then upward along column 8.
    for (let i = 0; i <= 5; i++) modules[8 * size + i] = bit(14 - i);
    modules[8 * size + 7] = bit(8);
    modules[8 * size + 8] = bit(7);
    modules[7 * size + 8] = bit(6);
    for (let i = 0; i <= 5; i++) modules[i * size + 8] = bit(i);
    // Copy 2: upward along the bottom-left column, then right along row 8.
    for (let i = 0; i <= 6; i++) modules[(size - 1 - i) * size + 8] = bit(14 - i);
    for (let i = 0; i <= 7; i++) modules[8 * size + (size - 8 + i)] = bit(7 - i);
    if (version >= 7) {
      const versionData = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const value = (versionData >>> i) & 1;
        const row = Math.floor(i / 3), col = size - 11 + (i % 3);
        modules[row * size + col] = value;
        modules[col * size + row] = value;
      }
    }
  }

  function penalty(modules, size) {
    let score = 0;
    const runScore = (line) => {
      let total = 0, run = 1;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) run++;
        else { if (run >= 5) total += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) total += 3 + (run - 5);
      return total;
    };
    for (let row = 0; row < size; row++) score += runScore(modules.slice(row * size, row * size + size));
    for (let col = 0; col < size; col++) {
      const line = new Uint8Array(size);
      for (let row = 0; row < size; row++) line[row] = modules[row * size + col];
      score += runScore(line);
    }
    for (let row = 0; row < size - 1; row++) for (let col = 0; col < size - 1; col++) {
      const value = modules[row * size + col];
      if (value === modules[row * size + col + 1] && value === modules[(row + 1) * size + col] && value === modules[(row + 1) * size + col + 1]) score += 3;
    }
    const finder = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const hasPattern = (line, start) => {
      for (let i = 0; i < 11; i++) if (line[start + i] !== finder[i]) return false;
      return true;
    };
    for (let row = 0; row < size; row++) for (let start = 0; start + 11 <= size; start++) {
      const line = modules.slice(row * size, row * size + size);
      if (hasPattern(line, start)) score += 40;
      const reversed = Uint8Array.from(finder).reverse();
      let matches = true;
      for (let i = 0; i < 11; i++) if (line[start + i] !== reversed[i]) { matches = false; break; }
      if (matches) score += 40;
    }
    for (let col = 0; col < size; col++) {
      const line = new Uint8Array(size);
      for (let row = 0; row < size; row++) line[row] = modules[row * size + col];
      for (let start = 0; start + 11 <= size; start++) {
        if (hasPattern(line, start)) score += 40;
        const reversed = Uint8Array.from(finder).reverse();
        let matches = true;
        for (let i = 0; i < 11; i++) if (line[start + i] !== reversed[i]) { matches = false; break; }
        if (matches) score += 40;
      }
    }
    let dark = 0;
    for (const value of modules) dark += value;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  function qrMatrix(text, options = {}) {
    const level = options.errorCorrectionLevel || 'M';
    if (level !== 'M') throw new Error('Only error-correction level M is supported');
    const bytes = utf8(String(text));
    const version = selectVersion(bytes.length);
    const matrix = baseMatrix(version);
    placeData(matrix, version, codewords(version, encodeData(bytes, version)));
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = applyMask(matrix, mask);
      drawFormat(candidate, version, mask);
      const score = penalty(candidate, matrix.size);
      if (!best || score < best.score) best = { score, modules: candidate };
    }
    return { size: matrix.size, version, modules: best.modules };
  }

  function qrSvg(text, options = {}) {
    const { size, modules } = qrMatrix(text, options);
    const margin = Number.isInteger(options.margin) ? options.margin : 4;
    const total = size + margin * 2;
    let path = '';
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      if (modules[row * size + col]) path += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
    const light = options.light || '#ffffff', dark = options.dark || '#000000';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="${options.label || 'QR code'}">`
      + `<rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
  }

  return { qrMatrix, qrSvg, selectVersion, MAX_VERSION };
});
