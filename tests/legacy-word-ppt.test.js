'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { previewKind } = require('../src/main/file-preview');
const { isCompoundFile, readCompoundFile } = require('../src/main/ole-container');
const { isWordDocument, readDocPreview, extractDocText } = require('../src/main/doc-preview');
const { isLegacyPresentation, readPptPreview, extractPptText } = require('../src/main/ppt-preview');

// A minimal OLE2 writer so the fixtures exercise the real container walk rather
// than a hand-waved stub: 512-byte sectors, one FAT sector, a directory, and a
// mini stream for streams below the 4096-byte cutoff.
function writeCompound(t, name, streams) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-legacy-'));
  t.after(() => removeTree(directory));
  const sectorSize = 512, perFat = sectorSize / 4;
  const small = streams.filter(stream => stream.data.length < 4096);
  const large = streams.filter(stream => stream.data.length >= 4096);
  const miniSectorCount = small.reduce((total, stream) => total + Math.max(1, Math.ceil(stream.data.length / 64)), 0);
  const miniStreamSectors = Math.ceil(miniSectorCount * 64 / sectorSize);
  const largeSectors = large.reduce((total, stream) => total + Math.max(1, Math.ceil(stream.data.length / sectorSize)), 0);
  // Layout: FAT sectors, directory sectors, mini-FAT, mini stream, large data.
  const fatSectorCount = 1;
  const directorySectors = Math.ceil((streams.length + 1) * 128 / sectorSize);
  const miniFatSectors = miniSectorCount ? 1 : 0;
  const sectors = [];
  for (let index = 0; index < fatSectorCount; index++) sectors.push({ kind: 'fat' });
  for (let index = 0; index < directorySectors; index++) sectors.push({ kind: 'directory' });
  for (let index = 0; index < miniFatSectors; index++) sectors.push({ kind: 'minifat' });
  const miniStreamStart = sectors.length;
  for (let index = 0; index < miniStreamSectors; index++) sectors.push({ kind: 'ministream', index });
  const largeStarts = new Map();
  for (const stream of large) {
    const start = sectors.length;
    largeStarts.set(stream, start);
    const count = Math.max(1, Math.ceil(stream.data.length / sectorSize));
    for (let index = 0; index < count; index++) sectors.push({ kind: 'large', stream, index });
  }
  const totalDataSectors = sectors.length - fatSectorCount;
  const fileSectors = fatSectorCount + totalDataSectors;
  const buffer = Buffer.alloc((fileSectors + 1) * sectorSize);
  buffer.writeUInt32LE(0xe011cfd0, 0); buffer.writeUInt32LE(0xe11ab1a1, 4);
  buffer.writeUInt16LE(0x003e, 24); buffer.writeUInt16LE(3, 26); buffer.writeUInt16LE(0xfffe, 28);
  buffer.writeUInt16LE(9, 30); buffer.writeUInt16LE(6, 32);
  buffer.writeUInt32LE(0, 44); buffer.writeUInt32LE(directorySectors ? fatSectorCount : 0xfffffffe, 48); // first directory sector (sector index)
  buffer.writeUInt32LE(4096, 56);
  buffer.writeUInt32LE(miniFatSectors ? fatSectorCount + directorySectors : 0xfffffffe, 60);
  buffer.writeUInt32LE(0xfffffffe, 68);
  buffer.writeUInt32LE(0, 76); buffer.writeUInt32LE(0xffffffff, 80);
  for (let index = 2; index < 109; index++) buffer.writeUInt32LE(0xffffffff, 76 + index * 4);
  const sectorOffset = index => (index + 1) * sectorSize;
  // FAT sector 0 marks the data sectors; chain each run of sectors.
  const fatValues = Array(fileSectors).fill(0xffffffff);
  fatValues[0] = 0xfffffffd;
  const markChain = (start, count) => { for (let index = 0; index < count; index++) fatValues[start + index] = index === count - 1 ? 0xfffffffe : start + index + 1; };
  if (directorySectors) markChain(fatSectorCount, directorySectors);
  if (miniFatSectors) markChain(fatSectorCount + directorySectors, miniFatSectors);
  if (miniStreamSectors) markChain(miniStreamStart, miniStreamSectors);
  for (const stream of large) markChain(largeStarts.get(stream), Math.max(1, Math.ceil(stream.data.length / sectorSize)));
  for (let index = 0; index < perFat; index++) buffer.writeUInt32LE(fatValues[index] ?? 0xffffffff, sectorOffset(0) + index * 4);
  // Directory: root entry then one entry per stream.
  const directoryStart = sectorOffset(fatSectorCount);
  const writeEntry = (position, entryName, type, start, size, child = 0xffffffff) => {
    const base = directoryStart + position * 128;
    for (let index = 0; index < entryName.length && index < 31; index++) buffer.writeUInt16LE(entryName.charCodeAt(index), base + index * 2);
    buffer.writeUInt16LE((entryName.length + 1) * 2, base + 64);
    buffer.writeUInt8(type, base + 66); buffer.writeUInt8(1, base + 67);
    buffer.writeUInt32LE(0xffffffff, base + 68); buffer.writeUInt32LE(0xffffffff, base + 72); buffer.writeUInt32LE(child, base + 76);
    buffer.writeUInt32LE(start, base + 116); buffer.writeBigUInt64LE(BigInt(size), base + 120);
  };
  const miniData = Buffer.alloc(miniSectorCount * 64);
  let miniSector = 0, miniCursor = 0;
  for (const stream of small) {
    const count = Math.max(1, Math.ceil(stream.data.length / 64));
    stream.data.copy(miniData, miniCursor, 0, stream.data.length);
    miniCursor += count * 64;
    writeEntry(streams.indexOf(stream) + 1, stream.name, 2, miniSector, stream.data.length, 0xffffffff);
    miniSector += count;
  }
  for (const stream of large) {
    const start = largeStarts.get(stream);
    const count = Math.max(1, Math.ceil(stream.data.length / sectorSize));
    for (let index = 0; index < count; index++) {
      const from = index * sectorSize, to = Math.min(stream.data.length, from + sectorSize);
      stream.data.copy(buffer, sectorOffset(start + index), from, to);
    }
    writeEntry(streams.indexOf(stream) + 1, stream.name, 2, start, stream.data.length, 0xffffffff);
  }
  writeEntry(0, 'Root Entry', 5, miniStreamSectors ? miniStreamStart : 0xfffffffe, miniData.length, 1);
  if (miniStreamSectors) {
    miniData.copy(buffer, sectorOffset(miniStreamStart), 0, miniData.length);
    for (let index = 0; index < miniSectorCount; index++) buffer.writeUInt32LE(index === miniSectorCount - 1 ? 0xfffffffe : index + 1, sectorOffset(fatSectorCount + directorySectors) + index * 4);
  }
  const file = path.join(directory, name);
  fs.writeFileSync(file, buffer);
  return file;
}

