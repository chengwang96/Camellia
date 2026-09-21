'use strict';

const path = require('node:path');
const fs = require('node:fs');
const unzipper = require('unzipper');
const { DOMParser } = require('@xmldom/xmldom');

const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const children = (node, name) => Array.from(node.childNodes || []).filter(child => child.nodeType === 1 && child.localName === name);
const descendants = (node, name) => Array.from(node.getElementsByTagName('*')).filter(child => child.localName === name);
const runs = node => descendants(node, 't').map(part => part.textContent).join('');

async function readOfficePreview(filePath, kind) {
  if (fs.statSync(filePath).size > 100 * 1024 * 1024) throw new Error('This Office file is too large to preview.');
  const archive = await unzipper.Open.file(filePath);
  if (archive.files.length > 10000) throw new Error('This Office file is too large to preview.');
  const entries = new Map(archive.files.map(entry => [entry.path, entry]));
  let bytesRead = 0;
  async function xml(name, optional = false) {
    const entry = entries.get(name);
    if (!entry) {
      if (optional) return null;
      throw new Error('The Office file is missing ' + name);
    }
    if (entry.uncompressedSize > MAX_PART_BYTES) throw new Error('This Office file is too large to preview.');
    const chunks = [];
    let size = 0;
    for await (const chunk of entry.stream()) {
      size += chunk.length; bytesRead += chunk.length;
      if (size > MAX_PART_BYTES || bytesRead > MAX_TOTAL_BYTES) throw new Error('This Office file is too large to preview.');
      chunks.push(chunk);
    }
    const source = Buffer.concat(chunks).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Unsupported Office XML declaration.');
    return new DOMParser({ onError(level, message) { if (level !== 'warning') throw new Error(message); } }).parseFromString(source, 'text/xml');
  }
  async function relationships(base) {
    const document = await xml(path.posix.join(path.posix.dirname(base), '_rels', path.posix.basename(base) + '.rels'));
    return new Map(descendants(document, 'Relationship').filter(node => node.getAttribute('TargetMode') !== 'External')
      .map(node => {
        const target = node.getAttribute('Target');
        return [node.getAttribute('Id'), path.posix.normalize(target.startsWith('/') ? target : path.posix.join(path.posix.dirname(base), target)).replace(/^\//, '')];
      }));
  }
  const sections = [];
  let truncated = false;
  if (kind === 'word') {
    const document = await xml('word/document.xml');
    const paragraphs = descendants(document, 'p');
    truncated = paragraphs.length > 2000;
    sections.push({ title: '', paragraphs: paragraphs.slice(0, 2000).map(runs) });
  } else if (kind === 'presentation') {
    const document = await xml('ppt/presentation.xml');
    const relations = await relationships('ppt/presentation.xml');
    const slides = descendants(document, 'sldId');
    truncated = slides.length > 100;
    for (const [index, slide] of slides.slice(0, 100).entries()) {
      const target = relations.get(slide.getAttribute('r:id'));
      if (!target) continue;
      const content = await xml(target);
      const paragraphs = descendants(content, 'p');
      truncated ||= paragraphs.length > 500;
      sections.push({ title: String(index + 1), paragraphs: paragraphs.slice(0, 500).map(runs) });
    }
  } else {
    const document = await xml('xl/workbook.xml');
    const relations = await relationships('xl/workbook.xml');
    const strings = await xml('xl/sharedStrings.xml', true);
    const shared = strings ? descendants(strings, 'si').map(runs) : [];
    const sheets = descendants(document, 'sheet');
    truncated = sheets.length > 30;
    for (const sheet of sheets.slice(0, 30)) {
      const target = relations.get(sheet.getAttribute('r:id'));
      if (!target) continue;
      const content = await xml(target);
      const sourceRows = descendants(content, 'row');
      truncated ||= sourceRows.length > 300;
      const rows = sourceRows.slice(0, 300).map(row => {
        const values = [];
        for (const cell of children(row, 'c')) {
          const reference = /^([A-Z]+)\d+$/.exec(cell.getAttribute('r'));
          const column = reference ? [...reference[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1 : values.length;
          if (column >= 50) { truncated = true; continue; }
          const value = children(cell, 'v')[0]?.textContent || '';
          const type = cell.getAttribute('t');
          const formula = children(cell, 'f')[0]?.textContent;
          values[column] = type === 's' ? shared[Number(value)] || '' : type === 'inlineStr' ? runs(cell)
            : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : value || (formula ? '=' + formula : '');
        }
        return { number: row.getAttribute('r'), cells: Array.from(values, value => value || '') };
      });
      sections.push({ title: sheet.getAttribute('name'), rows });
    }
  }
  return { sections, truncated };
}

module.exports = { readOfficePreview };
