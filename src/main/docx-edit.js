'use strict';

// Text editing for OOXML Word documents. The preview only needs rendered HTML,
// but an edit must map back to the original XML: a paragraph is not a single
// node, and Word splits prose across several `<w:t>` runs (formatting, spelling
// marks, fields). This module builds a small block model over word/document.xml
// and edits a block by replacing its run text in place.
//
// Only word/document.xml is recompressed. Pictures, charts, media, headers and
// every other package part are copied unchanged, so an edit never rewrites the
// parts the preview does not understand.

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const JSZip = require('jszip');

const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BLOCKS = 2000;
const DOCUMENT_PART = 'word/document.xml';

const escapeText = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function codePoint(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0x10ffff) return null;
  try { return String.fromCodePoint(number); } catch { return null; }
}

function textOf(source) {
  return String(source ?? '').replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => codePoint(parseInt(hex, 16)) ?? match)
    .replace(/&#(\d+);/g, (match, decimal) => codePoint(decimal) ?? match)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// A paragraph's editable text is the concatenation of the text runs in that
// paragraph, not in a text box nested inside it. Nested paragraphs belong to a
// different Word story, so they are skipped in both directions: their text is
// not shown here, and an edit to the outer paragraph never touches them.
function paragraphText(inner) {
  let output = '';
  let depth = 0;
  const token = /<w:p\b[^>]*>|<\/w:p>|<w:t\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g;
  let match;
  while ((match = token.exec(inner))) {
    const value = match[0];
    if (value.startsWith('<w:p')) {
      if (!value.endsWith('/>')) depth += 1;
      continue;
    }
    if (value === '</w:p>') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (value.startsWith('<w:tab')) output += '\t';
    else if (value.startsWith('<w:br') || value.startsWith('<w:cr')) output += '\n';
    else if (value.startsWith('<w:t')) output += textOf(match[2]);
  }
  return output;
}

// Returns the index just past the matching closing tag for a nested container.
// Word documents are well-formed XML, so depth counting is sufficient and much
// cheaper than building a DOM for an 8 MiB body.
function findMatching(source, start, tag) {
  const escaped = escapeRegExp(tag);
  const pattern = new RegExp(`<${escaped}(?=[\\s>/])|</${escaped}>`, 'g');
  pattern.lastIndex = start;
  let depth = 0, match;
  while ((match = pattern.exec(source))) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!match[0].endsWith('/>')) depth += 1;
    if (depth === 0) return match.index + match[0].length;
    if (depth < 0) return -1;
  }
  return -1;
}

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scanParagraphs(source) {
  const blocks = [];
  let truncated = false;
  let depth = 0, start = -1, innerStart = -1;
  const pattern = /<w:p\b[^>]*>|<\/w:p>/g;
  let match;
  while ((match = pattern.exec(source))) {
    const value = match[0];
    if (value.startsWith('<w:p')) {
      if (depth === 0) {
        if (blocks.length >= MAX_BLOCKS) { truncated = true; break; }
        if (value.endsWith('/>')) {
          blocks.push({ index: blocks.length, text: '', start: match.index, end: match.index + value.length, inner: '', locked: false });
          continue;
        }
        start = match.index; innerStart = match.index + value.length;
      }
      if (!value.endsWith('/>')) depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0 && start >= 0) {
      const innerEnd = match.index;
      const inner = source.slice(innerStart, innerEnd);
      blocks.push({
        index: blocks.length, text: paragraphText(inner),
        start: innerStart, end: innerEnd, inner, locked: hasDirectPageBreak(inner),
      });
      start = innerStart = -1;
    }
  }
  return { blocks, truncated };
}

// Ranges occupied by nested paragraphs (text boxes and similar stories).
function rangesOfNestedParagraphs(inner) {
  const ranges = [];
  const pattern = /<w:p\b[^>]*>/g;
  let match;
  while ((match = pattern.exec(inner))) {
    const close = findMatching(inner, match.index, 'w:p');
    if (close < 0) break;
    ranges.push([match.index, close]);
    pattern.lastIndex = close;
  }
  return ranges;
}

