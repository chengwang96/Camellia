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
  // Legacy OLE binaries cannot be parsed like their ZIP-based successors, but
  // they are still real deliverables and must not be discarded as noise.
  assert.equal(previewKind('report.doc'), 'document');
  assert.equal(previewKind('ledger.XLS'), 'document');
  assert.equal(previewKind('deck.ppt'), 'document');
  assert.equal(previewKind('archive.zip'), 'unsupported');
});

test('Word content is extracted as inert text', async t => {
  const file = archive(t, { 'word/document.xml': '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>报告 &lt;script&gt;</w:t></w:r></w:p></w:body></w:document>' });
  const result = await readOfficePreview(file, 'word');
  assert.deepEqual(result.sections[0].paragraphs, ['报告 <script>']);
  assert.match(result.html, /报告 &lt;script&gt;/);
  assert.doesNotMatch(result.html, /<script>/);
});

test('Word preview renders headings, bold runs, tables and embedded images', async t => {
  const file = archive(t, {
    'word/document.xml': '<w:document xmlns:w="word" xmlns:a="drawing" xmlns:r="rel"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Report</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><a:blip r:embed="picture"/></w:drawing></w:r></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships><Relationship Id="picture" Target="media/image.png"/></Relationships>',
    'word/media/image.png': 'image-fixture',
  });
  const { html } = await readOfficePreview(file, 'word');
  assert.match(html, /<h1[^>]*><span style="font-weight:700">Report/);
  assert.match(html, /<table><tr><td[^>]*><p[^>]*><span[^>]*>Value/);
  assert.match(html, /src="data:image\/png;base64,/);
});

test('slides render positioned shapes with scaled text and embedded pictures', async t => {
  const file = archive(t, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldSz cx="9144000" cy="5143500"/><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="914400" y="514350"/><a:ext cx="4572000" cy="2571750"/></a:xfrm><a:solidFill><a:srgbClr val="123456"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2400" b="1"/><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="picture"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="picture" Target="../media/image.png"/></Relationships>',
    'ppt/media/image.png': 'image-fixture',
  });
  const { html } = await readOfficePreview(file, 'presentation');
  assert.match(html, /class="slide"/);
  assert.match(html, /left:10%;top:10%;width:50%;height:50%/);
  assert.match(html, /background:#123456/);
  assert.match(html, /font-weight:700;font-size:[\d.]+cqw/);
  assert.match(html, /Slide title/);
  assert.match(html, /src="data:image\/png;base64,/);
});

test('spreadsheet preview renders sheet names, cell formatting and cached formula results', async t => {
  const file = archive(t, {
    'xl/workbook.xml': '<workbook xmlns:r="rel"><sheets><sheet name="Results &amp; costs" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="sheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><fonts><font><b/><color rgb="FF123456"/></font></fonts><fills><fill><patternFill><fgColor rgb="FFEEEEEE"/></patternFill></fill></fills><cellXfs><xf fontId="0" fillId="0" numFmtId="10"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" s="0"><f>1/4</f><v>0.25</v></c><c r="B1" t="inlineStr"><is><t>&lt;script&gt;</t></is></c></row></sheetData></worksheet>',
  });
  const { html } = await readOfficePreview(file, 'spreadsheet');
  assert.match(html, /Results &amp; costs/);
  assert.match(html, /<th[^>]*>A<\/th><th[^>]*>B<\/th>/);
  assert.match(html, /font-weight:700;color:#123456;background:#EEEEEE/);
  assert.match(html, />25.00%<\/td>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, />=1\/4</);
});

test('Word component runs only nonce-authorized scripts in an isolated offline document', async t => {
  const file = archive(t, {
    'word/document.xml': '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships><Relationship Id="external" Target="https://example.com/private" TargetMode="External"/></Relationships>',
    'word/alt.html': '<script>parent.compromised=true</script>',
  });
  const result = await readOfficePreview(file, 'word');
  assert.match(result.wordHtml, /script-src 'nonce-/);
  assert.match(result.wordHtml, /connect-src 'none'/);
  assert.match(result.wordHtml, /renderAltChunks:false/);
  assert.match(result.wordHtml, /ignoreLastRenderedPageBreak:false/);
  const data = /atob\('([A-Za-z0-9+/=]+)'\)/.exec(result.wordHtml)[1];
  const zip = await require('jszip').loadAsync(Buffer.from(data, 'base64'));
  assert.equal(zip.file('word/alt.html'), null);
  assert.doesNotMatch(await zip.file('word/_rels/document.xml.rels').async('string'), /External|example.com/);
});

test('Excel renders merges, row and column sizing, frozen panes and date systems', async t => {
  const file = archive(t, {
    'xl/workbook.xml': '<workbook xmlns:r="rel"><workbookPr date1904="1"/><sheets><sheet name="Layout" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="sheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetViews><sheetView><pane state="frozen" xSplit="1" ySplit="1"/></sheetView></sheetViews><cols><col min="1" max="1" width="30"/></cols><sheetData><row r="1" ht="30"><c r="A1" t="inlineStr"><is><t>Merged title</t></is></c></row><row r="2"><c r="C2" s="1"><v>0</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B2"/></mergeCells></worksheet>',
  });
  const result = await readOfficePreview(file, 'spreadsheet');
  assert.equal(result.sheets.length, 1);
  assert.equal(result.sheets[0].title, 'Layout');
  assert.match(result.html, /rowspan="2" colspan="2"/);
  assert.match(result.html, /width:215px/);
  assert.match(result.html, /height:40px/);
  assert.match(result.html, /position:sticky;z-index:2;top:32px;left:48px/);
  assert.match(result.html, /1904-01-01/);
});

test('Excel preview warns when sparse data lies beyond row limits', async t => {
  const file = archive(t, {
    'xl/workbook.xml': '<workbook xmlns:r="rel"><sheets><sheet name="Sparse" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="sheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="500000"><c r="A500000" t="inlineStr"><is><t>Outside preview</t></is></c></row></sheetData></worksheet>',
  });
  const result = await readOfficePreview(file, 'spreadsheet');
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.html, /Outside preview/);
  assert.ok(result.html.length < 10000);
});

test('Office rendering ignores external images and rejects entity declarations in relationships', async t => {
  const parts = {
    'word/document.xml': '<w:document xmlns:w="word" xmlns:a="drawing" xmlns:r="rel"><w:body><w:p><w:r><w:drawing><a:blip r:embed="external"/></w:drawing></w:r></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships><Relationship Id="external" Target="https://example.com/private.png" TargetMode="External"/></Relationships>',
  };
  assert.doesNotMatch((await readOfficePreview(archive(t, parts), 'word')).html, /example\.com|<img/);
  parts['word/_rels/document.xml.rels'] = '<!DOCTYPE data [<!ENTITY value SYSTEM "file:///secret">]><Relationships/>';
  await assert.rejects(readOfficePreview(archive(t, parts), 'word'), /Unsupported Office XML/);
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
