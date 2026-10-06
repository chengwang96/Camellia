'use strict';

// Legacy `.xls` workbooks are OLE2/CFBF compound files that carry a BIFF
// record stream, not ZIP+XML archives, so the OOXML previewer cannot read them.
// This module decodes the bounded part of BIFF that a preview and the /find
// text index need: shared strings, numbers, RK/MULRK, labels, booleans, cached
// formula results, number formats, basic cell styles, merged cells, column
// widths, row heights and frozen panes. It only runs in the main process.

const SSF = require('ssf');
const { isCompoundFile, readCompoundFile } = require('./ole-container');

const MAX_RECORDS = 1 << 20;
const MAX_SST_STRINGS = 200000;
const MAX_SHEETS = 30, MAX_ROWS = 300, MAX_COLUMNS = 50;
const MAX_TEXT_CHARS = 256 * 1024;

// BIFF record ids used by the reader. Everything else is skipped as noise.
const BOF = 0x0809, EOF = 0x000a, CONTINUE = 0x003c;
const CODEPAGE = 0x0042, DATEMODE = 0x0022, FONT = 0x0031, FORMAT = 0x041e, XF = 0x00e0;
const PALETTE = 0x0092, BOUNDSHEET = 0x0085, SST = 0x00fc;
const DIMENSION = 0x0200, ROW = 0x0208, COLINFO = 0x007d, PANE = 0x0041, MERGEDCELLS = 0x00e5;
const BLANK = 0x0201, MULBLANK = 0x00be, RK = 0x027e, MULRK = 0x00bd, NUMBER = 0x0203;
const LABELSST = 0x00fd, LABEL = 0x0204, BOOLERR = 0x0205, FORMULA = 0x0006, STRING = 0x0207;

const ERROR_TEXT = { 0: '#NULL!', 7: '#DIV/0!', 15: '#VALUE!', 23: '#REF!', 29: '#NAME?', 36: '#NUM!', 42: '#N/A', 43: '#GETTING_DATA' };
// The 8 invariant colours are palette indices 0..7. Excel's default 56-colour
// table (indices 8..63) repeats those eight and then continues with the darker
// variants, so Gray-25 = index 22 = DEFAULT_PALETTE[14]. A PALETTE record may
// override the whole 56-entry table.
const INVARIANT_PALETTE = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
const DEFAULT_PALETTE = [
  [0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0],
  [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255],
  [128, 0, 0], [0, 128, 0], [0, 0, 128], [128, 128, 0],
  [128, 0, 128], [0, 128, 128], [192, 192, 192], [128, 128, 128],
  [153, 153, 255], [153, 51, 102], [255, 255, 204], [204, 255, 255],
  [102, 0, 102], [255, 128, 128], [0, 102, 204], [204, 204, 255],
  [0, 0, 128], [255, 0, 255], [255, 255, 0], [0, 255, 255],
  [128, 0, 128], [128, 0, 0], [0, 128, 128], [0, 0, 255],
  [0, 204, 255], [204, 255, 255], [204, 255, 204], [255, 255, 153],
  [153, 204, 255], [255, 153, 204], [204, 153, 255], [255, 204, 153],
  [51, 102, 255], [51, 204, 204], [153, 204, 0], [255, 204, 0],
  [255, 153, 0], [255, 102, 0], [102, 102, 153], [150, 150, 150],
  [0, 51, 102], [51, 153, 102], [0, 51, 0], [51, 51, 0],
  [153, 51, 0], [153, 51, 102], [51, 51, 153], [51, 51, 51],
];

const CODE_PAGES = { 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 65001: 'utf-8' };

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const columnName = column => column < 26 ? String.fromCharCode(65 + column) : 'A' + String.fromCharCode(65 + column - 26);

function isOleWorkbook(filePath) {
  return isCompoundFile(filePath);
}

function readCompoundStream(filePath) {
  return readCompoundFile(filePath).readStream('Workbook');
}

function collectRecords(stream) {
  const records = [];
  let position = 0;
  while (position + 4 <= stream.length && records.length < MAX_RECORDS) {
    const id = stream.readUInt16LE(position);
    const length = stream.readUInt16LE(position + 2);
    const start = position + 4;
    records.push({ id, start: position, data: stream.subarray(start, Math.min(stream.length, start + length)) });
    position = start + length;
  }
  return records;
}

