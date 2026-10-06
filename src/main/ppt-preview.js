'use strict';

// Legacy `.ppt` files are OLE2/CFBF containers holding a PowerPoint record
// stream, not ZIP+XML, so the OOXML slide renderer cannot read them. This module
// walks the `PowerPoint Document` record tree, groups the Slide containers, and
// decodes their TextChars (UTF-16LE) and TextBytes (ANSI) payloads. Layout,
// themes and images are out of scope; the preview lists readable slide text.

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 1 << 20;
const MAX_SLIDES = 100;
const MAX_SHAPES = 200;

// RT_* record types from the PowerPoint binary format.
const RT_DOCUMENT = 1000, RT_SLIDE = 1006, RT_NOTES = 1008, RT_MAIN_MASTER = 1016;
const RT_TEXT_HEADER = 3999, RT_TEXT_CHARS = 4000, RT_TEXT_BYTES = 4001;
const RT_CSTRING = 4026;
const CONTAINER = 0xf;

// Vertical tab, form feed and control bytes carry no readable content. CR is
// kept long enough to become a line break.
const CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\ufeff]/g;

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function isLegacyPresentation(filePath) {
  const { isCompoundFile, readCompoundFile } = require('./ole-container');
  if (!isCompoundFile(filePath)) return false;
  try {
    const context = readCompoundFile(filePath);
    const document = context.findStream('PowerPoint Document');
    if (!document) return false;
    const stream = context.readStream(document);
    return stream.length >= 8 && (stream.readUInt16LE(0) & 0xf) === CONTAINER && stream.readUInt16LE(2) === RT_DOCUMENT;
  } catch { return false; }
}

function* records(stream, start, end, depth = 0) {
  if (depth > 64) return;
  let cursor = start;
  while (cursor + 8 <= end) {
    const header = stream.readUInt16LE(cursor);
    const version = header & 0xf, instance = header >> 4;
    const type = stream.readUInt16LE(cursor + 2);
    const length = stream.readUInt32LE(cursor + 4);
    const body = cursor + 8, next = body + length;
    if (next > end || next > stream.length) return;
    yield { version, instance, type, length, body };
    if (version === CONTAINER) yield* records(stream, body, next, depth + 1);
    cursor = next;
  }
}

// A TextBytes run is code points from the file's ANSI code page. Real prose is
// mostly letters and separators; a raw binary record is not, so it is dropped.
function readableAnsi(value) {
  if (!value) return '';
  let good = 0, total = 0;
  for (const character of value) {
    total += 1;
    const code = character.charCodeAt(0);
    if (code >= 0x20 || code === 0x0d || code === 0x0a || code === 0x09) good += 1;
    else if (code >= 0x80) good += 0.5;
  }
  return total && good / total >= 0.75 ? value : '';
}

function collectSlides(stream) {
  const all = [...records(stream, 0, stream.length)];
  const slides = [];
  // A SlideContainer's records are contiguous and run until the next container
  // of the same or higher level, so the flat record list can be sliced.
  const starts = all.map((record, index) => record.type === RT_SLIDE && record.version === CONTAINER ? index : -1).filter(index => index >= 0);
  for (const start of starts.slice(0, MAX_SLIDES)) {
    const container = all[start];
    const items = [];
    for (let index = start + 1; index < all.length; index++) {
      const record = all[index];
      if (record.type === RT_SLIDE && record.version === CONTAINER) break;
      if (record.type === RT_SLIDE && record.version !== CONTAINER) break;
      if (record.type !== RT_TEXT_BYTES && record.type !== RT_TEXT_CHARS && record.type !== RT_CSTRING) continue;
      if (record.body <= container.body) continue;
      let text;
      if (record.type === RT_TEXT_CHARS) text = stream.toString('utf16le', record.body, record.body + record.length);
      else text = readableAnsi(stream.toString('latin1', record.body, record.body + record.length));
      text = text.replace(CONTROL, '').trim();
      if (text) items.push(text);
      if (items.length >= MAX_SHAPES) break;
    }
    const shapes = items.map(item => item.split(/\r+/).map(line => line.trim()).filter(Boolean)).filter(lines => lines.length);
    if (shapes.length) slides.push({ index: slides.length + 1, shapes });
  }
  return slides;
}

function renderSlides(slides) {
  let html = '';
  for (const slide of slides) {
    html += `<section class="slide-page"><h2>Slide ${slide.index}</h2><div class="slide-text">`;
    for (const shape of slide.shapes) {
      html += '<div class="slide-shape">' + shape.map(line => `<p>${escape(line)}</p>`).join('') + '</div>';
    }
    html += '</div></section>';
  }
  return html;
}

function buildPreview(filePath) {
  const { readCompoundFile } = require('./ole-container');
  if (require('node:fs').statSync(filePath).size > MAX_FILE_BYTES) throw new Error('This presentation is too large to preview.');
  const context = readCompoundFile(filePath);
  const entry = context.findStream('PowerPoint Document');
  if (!entry) throw new Error('This file is not a PowerPoint presentation.');
  const stream = context.readStream(entry);
  if (stream.length < 8 || (stream.readUInt16LE(0) & 0xf) !== CONTAINER || stream.readUInt16LE(2) !== RT_DOCUMENT) {
    throw new Error('This file is not a PowerPoint presentation.');
  }
  const slides = collectSlides(stream);
  return { slides, truncated: slides.length >= MAX_SLIDES };
}

function readPptPreview(filePath) {
  const preview = buildPreview(filePath);
  const { renderDocumentHtml } = require('./office-render');
  const style = '<style>.slide-page{margin:0 auto 24px;max-width:1100px}.slide-page h2{font:13px Arial;color:#525962}.slide-text{background:#fff;box-shadow:0 2px 12px #0002;padding:28px 32px}.slide-shape{margin-bottom:16px}.slide-shape p{margin:0 0 6px;overflow-wrap:anywhere}</style>';
  const body = '<div class="legacy-slides">' + renderSlides(preview.slides) + '</div>';
  return { html: renderDocumentHtml(body).replace('</head>', style + '</head>'), slides: preview.slides, truncated: preview.truncated };
}

function extractPptText(filePath) {
  try {
    return buildPreview(filePath).slides.map(slide => slide.shapes.map(shape => shape.join('\n')).join('\n')).join('\n').slice(0, 512 * 1024);
  } catch { return ''; }
}

module.exports = { isLegacyPresentation, readPptPreview, extractPptText };