// Build a Word 97-2003 document with a 0Table piece table: the body is UTF-16
// text with a cell marker, a paragraph mark and a table row.
function wordDocument(t) {
  const body = ['标题', '\u000d', '姓名', '\u0007', '王诚', '\u0007', '\u000d', '正文段落', '\u000d'];
  const cps = [0];
  let text = '';
  for (const part of body) { text += part; cps.push(text.length); }
  const WORD_HEADER = 0x800, TABLE_HEADER = 0x600;
  const pieceBytes = Buffer.from(text, 'utf16le');
  const word = Buffer.alloc(WORD_HEADER + pieceBytes.length);
  word.writeUInt16LE(0xa5ec, 0); word.writeUInt16LE(193, 2); word.writeUInt16LE(0x0409, 6);
  word.writeUInt16LE(0, 10);
  word.writeUInt32LE(WORD_HEADER, 24); word.writeUInt32LE(WORD_HEADER + pieceBytes.length, 28);
  word.writeUInt32LE(text.length, 0x4c);
  pieceBytes.copy(word, WORD_HEADER);
  const pieces = cps.length - 1;
  // CLX: Prc array is empty, then the Pcdt (0x02) with a PlcPcd of n+1 CPs and n PCDs.
  const clxLength = 5 + (pieces + 1) * 4 + pieces * 8;
  const table = Buffer.alloc(TABLE_HEADER + clxLength);
  table.writeUInt8(0x02, TABLE_HEADER);
  table.writeUInt32LE(clxLength - 5, TABLE_HEADER + 1);
  for (let index = 0; index <= pieces; index++) table.writeUInt32LE(cps[index], TABLE_HEADER + 5 + index * 4);
  for (let index = 0; index < pieces; index++) {
    const base = TABLE_HEADER + 5 + (pieces + 1) * 4 + index * 8;
    table.writeUInt16LE(0, base);
    table.writeUInt32LE(WORD_HEADER + cps[index] * 2, base + 2);
  }
  // The FIB stores fcClx/lcbClx; the CLX itself lives at that offset in 1Table.
  word.writeUInt32LE(TABLE_HEADER, 0x1a2);
  word.writeUInt32LE(clxLength, 0x1a6);
  return writeCompound(t, 'legacy.doc', [{ name: 'WordDocument', data: word }, { name: '1Table', data: table }]);
}