const decodeBytes = (bytes, codepage) => {
  if (!bytes.length) return '';
  if (codepage && codepage !== 1200 && bytes.some(byte => byte >= 0x80)) {
    const label = CODE_PAGES[codepage];
    if (label) { try { return new TextDecoder(label).decode(bytes); } catch {} }
  }
  return bytes.toString('latin1');
};

// BIFF5/7 read a length-prefixed byte string; BIFF8 reads a length-prefixed,
// optionally UTF-16 string whose per-chunk flag byte survives CONTINUE records.
function readString(data, position, lenlen, codepage, biff8) {
  const length = lenlen === 1 ? data.readUInt8(position) : data.readUInt16LE(position);
  position += lenlen;
  if (!biff8) return { text: decodeBytes(data.subarray(position, position + length), codepage), position: position + length };
  if (!length) return { text: '', position: position + 1 <= data.length ? position + 1 : position };
  const options = data.readUInt8(position); position += 1;
  if (options & 0x08) position += 2;
  if (options & 0x04) position += 4;
  if (options & 0x01) return { text: data.toString('utf16le', position, position + length * 2), position: position + length * 2 };
  return { text: decodeBytes(data.subarray(position, position + length), codepage), position: position + length };
}

function parseSharedStrings(chunks, codepage) {
  const strings = [];
  if (!chunks.length) return strings;
  const unique = Math.min(chunks[0].readUInt32LE(4), MAX_SST_STRINGS);
  let chunk = 0, data = chunks[0], length = data.length, position = 8;
  for (let index = 0; index < unique; index++) {
    if (position + 3 > length) {
      chunk += 1;
      if (chunk >= chunks.length) break;
      data = chunks[chunk]; length = data.length; position = 0;
    }
    const characters = data.readUInt16LE(position); position += 2;
    let options = data.readUInt8(position); position += 1;
    let runs = 0, phonetic = 0;
    if (options & 0x08) { runs = data.readUInt16LE(position); position += 2; }
    if (options & 0x04) { phonetic = data.readInt32LE(position); position += 4; }
    let text = '', collected = 0;
    while (true) {
      const needed = characters - collected;
      if (options & 0x01) {
        const available = Math.min((length - position) >> 1, needed);
        text += data.toString('utf16le', position, position + available * 2);
        position += available * 2; collected += available;
      } else {
        const available = Math.min(length - position, needed);
        text += decodeBytes(data.subarray(position, position + available), codepage);
        position += available; collected += available;
      }
      if (collected >= characters) break;
      chunk += 1;
      if (chunk >= chunks.length) break;
      data = chunks[chunk]; length = data.length; position = 0;
      options = data.readUInt8(position); position = 1;
    }
    let skip = runs * 4 + phonetic;
    while (skip > 0) {
      const available = Math.min(length - position, skip);
      position += available; skip -= available;
      if (skip > 0) {
        chunk += 1;
        if (chunk >= chunks.length) break;
        data = chunks[chunk]; length = data.length; position = 0;
      }
    }
    strings.push(text);
  }
  return strings;
}

function readChunkedString(chunks, characters) {
  let chunk = 0, data = chunks[0], length = data.length, position = 0;
  let options = data.readUInt8(position); position += 1;
  let text = '', collected = 0;
  while (true) {
    const needed = characters - collected;
    if (options & 0x01) {
      const available = Math.min((length - position) >> 1, needed);
      text += data.toString('utf16le', position, position + available * 2);
      position += available * 2; collected += available;
    } else {
      const available = Math.min(length - position, needed);
      text += decodeBytes(data.subarray(position, position + available), 0);
      position += available; collected += available;
    }
    if (collected >= characters) break;
    chunk += 1;
    if (chunk >= chunks.length) break;
    data = chunks[chunk]; length = data.length; position = 0;
    options = data.readUInt8(position); position = 1;
  }
  return text;
}

function unpackRk(view) {
  const flags = view.readUInt8(0);
  if (flags & 2) {
    let value = view.readInt32LE(0) >> 2;
    return flags & 1 ? value / 100 : value;
  }
  const significant = view.readUInt8(0) & 0xfc;
  const buffer = Buffer.from([0, 0, 0, 0, significant, view.readUInt8(1), view.readUInt8(2), view.readUInt8(3)]);
  const value = buffer.readDoubleLE(0);
  return flags & 1 ? value / 100 : value;
}

