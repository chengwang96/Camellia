'use strict';

const { renderSheets } = require('./spreadsheet-render');
const { renderSlides } = require('./slide-render');

const children = (node, name) => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1 && (!name || child.localName === name));
const descendants = (node, name) => Array.from(node?.getElementsByTagName('*') || []).filter(child => child.localName === name);
const first = (node, name) => descendants(node, name)[0];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const attr = (node, name) => node?.getAttribute(name) || node?.getAttribute('w:' + name) || '';
const number = (value, fallback = 0) => Number.isFinite(Number(value)) && value !== '' ? Number(value) : fallback;
const color = value => /^[a-f\d]{6}$/i.test(value) ? '#' + value : '';
const enabled = node => node && !['0', 'false', 'off'].includes(attr(node, 'val'));

function runStyle(properties, drawing = false, slideWidth = 720) {
  const styles = [];
  if (drawing ? attr(properties, 'b') === '1' : enabled(first(properties, 'b'))) styles.push('font-weight:700');
  if (drawing ? attr(properties, 'i') === '1' : enabled(first(properties, 'i'))) styles.push('font-style:italic');
  if (drawing ? attr(properties, 'u') && attr(properties, 'u') !== 'none' : enabled(first(properties, 'u'))) styles.push('text-decoration:underline');
  const size = drawing ? number(attr(properties, 'sz')) / 100 : number(attr(first(properties, 'sz'), 'val')) / 2;
  if (size > 0) styles.push(drawing ? `font-size:${Math.min(size, 200) / slideWidth * 100}cqw` : `font-size:${Math.min(size, 200)}pt`);
  const ink = color(drawing ? attr(first(properties, 'srgbClr'), 'val') : attr(first(properties, 'color'), 'val'));
  if (ink) styles.push(`color:${ink}`);
  return styles.join(';');
}

async function paragraph(node, context, drawing = false) {
  const properties = children(node, 'pPr')[0];
  const alignment = drawing ? attr(properties, 'algn') : attr(first(properties, 'jc'), 'val');
  const align = { center: 'center', ctr: 'center', right: 'right', r: 'right', both: 'justify', just: 'justify' }[alignment] || 'left';
  const styleName = attr(first(properties, 'pStyle'), 'val');
  const heading = /^Heading([1-6])$/i.exec(styleName);
  const tag = heading ? 'h' + heading[1] : styleName === 'Title' ? 'h1' : 'p';
  const parts = [];
  for (const run of descendants(node, 'r')) {
    const content = [];
    for (const part of children(run)) {
      if (part.localName === 't') content.push(escape(part.textContent));
      if (part.localName === 'br') content.push('<br>');
      if (part.localName === 'tab') content.push('&#8195;');
      if (['drawing', 'pict'].includes(part.localName)) content.push(await images(part, context));
    }
    const properties = children(run, 'rPr')[0];
    parts.push(`<span style="${runStyle(properties, drawing, context.slideWidth)}">${content.join('')}</span>`);
  }
  if (!parts.length) parts.push(descendants(node, 't').map(part => escape(part.textContent)).join(''));
  const bullet = first(properties, 'numPr') || first(properties, 'buChar');
  return `<${tag} style="text-align:${align}">${bullet ? '• ' : ''}${parts.join('') || '<br>'}</${tag}>`;
}

async function images(node, context) {
  const result = [];
  for (const blip of descendants(node, 'blip').slice(0, 100)) {
    const target = context.relations.get(attr(blip, 'r:embed'));
    const source = target && await context.image(target);
    if (source) result.push(`<img src="${source}" alt="">`);
  }
  return result.join('');
}

async function wordBlocks(node, context, depth = 0) {
  if (depth > 8) return '';
  const result = [];
  for (const block of children(node).slice(0, 2000)) {
    if (block.localName === 'p') result.push(await paragraph(block, context));
    else if (block.localName === 'tbl') {
      const rows = [];
      for (const row of children(block, 'tr').slice(0, 300)) {
        const cells = [];
        for (const cell of children(row, 'tc').slice(0, 50)) {
          const span = Math.max(1, Math.min(50, number(attr(first(cell, 'gridSpan'), 'val'), 1)));
          const fill = color(attr(first(children(cell, 'tcPr')[0], 'shd'), 'fill'));
          cells.push(`<td colspan="${span}" style="${fill ? 'background:' + fill : ''}">${await wordBlocks(cell, context, depth + 1)}</td>`);
        }
        rows.push('<tr>' + cells.join('') + '</tr>');
      }
      result.push('<table>' + rows.join('') + '</table>');
    } else if (['sdt', 'sdtContent'].includes(block.localName)) result.push(await wordBlocks(block, context, depth + 1));
  }
  return result.join('');
}

async function renderOfficeDocument(kind, reader, sections) {
  const { xml, relationships, image } = reader;
  let body = '';
  if (kind === 'word') {
    const document = await xml('word/document.xml');
    const relations = await relationships('word/document.xml', true);
    body = '<article class="paper">' + await wordBlocks(first(document, 'body'), { relations, image }) + '</article>';
  } else if (kind === 'presentation') {
    const rendered = await renderSlides(reader, sections);
    body = rendered.html;
    reader.truncated ||= rendered.truncated;
  } else {
    const renderedSheets = await renderSheets(reader, sections);
    reader.sheets?.push(...renderedSheets);
    body = renderedSheets.map(sheet => sheet.html).join('');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:20px;background:#e9ebee;color:#202124;font:15px/1.55 Arial,sans-serif}
    .paper{max-width:850px;min-height:100vh;margin:auto;padding:48px;background:white;box-shadow:0 2px 12px #0001}
    p{white-space:pre-wrap;margin:0 0 10px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}
    table{border-collapse:collapse;background:white}td,th{border:1px solid #cdd2d8;padding:6px 10px;vertical-align:top}td p:last-child{margin:0}
    .sheet{margin-bottom:24px;overflow:auto;max-height:calc(100vh - 40px)}.sheet td{white-space:pre-wrap;overflow:hidden}.sheet th{background:#f2f4f6;font-weight:400}.sheet thead{position:sticky;top:0;z-index:4;height:32px}.sheet h2{font-size:16px}.sheet table{border-collapse:separate;border-spacing:0}
    .slide-page{margin:0 auto 24px;max-width:1100px}.slide-page h2{font:13px Arial;color:#525962}.slide{position:relative;overflow:hidden;box-shadow:0 2px 12px #0002;container-type:inline-size}
    .shape,.group,.picture,.connector,.chart{position:absolute}.shape p{line-height:1.25;margin:0}.group>.shape,.group>.picture,.group>.connector,.group>.chart,.group>.group{position:absolute}
    .picture{overflow:hidden}.picture img{display:block;width:100%;height:100%;object-fit:contain}.picture.missing{display:flex;align-items:center;justify-content:center;background:#f2f4f6;border:1px dashed #c3c9d0;color:#525962;font:11px Arial;overflow:hidden}
    .chart{overflow:hidden;background:#ffffff;border:1px solid #e1e4e8;padding:.5cqw;font:11px Arial}.chart strong{display:block;font-size:1.2cqw}.chart table{border-collapse:collapse;width:100%}.chart th,.chart td{border:1px solid #e1e4e8;padding:1px 3px;text-align:right;font-weight:400}.chart th:first-child{text-align:left}
    @media(max-width:600px){body{padding:12px}.paper{padding:24px}}
  </style></head><body>${body}</body></html>`;
}

module.exports = { renderOfficeDocument };