test('legacy .doc and .ppt keep their document kind so artifact order is unchanged', () => {
  assert.equal(previewKind('report.doc'), 'document');
  assert.equal(previewKind('deck.PPT'), 'document');
  assert.equal(previewKind('book.docx'), 'word');
  assert.equal(previewKind('slides.pptx'), 'presentation');
});

test('a real Word 97-2003 document decodes text and table cells', t => {
  const file = wordDocument(t);
  assert.equal(isCompoundFile(file), true);
  assert.equal(isWordDocument(file), true);
  const preview = readDocPreview(file);
  const rows = preview.tables;
  assert.deepEqual(rows[0], ['姓名', '王诚']);
  assert.ok(preview.paragraphs.includes('标题'));
  assert.ok(preview.paragraphs.includes('正文段落'));
  assert.match(preview.html, /<td>王诚<\/td>/);
  assert.ok(extractDocText(file).includes('王诚'));
});

test('a non-Word OLE file is not misidentified as a document', t => {
  const file = writeCompound(t, 'other.doc', [{ name: 'Data', data: Buffer.from('not word') }]);
  assert.equal(isCompoundFile(file), true);
  assert.equal(isWordDocument(file), false);
  assert.throws(() => readDocPreview(file), /not a Word document/);
});

test('a PowerPoint record tree decodes slide text', t => {
  const slide = (text) => {
    const chars = Buffer.from(text, 'utf16le');
    const record = (type, body, container = false) => {
      const header = Buffer.alloc(8);
      header.writeUInt16LE((container ? 0xf : 0) | (0 << 4), 0);
      header.writeUInt16LE(type, 2); header.writeUInt32LE(body.length, 4);
      return Buffer.concat([header, body]);
    };
    return record(1006, Buffer.concat([record(3999, Buffer.alloc(4)), record(4000, chars)]), true);
  };
  const stream = Buffer.concat([slide('第一页标题'), slide('第二页要点')]);
  const document = Buffer.alloc(8);
  document.writeUInt16LE(0xf, 0); document.writeUInt16LE(1000, 2); document.writeUInt32LE(stream.length, 4);
  const file = writeCompound(t, 'legacy.ppt', [{ name: 'PowerPoint Document', data: Buffer.concat([document, stream]) }]);
  assert.equal(isLegacyPresentation(file), true);
  const preview = readPptPreview(file);
  assert.equal(preview.slides.length, 2);
  assert.deepEqual(preview.slides[0].shapes[0], ['第一页标题']);
  assert.match(preview.html, /Slide 2/);
  assert.ok(extractPptText(file).includes('第二页要点'));
});

test('a non-PowerPoint OLE file is not misidentified as a presentation', t => {
  const file = writeCompound(t, 'other.ppt', [{ name: 'PowerPoint Document', data: Buffer.from('not a record tree') }]);
  assert.equal(isLegacyPresentation(file), false);
  assert.throws(() => readPptPreview(file), /not a PowerPoint presentation/);
});