function parseGlobals(records) {
  const state = { biff8: true, version: 0x0600, codepage: 1200, datemode: 0, fonts: [], formats: new Map(), xfs: [], palette: null, sheets: [], shared: [] };
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (record.id === EOF) break;
    if (record.id === BOF) {
      state.version = record.data.length >= 2 ? record.data.readUInt16LE(0) : 0x0600;
      state.biff8 = state.version >= 0x0600;
    } else if (record.id === CODEPAGE && record.data.length >= 2) {
      state.codepage = record.data.readUInt16LE(0);
    } else if (record.id === DATEMODE && record.data.length >= 2) {
      state.datemode = record.data.readUInt16LE(0);
    } else if (record.id === FONT && record.data.length >= 14) {
      const flags = record.data.readUInt16LE(2);
      // Excel reserves font index 4 for an internal placeholder, so the XF
      // font_index values assume it exists. Insert the same dummy entry before
      // the fifth record to keep the two tables aligned.
      if (state.fonts.length === 4) state.fonts.push({ bold: false, italic: false, underlined: false, colorIndex: 0x7fff, name: 'Dummy Font' });
      state.fonts.push({
        bold: Boolean(flags & 1), italic: Boolean(flags & 2), underlined: Boolean(flags & 4),
        colorIndex: record.data.readUInt16LE(4),
        name: readString(record.data, 14, 1, state.codepage, state.biff8).text,
      });
    } else if (record.id === FORMAT && record.data.length >= 3) {
      const key = record.data.readUInt16LE(0);
      state.formats.set(key, readString(record.data, 2, state.biff8 ? 2 : 1, state.codepage, state.biff8).text);
    } else if (record.id === XF && record.data.length >= (state.biff8 ? 20 : 16)) {
      if (state.biff8) {
        const align1 = record.data.readUInt8(6);
        const packed2 = record.data.readUInt32LE(14), packed3 = record.data.readUInt16LE(18);
        state.xfs.push({
          fontIndex: record.data.readUInt16LE(0), formatKey: record.data.readUInt16LE(2),
          horizontal: align1 & 7, wrapped: Boolean(align1 & 8), vertical: (align1 >> 4) & 7,
          fillPattern: (packed2 >>> 26) & 0x3f, patternColor: packed3 & 0x7f, fillColor: (packed3 >> 7) & 0x3f,
        });
      } else {
        const align1 = record.data.readUInt8(5), packed = record.data.readUInt32LE(6);
        state.xfs.push({
          fontIndex: record.data.readUInt16LE(0), formatKey: record.data.readUInt16LE(2),
          horizontal: align1 & 7, wrapped: Boolean(align1 & 8), vertical: (align1 >> 4) & 7,
          fillPattern: (packed >>> 16) & 0x3f, patternColor: packed & 0x7f, fillColor: (packed >> 7) & 0x3f,
        });
      }
    } else if (record.id === PALETTE && record.data.length >= 2) {
      const count = record.data.readUInt16LE(0);
      const colours = [];
      for (let position = 0; position < count && 4 + position * 4 + 4 <= record.data.length; position++) {
        const base = 2 + position * 4;
        colours.push([record.data.readUInt8(base + 2), record.data.readUInt8(base + 1), record.data.readUInt8(base)]);
      }
      state.palette = colours;
    } else if (record.id === BOUNDSHEET && record.data.length >= 7) {
      const offset = record.data.readInt32LE(0);
      const type = record.data.readUInt8(5);
      const name = readString(record.data, 6, 1, state.codepage, state.biff8).text;
      if (type === 0) state.sheets.push({ name, offset });
    } else if (record.id === SST) {
      const chunks = [record.data];
      while (index + 1 < records.length && records[index + 1].id === CONTINUE) chunks.push(records[++index].data);
      state.shared = parseSharedStrings(chunks, state.codepage);
    }
    index += 1;
  }
  return state;
}

function colorOf(index, state) {
  if (index === undefined || index === 0x7fff) return '';
  if (index < 8) return '#' + INVARIANT_PALETTE[index].map(value => value.toString(16).padStart(2, '0')).join('');
  const palette = state.palette || DEFAULT_PALETTE;
  const entry = index >= 8 ? palette[index - 8] : undefined;
  return entry ? '#' + entry.map(value => value.toString(16).padStart(2, '0')).join('') : '';
}

function formatNumber(value, xf, state) {
  const key = xf ? xf.formatKey : 0;
  try {
    return SSF.format(state.formats.get(key) ?? Number(key), Number(value), { date1904: state.datemode === 1 });
  } catch { return String(value); }
}