function hasDirectPageBreak(inner) {
  const nested = rangesOfNestedParagraphs(inner);
  const pattern = /<w:br\b[^>]*\/>/g;
  let match;
  while ((match = pattern.exec(inner))) {
    if (!/\b(?:w:)?type\s*=\s*["']page["']/i.test(match[0])) continue;
    if (nested.some(([start, end]) => match.index >= start && match.index < end)) continue;
    return true;
  }
  return false;
}

function encodedText(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  let output = '', buffer = '';
  const flush = () => {
    if (!buffer) return;
    output += `<w:t xml:space="preserve">${escapeText(buffer)}</w:t>`;
    buffer = '';
  };
  for (const character of text) {
    if (character === '\t') { flush(); output += '<w:tab/>'; }
    else if (character === '\n') { flush(); output += '<w:br/>'; }
    else buffer += character;
  }
  flush();
  return output || '<w:t xml:space="preserve"></w:t>';
}

function replaceParagraphText(inner, text) {
  // Only text tokens directly in this paragraph are replaced. A nested text
  // box is left byte-identical, including its own runs.
  const nested = rangesOfNestedParagraphs(inner);
  const tokens = [];
  const pattern = /<w:t\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g;
  for (const match of inner.matchAll(pattern)) {
    if (nested.some(([start, end]) => match.index >= start && match.index < end)) continue;
    // A page break is a layout object, not editable text. Keep the paragraph
    // out of the editor instead of silently turning it into a line break.
    if (match[0].startsWith('<w:br') && /\b(?:w:)?type\s*=\s*["']page["']/i.test(match[0])) {
      throw new Error('This paragraph contains a page break and cannot be edited.');
    }
    tokens.push({ index: match.index, length: match[0].length });
  }
  if (!tokens.length) throw new Error('This paragraph has no editable text.');
  // Replace the whole direct text sequence with one formatted run. Existing
  // non-text children (drawings, bookmarks, fields) remain in place.
  const replacement = encodedText(text);
  let output = '', cursor = 0;
  for (const [index, token] of tokens.entries()) {
    output += inner.slice(cursor, token.index);
    if (index === 0) output += replacement;
    cursor = token.index + token.length;
  }
  return output + inner.slice(cursor);
}

function revision(bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return digest;
}

function isDocx(pathname) {
  return path.extname(pathname).toLowerCase() === '.docx';
}

async function readDocxEdit(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error('This Word document is too large to edit.');
  const source = fs.readFileSync(filePath);
  let archive;
  try { archive = await JSZip.loadAsync(source); }
  catch { throw new Error('This Word document is not a valid DOCX package.'); }
  const part = archive.file(DOCUMENT_PART);
  if (!part) throw new Error('This Word document has no main body.');
  const content = await part.async('string');
  if (Buffer.byteLength(content) > MAX_PART_BYTES) throw new Error('This Word document body is too large to edit.');
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('Unsupported Office XML declaration.');
  const { blocks, truncated } = scanParagraphs(content);
  return {
    blocks: blocks.map(block => block.text),
    editability: blocks.map(block => !block.locked
      && (!block.inner || /<w:t\b/.test(block.inner) || /<(?:w:tab|w:br|w:cr)\b/.test(block.inner))),
    truncated,
    revision: revision(source),
    sourceRevision: revision(Buffer.from(content, 'utf8')),
    path: filePath,
  };
}

async function saveDocxEdit(snapshot, edits) {
  if (!Array.isArray(edits)) throw new Error('Invalid Word edits.');
  if (edits.some(edit => !Number.isInteger(edit?.index) || typeof edit.text !== 'string'
    || edit.text.includes('\0') || !edit.text.isWellFormed())) throw new Error('Enter valid text without null characters.');
  if (edits.length > MAX_BLOCKS) throw new Error('Too many Word paragraphs were edited at once.');
  if (new Set(edits.map(edit => edit.index)).size !== edits.length) throw new Error('Duplicate Word paragraph edits.');
  const current = fs.readFileSync(snapshot.path);
  if (revision(current) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
  const archive = await JSZip.loadAsync(current);
  const part = archive.file(DOCUMENT_PART);
  if (!part) throw new Error('This Word document has no main body.');
  const content = await part.async('string');
  if (revision(Buffer.from(content, 'utf8')) !== snapshot.sourceRevision) throw new Error('The Word document changed in memory. Reopen it before saving.');
  const { blocks } = scanParagraphs(content);
  const ordered = [...edits].sort((a, b) => b.index - a.index);
  let updated = content;
  for (const edit of ordered) {
    if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= blocks.length) throw new Error('The Word paragraph layout changed on disk.');
    const block = blocks[edit.index];
    if (edit.text === block.text) continue;
    if (block.locked) throw new Error('This paragraph contains a page break and cannot be edited.');
    if (snapshot.editability?.[edit.index] === false) throw new Error('This paragraph contains a page break and cannot be edited.');
    // A paragraph that only holds a picture has no text tokens to replace.
    // Tabs and line breaks are editable text, even without a <w:t>.
    if (!block.inner || !/<(?:w:t|w:tab|w:br|w:cr)\b/.test(block.inner)) {
      if (edit.text === '' && blocks[edit.index].text === '') continue;
      throw new Error('This paragraph has no editable text.');
    }
    const replaced = replaceParagraphText(block.inner, edit.text);
    updated = updated.slice(0, block.start) + replaced + updated.slice(block.end);
  }
  if (updated !== content) archive.file(DOCUMENT_PART, updated, { date: new Date(), createFolders: false });
  if (updated === content) {
    return { file: { size: current.length, modifiedAt: fs.statSync(snapshot.path).mtimeMs }, snapshot: { ...snapshot } };
  }
  const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (bytes.length > MAX_FILE_BYTES) throw new Error('The edited Word document is too large.');

  const target = fs.realpathSync.native(snapshot.path);
  fs.accessSync(target, fs.constants.W_OK);
  const temporary = path.join(path.dirname(target), `.camellia-office-${randomUUID()}.tmp`);
  let replaced = false;
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, bytes);
      if (process.platform !== 'win32') fs.fchmodSync(handle, fs.statSync(target).mode & 0o777);
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    if (revision(fs.readFileSync(target)) !== snapshot.revision) throw new Error('The file changed on disk. Reopen the document before saving.');
    fs.renameSync(temporary, target);
    replaced = true;
    const saved = fs.statSync(target);
    const next = await readDocxEdit(target);
    return { file: { size: saved.size, modifiedAt: saved.mtimeMs, editRevision: next.revision }, snapshot: next };
  } finally {
    if (!replaced) try { fs.unlinkSync(temporary); } catch {}
  }
}

module.exports = { isDocx, readDocxEdit, saveDocxEdit, DOCUMENT_PART };
