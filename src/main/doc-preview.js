'use strict';

// Legacy `.doc` files are OLE2/CFBF containers holding a Word 97-2003 FIB and a
// piece table, not ZIP+XML, so the OOXML previewer cannot read them. This module
// decodes the bounded part needed for a text-and-tables preview: the FIB header,
// the CLX/piece table (compressed 8-bit runs and uncompressed UTF-16 runs),
// table cell/row marks, and paragraph breaks. Rich formatting is out of scope.

// FIB: the fixed 32-byte header is followed by csw/cslw/cbRgFcLcb/cswNew/cslwNew,
// and fcClx is the (fc, lcb) pair at index 33 of the FcLcb array. Because the
// variable-length FibRgW04/FibRgLw04 blocks sit before the array, fcClx lives at
// a constant offset 0x01A2 in Word 97-2003 files.
const CLX_OFFSET = 0x01a2;
// FibRgLw97: ccpText is index 3, so it sits at the fixed offset 0x004c.
const CCP_TEXT_OFFSET = 0x004c;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PIECES = 100000;
const MAX_TABLE = 64 * 1024 * 1024;

const PARAGRAPH = 0x0d, CELL_END = 0x07, LINE_BREAK = 0x0b, PAGE_BREAK = 0x0c;
// Word's special "fields" and object anchors; they carry no readable text.
const SPECIAL = /[\u0001\u0002\u0004\u0005\u0006\u0008\u0013\u0014\u0015\u0016\u0017\u0019\u001a\u001b\u001c\u001d\u001e\u001f\u00ad\u200b\ufeff]/g;

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function isWordDocument(filePath) {
  const { isCompoundFile, readCompoundFile } = require('./ole-container');
  if (!isCompoundFile(filePath)) return false;
  try {
    const context = readCompoundFile(filePath);
    const word = context.findStream('WordDocument');
    if (!word) return false;
    const header = context.readStream(word);
    return header.length >= 4 && header.readUInt16LE(0) === 0xa5ec;
  } catch { return false; }
}

// The CLX is a Prc list followed by one Pcdt whose PlcPcd is a (n+1)-entry CP
// array plus n PCDs. A compressed PCD addresses CPi bytes; an uncompressed one
// addresses CPi UTF-16 code units, so the byte offset is 2*fc.
function readPieceTable(context, word) {
  if (word.length < CLX_OFFSET + 8) throw new Error('This Word file has a truncated header.');
  const flags = word.readUInt16LE(10);
  if (flags & 0x0100) throw new Error('This Word file is encrypted and cannot be previewed.');
  const tableName = flags & 0x0200 ? '0Table' : '1Table';
  const tableEntry = context.findStream(tableName) || context.findStream(tableName === '0Table' ? '1Table' : '0Table');
  if (!tableEntry) throw new Error('This Word file is missing its piece table.');
  const table = context.readStream(tableEntry);
  const fcClx = word.readUInt32LE(CLX_OFFSET), lcbClx = word.readUInt32LE(CLX_OFFSET + 4);
  if (fcClx + lcbClx > table.length || lcbClx > MAX_TABLE) throw new Error('This Word file has an invalid piece table.');

  let position = fcClx;
  const end = fcClx + lcbClx;
  while (position + 5 <= end && table.readUInt8(position) === 0x01) {
    const length = table.readUInt16LE(position + 1);
    position += 3 + length;
  }
  if (position + 5 > end || table.readUInt8(position) !== 0x02) throw new Error('This Word file has an unsupported piece table.');
  const plcLength = table.readUInt32LE(position + 1);
  const plc = position + 5;
  if (plcLength < 4 || plc + plcLength > end + 4) throw new Error('This Word file has a truncated piece table.');
  const pieces = (plcLength - 4) / 12;
  if (pieces < 1 || pieces > MAX_PIECES) throw new Error('This Word file has an unsupported piece count.');
  const cps = [], descriptors = [];
  for (let index = 0; index <= pieces; index++) cps.push(table.readUInt32LE(plc + index * 4));
  for (let index = 0; index < pieces; index++) {
    const base = plc + (pieces + 1) * 4 + index * 8;
    descriptors.push({ fc: table.readUInt32LE(base + 2), compressed: Boolean(table.readUInt32LE(base + 2) & 0x40000000) });
  }
  if (cps[pieces] <= cps[0]) throw new Error('This Word file has an empty text stream.');
  // The CLX lives in the table stream, but the piece bytes it points at are in
  // the WordDocument stream.
  return { word, cps, descriptors };
}