function createSheetState(sheet) {
  return {
    name: sheet.name, cells: new Map(), rowHeights: new Map(), hiddenRows: new Set(),
    columnWidths: [], hiddenColumns: new Set(), merges: [], frozenRows: 0, frozenColumns: 0,
    rowCount: 0, columnCount: 0, truncated: false,
  };
}

function placeCell(model, row, column, value) {
  if (row >= MAX_ROWS || column >= MAX_COLUMNS) { model.truncated = true; return; }
  model.cells.set(row + ':' + column, value);
  model.rowCount = Math.max(model.rowCount, row + 1);
  model.columnCount = Math.max(model.columnCount, column + 1);
}

function parseSheet(records, startIndex, sheet, state) {
  const model = createSheetState(sheet);
  let index = startIndex;
  for (; index < records.length; index++) {
    const record = records[index];
    if (record.id === EOF) break;
    const data = record.data;
    if (record.id === ROW && data.length >= 16) {
      const row = data.readUInt16LE(0), bits1 = data.readUInt16LE(6), bits2 = data.readInt32LE(12);
      const height = bits1 & 0x7fff;
      if (height) model.rowHeights.set(row, height);
      if ((bits2 >>> 5) & 1) model.hiddenRows.add(row);
    } else if (record.id === COLINFO && data.length >= 10) {
      const first = data.readUInt16LE(0), last = Math.min(data.readUInt16LE(2), 255);
      const width = data.readUInt16LE(4), flags = data.readUInt16LE(8);
      for (let column = first; column <= last; column++) {
        model.columnWidths[column] = Math.max(20, Math.min(600, Math.round(width / 256 * 7 + 5)));
        if (flags & 1) model.hiddenColumns.add(column);
        if (column >= MAX_COLUMNS) model.truncated = true;
      }
    } else if (record.id === PANE && data.length >= 4) {
      model.frozenColumns = Math.min(MAX_COLUMNS, data.readUInt16LE(0));
      model.frozenRows = Math.min(MAX_ROWS, data.readUInt16LE(2));
    } else if (record.id === MERGEDCELLS && data.length >= 2) {
      const count = Math.min(data.readUInt16LE(0), 10000);
      for (let merge = 0; merge < count; merge++) {
        const base = 2 + merge * 8;
        if (base + 8 > data.length) break;
        const r1 = data.readUInt16LE(base), r2 = data.readUInt16LE(base + 2), c1 = data.readUInt16LE(base + 4), c2 = data.readUInt16LE(base + 6);
        if (c1 >= MAX_COLUMNS || r1 >= MAX_ROWS || c2 < c1 || r2 < r1) { model.truncated ||= c1 >= MAX_COLUMNS || r1 >= MAX_ROWS; continue; }
        model.merges.push({ r1, c1, r2: Math.min(r2, MAX_ROWS - 1), c2: Math.min(c2, MAX_COLUMNS - 1) });
        model.rowCount = Math.max(model.rowCount, Math.min(r2 + 1, MAX_ROWS));
        model.columnCount = Math.max(model.columnCount, Math.min(c2 + 1, MAX_COLUMNS));
      }
    } else if (record.id === NUMBER && data.length >= 14) {
      placeCell(model, data.readUInt16LE(0), data.readUInt16LE(2), { type: 'number', value: data.readDoubleLE(6), xf: data.readUInt16LE(4) });
    } else if (record.id === RK && data.length >= 10) {
      placeCell(model, data.readUInt16LE(0), data.readUInt16LE(2), { type: 'number', value: unpackRk(data.subarray(6, 10)), xf: data.readUInt16LE(4) });
    } else if (record.id === MULRK && data.length >= 12) {
      const row = data.readUInt16LE(0), first = data.readUInt16LE(2), last = data.readUInt16LE(data.length - 2);
      for (let column = first, position = 4; column <= last && position + 6 <= data.length - 2; column++, position += 6) {
        placeCell(model, row, column, { type: 'number', value: unpackRk(data.subarray(position + 2, position + 6)), xf: data.readUInt16LE(position) });
      }
    } else if (record.id === LABELSST && data.length >= 10) {
      const sst = data.readInt32LE(6);
      placeCell(model, data.readUInt16LE(0), data.readUInt16LE(2), { type: 'text', value: state.shared[sst] ?? '', xf: data.readUInt16LE(4) });
    } else if (record.id === LABEL && data.length >= 7) {
      const parsed = readString(data, 6, 2, state.codepage, state.biff8);
      placeCell(model, data.readUInt16LE(0), data.readUInt16LE(2), { type: 'text', value: parsed.text, xf: data.readUInt16LE(4) });
    } else if (record.id === BOOLERR && data.length >= 8) {
      const value = data.readUInt8(6), isError = data.readUInt8(7);
      placeCell(model, data.readUInt16LE(0), data.readUInt16LE(2), isError
        ? { type: 'text', value: ERROR_TEXT[value] || '#ERR!', xf: data.readUInt16LE(4) }
        : { type: 'text', value: value ? 'TRUE' : 'FALSE', xf: data.readUInt16LE(4) });
    } else if (record.id === FORMULA && data.length >= 16) {
      const row = data.readUInt16LE(0), column = data.readUInt16LE(2), xf = data.readUInt16LE(4);
      const result = data.subarray(6, 14);
      if (result.readUInt16LE(6) === 0xffff) {
        const kind = result.readUInt8(0);
        if (kind === 0) {
          const chunks = [];
          if (index + 1 < records.length && records[index + 1].id === STRING) {
            chunks.push(records[++index].data);
            while (index + 1 < records.length && records[index + 1].id === CONTINUE) chunks.push(records[++index].data);
          }
          const characters = chunks.length ? chunks[0].readUInt16LE(0) : 0;
          placeCell(model, row, column, { type: 'text', value: chunks.length ? readChunkedString(chunks, characters) : '', xf });
        } else if (kind === 1) {
          placeCell(model, row, column, { type: 'text', value: result.readUInt8(2) ? 'TRUE' : 'FALSE', xf });
        } else if (kind === 2) {
          placeCell(model, row, column, { type: 'text', value: ERROR_TEXT[result.readUInt8(2)] || '#ERR!', xf });
        } else {
          placeCell(model, row, column, { type: 'text', value: '', xf });
        }
      } else {
        placeCell(model, row, column, { type: 'number', value: result.readDoubleLE(0), xf });
      }
    } else if (record.id === BLANK && data.length >= 6) {
      placeCell(model, data.readUInt16LE(0), data.readUInt16LE(2), { type: 'empty', value: '', xf: data.readUInt16LE(4) });
    } else if (record.id === MULBLANK && data.length >= 8) {
      const row = data.readUInt16LE(0), first = data.readUInt16LE(2), last = data.readUInt16LE(data.length - 2);
      for (let column = first, position = 4; column <= last; column++, position += 2) {
        placeCell(model, row, column, { type: 'empty', value: '', xf: data.readUInt16LE(position) });
      }
    } else if (record.id === DIMENSION && data.length >= 12) {
      const lastRow = data.readUInt32LE(4), lastColumn = data.readUInt16LE(10);
      if (lastRow + 1 > MAX_ROWS || lastColumn + 1 > MAX_COLUMNS) model.truncated = true;
    }
  }
  return { model, nextIndex: index + 1 };
}

