'use strict';

const SSF = require('ssf');
const descendants = (node, name) => Array.from(node?.getElementsByTagName('*') || []).filter(child => child.localName === name);
const children = (node, name) => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1 && child.localName === name);
const first = (node, name) => descendants(node, name)[0];
const attr = (node, name) => node?.getAttribute(name) || '';
const numeric = (value, fallback = 0) => value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const color = value => /^[a-f\d]{6}$/i.test(value.slice(-6)) ? '#' + value.slice(-6) : '';
const columnName = column => column < 26 ? String.fromCharCode(65 + column) : 'A' + String.fromCharCode(65 + column - 26);
function reference(value) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!match) return null;
  return { column: [...match[1]].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1, row: Number(match[2]) - 1 };
}

async function renderSheets(reader, sections) {
  const { xml, relationships } = reader;
  const styles = await xml('xl/styles.xml', true);
  const fonts = children(first(styles, 'fonts'), 'font'), fills = children(first(styles, 'fills'), 'fill');
  const formats = new Map(descendants(styles, 'numFmt').map(item => [attr(item, 'numFmtId'), attr(item, 'formatCode')]));
  const cellStyles = children(first(styles, 'cellXfs'), 'xf');
  const workbook = await xml('xl/workbook.xml');
  const date1904 = ['1', 'true'].includes(attr(first(workbook, 'workbookPr'), 'date1904'));
  const relations = await relationships('xl/workbook.xml');
  const sheets = descendants(workbook, 'sheet').slice(0, 30).filter(sheet => relations.has(attr(sheet, 'r:id')));
  const result = [];
  for (const [index, section] of sections.entries()) {
    const document = await xml(relations.get(attr(sheets[index], 'r:id')));
    const sourceCells = new Map(descendants(document, 'c').map(cell => [attr(cell, 'r'), cell]));
    const sourceRows = new Map(descendants(document, 'row').map(row => [numeric(attr(row, 'r')), row]));
    const values = new Map(section.rows.map(row => [Number(row.number), row.cells]));
    const merges = [];
    let columnCount = Math.max(1, ...section.rows.map(row => row.cells.length));
    let rowCount = Math.min(300, Math.max(1, ...section.rows.map(row => numeric(row.number))));
    for (const merge of descendants(document, 'mergeCell').slice(0, 10000)) {
      const parts = attr(merge, 'ref').split(':');
      const start = reference(parts[0]), end = reference(parts[1] || parts[0]);
      if (!start || !end || start.column >= 50 || start.row >= 300 || end.column < start.column || end.row < start.row) continue;
      end.column = Math.min(49, end.column); end.row = Math.min(299, end.row);
      merges.push({ start, end });
      columnCount = Math.max(columnCount, end.column + 1); rowCount = Math.max(rowCount, end.row + 1);
    }
    columnCount = Math.min(50, columnCount);
    const widths = Array(columnCount).fill(100), hidden = new Set();
    for (const column of descendants(document, 'col')) {
      const start = Math.max(0, numeric(attr(column, 'min'), 1) - 1), end = Math.min(columnCount, numeric(attr(column, 'max')));
      for (let offset = start; offset < end; offset++) {
        widths[offset] = Math.max(20, Math.min(600, numeric(attr(column, 'width'), 13) * 7 + 5));
        if (attr(column, 'hidden') === '1') hidden.add(offset);
      }
    }
    const pane = first(document, 'pane');
    const frozen = /^frozen/.test(attr(pane, 'state'));
    const frozenRows = frozen ? Math.min(rowCount, numeric(attr(pane, 'ySplit'))) : 0;
    const frozenColumns = frozen ? Math.min(columnCount, numeric(attr(pane, 'xSplit'))) : 0;
    const covered = new Set(), anchors = new Map();
    let mergeBudget = 300 * 50;
    for (const merge of merges) {
      const key = `${merge.start.row}:${merge.start.column}`;
      if (covered.has(key)) continue;
      const area = (merge.end.row - merge.start.row + 1) * (merge.end.column - merge.start.column + 1);
      if (area > mergeBudget) break;
      mergeBudget -= area;
      anchors.set(key, merge);
      for (let row = merge.start.row; row <= merge.end.row; row++) for (let column = merge.start.column; column <= merge.end.column; column++) {
        if (row !== merge.start.row || column !== merge.start.column) covered.add(`${row}:${column}`);
      }
    }
    let html = `<section class="sheet"><h2>${escape(section.title)}</h2><table style="table-layout:fixed"><colgroup><col style="width:48px">`;
    html += widths.map((width, column) => `<col style="width:${width}px;${hidden.has(column) ? 'display:none' : ''}">`).join('') + '</colgroup><thead><tr><th></th>';
    html += widths.map((width, column) => `<th style="min-width:${width}px;${hidden.has(column) ? 'display:none' : ''}">${columnName(column)}</th>`).join('') + '</tr></thead><tbody>';
    let top = 32;
    for (let row = 0; row < rowCount; row++) {
      const rowNode = sourceRows.get(row + 1);
      const height = Math.max(24, Math.min(600, numeric(attr(rowNode, 'ht'), 18) * 4 / 3));
      const hiddenRow = attr(rowNode, 'hidden') === '1';
      html += `<tr style="height:${height}px;${hiddenRow ? 'display:none' : ''}"><th scope="row">${row + 1}</th>`;
      let left = 48;
      for (let column = 0; column < columnCount; column++) {
        const key = `${row}:${column}`;
        if (covered.has(key)) { if (!hidden.has(column)) left += widths[column]; continue; }
        const cell = sourceCells.get(columnName(column) + (row + 1));
        const style = cellStyles[numeric(attr(cell, 's'))], font = fonts[numeric(attr(style, 'fontId'))];
        const fill = color(attr(first(fills[numeric(attr(style, 'fillId'))], 'fgColor'), 'rgb'));
        const ink = color(attr(first(font, 'color'), 'rgb'));
        const alignment = first(style, 'alignment');
        const horizontal = attr(alignment, 'horizontal'), vertical = attr(alignment, 'vertical');
        const css = [first(font, 'b') ? 'font-weight:700' : '', first(font, 'i') ? 'font-style:italic' : '', ink ? 'color:' + ink : '', 'background:' + (fill || '#fff'),
          ['left', 'center', 'right', 'justify'].includes(horizontal) ? 'text-align:' + horizontal : '',
          ['top', 'center', 'bottom'].includes(vertical) ? 'vertical-align:' + (vertical === 'center' ? 'middle' : vertical) : '',
          attr(alignment, 'wrapText') === '1' ? 'white-space:pre-wrap' : 'white-space:pre', hidden.has(column) ? 'display:none' : ''];
        if (row < frozenRows || column < frozenColumns) css.push('position:sticky', 'z-index:2', row < frozenRows ? `top:${top}px` : '', column < frozenColumns ? `left:${left}px` : '');
        let value = values.get(row + 1)?.[column] || '';
        if ((!attr(cell, 't') || attr(cell, 't') === 'n') && value !== '' && Number.isFinite(Number(value))) {
          const id = attr(style, 'numFmtId') || '0';
          try { value = SSF.format(formats.get(id) || Number(id), Number(value), { date1904 }); } catch {}
        }
        const merge = anchors.get(key);
        html += `<td${merge ? ` rowspan="${merge.end.row - row + 1}" colspan="${merge.end.column - column + 1}"` : ''} style="${css.filter(Boolean).join(';')}">${escape(value)}</td>`;
        if (!hidden.has(column)) left += widths[column];
      }
      html += '</tr>'; if (!hiddenRow) top += height;
    }
    html += '</tbody></table></section>';
    result.push({ title: section.title, html });
  }
  return result;
}

module.exports = { renderSheets };
