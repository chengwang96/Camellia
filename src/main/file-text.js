'use strict';

// Plain-text extraction for /find's content search. The user's common case is
// "I know the file exists but not its name or path", so matching has to reach
// inside documents. Everything here is bounded: a huge or hostile file is
// skipped rather than allowed to stall the search.

const fs = require('node:fs');
const unzipper = require('unzipper');
const { DOMParser } = require('@xmldom/xmldom');
const { previewKind } = require('./file-preview');
const { isOleWorkbook, extractXlsText } = require('./xls-preview');
const { isWordDocument, extractDocText } = require('./doc-preview');
const { isLegacyPresentation, extractPptText } = require('./ppt-preview');

const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 512 * 1024;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;

const OFFICE_KINDS = new Set(['word', 'presentation', 'spreadsheet']);

// `readable` is called once per candidate file during a search walk, and the
// legacy-format probe reopens the file. The result is stable for the lifetime
// of a search, so cache it to keep the walk cheap.
const legacyCache = new Map();
function legacyKind(filePath) {
  if (legacyCache.has(filePath)) return legacyCache.get(filePath);
  let kind = '';
  try {
    if (isWordDocument(filePath)) kind = 'word';
    else if (isLegacyPresentation(filePath)) kind = 'presentation';
  } catch { kind = ''; }
  legacyCache.set(filePath, kind);
  return kind;
}

function readable(filePath) {
  const kind = previewKind(filePath);
  if (kind === 'text' || OFFICE_KINDS.has(kind)) return kind;
  // Legacy Word and PowerPoint binaries read through their own decoders.
  if (kind === 'document') return legacyKind(filePath);
  return '';
}

function decodeText(bytes) {
  // A NUL byte in the sampled prefix is the cheapest reliable signal that this
  // is not text, which keeps binary files out of the model's results.
  if (bytes.includes(0)) return '';
  return bytes.toString('utf8').replace(/\u0000/g, '');
}

function readTextFile(filePath) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const size = Math.min(fs.fstatSync(handle).size, MAX_SAMPLE_BYTES);
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(handle, buffer, 0, size, 0);
    return decodeText(buffer.subarray(0, read));
  } finally { fs.closeSync(handle); }
}

async function archiveTextOf(filePath, kind) {
  const archive = await unzipper.Open.file(filePath);
  if (archive.files.length > MAX_ARCHIVE_ENTRIES) return '';
  const entries = new Map(archive.files.map(entry => [entry.path, entry]));
  let total = 0;
  const parts = [];
  const partNames = kind === 'word' ? ['word/document.xml']
    : kind === 'presentation' ? archive.files.map(entry => entry.path).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      : [...['xl/sharedStrings.xml'], ...archive.files.map(entry => entry.path).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))];
  for (const name of partNames) {
    const entry = entries.get(name);
    if (!entry || entry.uncompressedSize > MAX_PART_BYTES) continue;
    const chunks = [];
    let size = 0, overBudget = false;
    for await (const chunk of entry.stream()) {
      size += chunk.length; total += chunk.length;
      if (size > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) { overBudget = true; break; }
      chunks.push(chunk);
    }
    if (overBudget) break;
    parts.push(Buffer.concat(chunks).toString('utf8'));
  }
  return parts.map(xmlText).join('\n').slice(0, MAX_TEXT_CHARS);
}

// Only text nodes matter for a keyword match, so a lenient parse is enough: a
// part that will not parse contributes nothing instead of failing the search.
function xmlText(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return '';
  let document;
  try { document = new DOMParser({ onError() {} }).parseFromString(source, 'text/xml'); }
  catch { return ''; }
  if (!document) return '';
  const collected = [];
  for (const node of Array.from(document.getElementsByTagName('*'))) {
    if (!['t', 'v'].includes(node.localName)) continue;
    const value = node.textContent;
    if (value) collected.push(value);
  }
  return collected.join(' ');
}

// Returns the searchable text of a supported file, or '' when the type cannot
// be read (media, PDF, legacy Office binaries, unknown extensions).
async function extractText(filePath, kind = readable(filePath)) {
  if (!kind) return '';
  try {
    if (kind === 'text') return readTextFile(filePath).slice(0, MAX_TEXT_CHARS);
    if (kind === 'spreadsheet' && isOleWorkbook(filePath)) return extractXlsText(filePath).slice(0, MAX_TEXT_CHARS);
    if (kind === 'word' && isWordDocument(filePath)) return extractDocText(filePath).slice(0, MAX_TEXT_CHARS);
    if (kind === 'presentation' && isLegacyPresentation(filePath)) return extractPptText(filePath).slice(0, MAX_TEXT_CHARS);
    if (OFFICE_KINDS.has(kind)) return (await archiveTextOf(filePath, kind)).slice(0, MAX_TEXT_CHARS);
  } catch { return ''; }
  return '';
}

module.exports = { extractText, readable, MAX_SAMPLE_BYTES, MAX_TEXT_CHARS };
module.exports.clearLegacyCache = () => legacyCache.clear();