function renderSheetHtml(model, state) {
  const columnCount = Math.min(MAX_COLUMNS, Math.max(1, model.columnCount));
  const rowCount = Math.min(MAX_ROWS, Math.max(1, model.rowCount));
  const widths = Array.from({ length: columnCount }, (_, column) => model.columnWidths[column] ?? 100);
  const covered = new Set(), anchors = new Map();
  let budget = MAX_ROWS * MAX_COLUMNS;
  for (const merge of model.merges) {
    const key = merge.r1 + ':' + merge.c1;
    if (covered.has(key)) continue;
    const area = (merge.r2 - merge.r1 + 1) * (merge.c2 - merge.c1 + 1);
    if (area > budget) break;
    budget -= area;
    anchors.set(key, merge);
    for (let row = merge.r1; row <= merge.r2; row++) for (let column = merge.c1; column <= merge.c2; column++) {
      if (row !== merge.r1 || column !== merge.c1) covered.add(row + ':' + column);
    }
  }
  let html = `<section class="sheet"><h2>${escape(model.name)}</h2><table style="table-layout:fixed"><colgroup><col style="width:48px">`;
  html += widths.map((width, column) => `<col style="width:${width}px;${model.hiddenColumns.has(column) ? 'display:none' : ''}">`).join('') + '</colgroup><thead><tr><th></th>';
  html += widths.map((width, column) => `<th style="min-width:${width}px;${model.hiddenColumns.has(column) ? 'display:none' : ''}">${columnName(column)}</th>`).join('') + '</tr></thead><tbody>';
  let top = 32;
  for (let row = 0; row < rowCount; row++) {
    const height = Math.max(24, Math.min(600, (model.rowHeights.get(row) ?? 270) / 20 * 4 / 3));
    const hiddenRow = model.hiddenRows.has(row);
    html += `<tr style="height:${height}px;${hiddenRow ? 'display:none' : ''}"><th scope="row">${row + 1}</th>`;
    let left = 48;
    for (let column = 0; column < columnCount; column++) {
      const key = row + ':' + column;
      if (covered.has(key)) { if (!model.hiddenColumns.has(column)) left += widths[column]; continue; }
      const cell = model.cells.get(key);
      const xf = state.xfs[cell?.xf];
      const font = state.fonts[xf?.fontIndex];
      const fill = xf && xf.fillPattern ? colorOf(xf.patternColor, state) : '';
      const ink = colorOf(font?.colorIndex, state);
      const css = [font?.bold ? 'font-weight:700' : '', font?.italic ? 'font-style:italic' : '', font?.underlined ? 'text-decoration:underline' : '',
        ink ? 'color:' + ink : '', 'background:' + (fill || '#fff'),
        [1, 2, 3, 5, 6, 7].includes(xf?.horizontal) ? 'text-align:' + ({ 1: 'left', 2: 'center', 3: 'right', 5: 'justify', 6: 'center', 7: 'justify' })[xf.horizontal] : '',
        [1, 2].includes(xf?.vertical) ? 'vertical-align:' + ({ 1: 'middle', 2: 'bottom' })[xf.vertical] : '',
        xf?.wrapped ? 'white-space:pre-wrap' : '', model.hiddenColumns.has(column) ? 'display:none' : ''];
      if (row < model.frozenRows || column < model.frozenColumns) css.push('position:sticky', 'z-index:2', row < model.frozenRows ? `top:${top}px` : '', column < model.frozenColumns ? `left:${left}px` : '');
      let value = cell ? cell.value : '';
      if (cell && cell.type === 'number') value = formatNumber(cell.value, xf, state);
      const merge = anchors.get(key);
      html += `<td${merge ? ` rowspan="${merge.r2 - row + 1}" colspan="${merge.c2 - column + 1}"` : ''} style="${css.filter(Boolean).join(';')}">${escape(value)}</td>`;
      if (!model.hiddenColumns.has(column)) left += widths[column];
    }
    html += '</tr>';
    if (!hiddenRow) top += height;
  }
  html += '</tbody></table></section>';
  return html;
}

