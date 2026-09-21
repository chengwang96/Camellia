'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { readOfficePreview } = require('../src/main/office-preview');
const { previewKind } = require('../src/main/file-preview');

function archive(t, parts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-office-'));
  t.after(() => removeTree(directory));
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  const file = path.join(directory, 'office.zip');
  fs.writeFileSync(file, Buffer.concat([...local, directoryBytes, end]));
  return file;
}

test('Office formats are previewable without treating legacy binaries as text', () => {
  assert.equal(previewKind('report.DOCX'), 'word');
  assert.equal(previewKind('slides.pptx'), 'presentation');
  assert.equal(previewKind('data.xlsx'), 'spreadsheet');
  assert.equal(previewKind('report.doc'), 'unsupported');
});

test('Word content is extracted as inert text', async t => {
  const file = archive(t, { 'word/document.xml': '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>报告 &lt;script&gt;</w:t></w:r></w:p></w:body></w:document>' });
  const result = await readOfficePreview(file, 'word');
  assert.deepEqual(result.sections[0].paragraphs, ['报告 <script>']);
});

test('slides follow presentation relationships, not ZIP order', async t => {
  const file = archive(t, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="/ppt/slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<slide><p><t>First</t></p></slide>',
    'ppt/slides/slide2.xml': '<slide><p><t>Second</t></p></slide>',
  });
  assert.deepEqual((await readOfficePreview(file, 'presentation')).sections.map(section => section.paragraphs), [['Second'], ['First']]);
});

test('spreadsheets preserve sparse columns, shared strings, booleans and cached formulas', async t => {
  const file = archive(t, {
    'xl/workbook.xml': '<workbook xmlns:r="rel"><sheets><sheet name="Results" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="sheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Value</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="3"><c r="A3" t="s"><v>0</v></c><c r="C3"><f>1+1</f><v>2</v></c><c r="D3" t="b"><v>1</v></c></row></sheetData></worksheet>',
  });
  const section = (await readOfficePreview(file, 'spreadsheet')).sections[0];
  assert.equal(section.title, 'Results');
  assert.deepEqual(section.rows, [{ number: '3', cells: ['Value', '', '2', 'TRUE'] }]);
});

test('Office previews reject entity declarations and missing document parts', async t => {
  const file = archive(t, { 'word/document.xml': '<!DOCTYPE data [<!ENTITY value SYSTEM "file:///secret">]><document/>' });
  await assert.rejects(readOfficePreview(file, 'word'), /Unsupported Office XML/);
  await assert.rejects(readOfficePreview(archive(t, { 'other.xml': '<x/>' }), 'word'), /missing/);
});
