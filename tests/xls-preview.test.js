'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { previewKind } = require('../src/main/file-preview');
const { isOleWorkbook, readXlsPreview, extractXlsText } = require('../src/main/xls-preview');

// A real BIFF8 workbook cannot be hand-assembled as text, so the fixture is a
// small OLE2 `.xls` produced by xlwt with two sheets, a bold/filled header, a
// percentage number format, a merged range, a boolean and a numeric formula.
// It exercises the container walk and every record the reader decodes.
const FIXTURE = path.join(__dirname, 'fixtures', 'biff-sample.xls');

function fixturePath(t, name, bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-xls-'));
  t.after(() => removeTree(directory));
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test('legacy .xls is classified as a spreadsheet, not a preview-free document', () => {
  assert.equal(previewKind('ledger.XLS'), 'spreadsheet');
  assert.equal(previewKind('report.doc'), 'document');
  assert.equal(previewKind('deck.ppt'), 'document');
  assert.equal(previewKind('book.xlsm'), 'unsupported');
});

test('a non-OLE file of the same extension is rejected instead of mis-parsed', t => {
  const file = fixturePath(t, 'fake.xls', Buffer.from('this is not a workbook'));
  assert.equal(isOleWorkbook(file), false);
  assert.throws(() => readXlsPreview(file), /not a BIFF workbook/);
});

test('BIFF8 workbooks render cells, formats, merges and booleans', t => {
  const file = fixturePath(t, 'sample.xls', fs.readFileSync(FIXTURE));
  assert.equal(isOleWorkbook(file), true);
  const preview = readXlsPreview(file);
  assert.equal(preview.sections.length, 2);
  assert.equal(preview.sheets.length, 2);
  assert.ok(preview.html.includes('class="sheet"'));
  assert.ok(preview.html.includes('25.00%'));
  assert.ok(preview.html.includes('Merged cells'));
  assert.ok(preview.html.includes('colspan="2"') && preview.html.includes('rowspan="2"'));
  assert.ok(preview.html.includes('TRUE'));
  // The bold header keeps its Gray-25 fill, which proves the XF font index
  // (with Excel's placeholder font at index 4) and the BIFF8 colour table
  // both resolve to the right entry.
  assert.match(preview.html, /<td style="font-weight:700;background:#c0c0c0[^"]*">Completion<\/td>/);
  assert.ok(extractXlsText(file).includes('Merged cells'));
});