function buildPreview(filePath) {
  if (!isOleWorkbook(filePath)) throw new Error('This file is not a BIFF workbook.');
  const stream = readCompoundStream(filePath);
  const records = collectRecords(stream);
  const state = parseGlobals(records);
  if (!state.biff8 && state.version < 0x0500) throw new Error('This workbook uses an unsupported BIFF version.');
  const sections = [], sheets = [];
  const selected = state.sheets.slice(0, MAX_SHEETS);
  let truncated = state.sheets.length > MAX_SHEETS;
  for (const sheet of selected) {
    const index = records.findIndex(record => record.start === sheet.offset);
    if (index < 0) continue;
    const { model } = parseSheet(records, index, sheet, state);
    truncated ||= model.truncated;
    const rows = [];
    for (let row = 0; row < Math.min(MAX_ROWS, Math.max(1, model.rowCount)); row++) {
      const cells = [];
      for (let column = 0; column < Math.min(MAX_COLUMNS, Math.max(1, model.columnCount)); column++) {
        const cell = model.cells.get(row + ':' + column);
        cells.push(!cell ? '' : cell.type === 'number' ? formatNumber(cell.value, state.xfs[cell.xf], state) : cell.value);
      }
      rows.push({ number: String(row + 1), cells });
    }
    sections.push({ title: sheet.name, rows });
    sheets.push({ title: sheet.name, html: renderSheetHtml(model, state) });
  }
  return { sections, truncated, sheets, html: sheets.map(sheet => sheet.html).join('') };
}

function readXlsPreview(filePath) {
  const preview = buildPreview(filePath);
  const { renderDocumentHtml } = require('./office-render');
  return { ...preview, html: renderDocumentHtml(preview.html) };
}

function extractXlsText(filePath) {
  try {
    const preview = buildPreview(filePath);
    const parts = [];
    for (const section of preview.sections) parts.push(section.title, ...section.rows.map(row => row.cells.filter(Boolean).join(' ')));
    return parts.join('\n').slice(0, MAX_TEXT_CHARS);
  } catch { return ''; }
}

module.exports = { isOleWorkbook, readXlsPreview, extractXlsText };