// Compressed runs are code points in cp1252, with 0x80-0x9F mapped through a
// small table that the legacy ANSI code page does not cover.
const COMPRESSED_HIGH = [0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178];

function extractText(context, word) {
  const { word: source, cps, descriptors } = readPieceTable(context, word);
  const chunks = [];
  for (let index = 0; index < descriptors.length; index++) {
    const characters = cps[index + 1] - cps[index];
    if (characters <= 0) continue;
    const { fc, compressed } = descriptors[index];
    if (compressed) {
      const start = fc / 2, byteLength = characters;
      if (start < 0 || start + byteLength > source.length) continue;
      let text = '';
      for (let offset = 0; offset < byteLength; offset++) {
        const byte = source.readUInt8(start + offset);
        text += byte >= 0x80 && byte <= 0x9f ? String.fromCharCode(COMPRESSED_HIGH[byte - 0x80]) : String.fromCharCode(byte);
      }
      chunks.push(text);
    } else {
      const start = fc;
      if (start < 0 || start + characters * 2 > source.length) continue;
      chunks.push(source.toString('utf16le', start, start + characters * 2));
    }
  }
  // A document's CP stream continues past the body into headers, footnotes and
  // text boxes. Only the first ccpText characters are the main story.
  const text = chunks.join('');
  const ccpText = word.length >= CCP_TEXT_OFFSET + 4 ? word.readUInt32LE(CCP_TEXT_OFFSET) : text.length;
  return ccpText > 0 && ccpText < text.length ? text.slice(0, ccpText) : text;
}

function textBlocks(text) {
  const blocks = [];
  let row = [];
  let cell = '';
  // A cell ends at the bell marker, a row ends at the paragraph mark that closes
  // it, and text between those markers is the cell body.
  const flushCell = () => { row.push(cell.replace(SPECIAL, '').replace(/[\r\n]+$/, '')); cell = ''; };
  const flushRow = () => { flushCell(); if (row.some(value => value !== '')) blocks.push({ type: 'table', rows: [row] }); row = []; };
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code === CELL_END) { flushCell(); continue; }
    if (code === PARAGRAPH) {
      if (row.length) { flushCell(); if (row.some(value => value !== '')) blocks.push({ type: 'table', rows: [row] }); row = []; }
      else { const paragraph = cell.replace(SPECIAL, '').trim(); if (paragraph) blocks.push({ type: 'paragraph', text: paragraph }); }
      cell = '';
      continue;
    }
    if (code === LINE_BREAK || code === PAGE_BREAK) { cell += '\n'; continue; }
    cell += character;
  }
  if (cell.trim() || row.length) { flushRow(); }
  return blocks;
}

function renderBlocks(blocks) {
  let html = '';
  for (const block of blocks) {
    if (block.type === 'paragraph') { html += `<p>${escape(block.text)}</p>`; continue; }
    html += '<table>';
    for (const row of block.rows) html += '<tr>' + row.map(value => `<td>${escape(value)}</td>`).join('') + '</tr>';
    html += '</table>';
  }
  return html;
}

function buildPreview(filePath) {
  const { readCompoundFile } = require('./ole-container');
  if (require('node:fs').statSync(filePath).size > MAX_FILE_BYTES) throw new Error('This document is too large to preview.');
  const context = readCompoundFile(filePath);
  const wordEntry = context.findStream('WordDocument');
  if (!wordEntry) throw new Error('This file is not a Word document.');
  const word = context.readStream(wordEntry);
  if (word.readUInt16LE(0) !== 0xa5ec) throw new Error('This file is not a Word document.');
  const text = extractText(context, word);
  const blocks = textBlocks(text);
  const paragraphs = blocks.filter(block => block.type === 'paragraph').map(block => block.text);
  const tables = blocks.filter(block => block.type === 'table').flatMap(block => block.rows.map(row => row.filter(value => value !== '')));
  return { blocks, paragraphs, tables, plain: paragraphs.join('\n') + '\n' + tables.map(row => row.join(' ')).join('\n') };
}

function readDocPreview(filePath) {
  const preview = buildPreview(filePath);
  const { renderDocumentHtml } = require('./office-render');
  const body = '<article class="paper">' + renderBlocks(preview.blocks) + '</article>';
  return { html: renderDocumentHtml(body), blocks: preview.blocks, paragraphs: preview.paragraphs, tables: preview.tables };
}

function extractDocText(filePath) {
  try { return buildPreview(filePath).plain.slice(0, 512 * 1024); } catch { return ''; }
}

module.exports = { isWordDocument, readDocPreview, extractDocText };
