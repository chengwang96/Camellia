'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const JSZip = require('jszip');
const { readOfficePreview } = require('../src/main/office-preview');
const { previewKind } = require('../src/main/file-preview');
const { readDocxEdit, saveDocxEdit } = require('../src/main/docx-edit');

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
  // BIFF .xls is OLE2 rather than ZIP, but the dedicated reader decodes it, so
  // it previews as a spreadsheet. Legacy Word/PowerPoint OLE binaries cannot
  // be parsed like their ZIP-based successors, but they are still real
  // deliverables and must not be discarded as noise.
  assert.equal(previewKind('ledger.XLS'), 'spreadsheet');
  assert.equal(previewKind('report.doc'), 'document');
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

test('Word preview renders VML pictures from a legacy .doc conversion', async t => {
  const file = archive(t, {
    'word/document.xml': '<w:document xmlns:w="word" xmlns:r="rel" xmlns:v="vml"><w:body><w:p><w:r>'
      + '<w:pict><v:shape style="width:150pt;height:75pt"><v:imagedata r:id="picture"/></v:shape></w:pict>'
      + '</w:r></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships><Relationship Id="picture" Target="media/image.png"/></Relationships>',
    'word/media/image.png': 'image-fixture',
  });
  const { html } = await readOfficePreview(file, 'word');
  assert.match(html, /src="data:image\/png;base64,/);
  // Word writes the shape size in points; the preview converts it to pixels.
  assert.match(html, /width:200px;height:100px/);
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

test('slide table cells keep noFill transparent when borders have solid fills', async t => {
  const file = archive(t, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldSz cx="1000" cy="1000"/><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:cSld><p:spTree><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="1" name="Table"/><p:nvPr/></p:nvGraphicFramePr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="1000"/></a:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="1000"/></a:tblGrid><a:tr h="1000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Transparent</a:t></a:r></a:p></a:txBody><a:tcPr><a:lnL><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnL><a:noFill/></a:tcPr></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
  });
  const { html } = await readOfficePreview(file, 'presentation');
  assert.match(html, /Transparent/);
  assert.match(html, /border-left:1px solid #000000/);
  assert.match(html, /\.shape p,\.slide td p\{line-height:1\.25;margin:0\}/);
  assert.doesNotMatch(html, /<td style="background:#000000;/);
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

test('Word component status copy follows the selected language without mixing languages', async t => {
  const file = archive(t, {
    'word/document.xml': '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p></w:body></w:document>',
  });
  const english = await readOfficePreview(file, 'word', 'en');
  const chinese = await readOfficePreview(file, 'word', 'zh-CN');
  assert.match(english.wordHtml, /<html lang="en">/);
  assert.match(english.wordHtml, />Rendering document…</);
  assert.match(english.wordHtml, /Rendering is taking longer than expected\. You can close the preview\./);
  assert.match(english.wordHtml, /Cannot render this document\. Open with the system app\./);
  assert.doesNotMatch(english.wordHtml, /正在渲染文档|渲染耗时较长|无法渲染此文档/);
  assert.match(chinese.wordHtml, /<html lang="zh-CN">/);
  assert.match(chinese.wordHtml, />正在渲染文档…</);
  assert.match(chinese.wordHtml, /渲染耗时较长，可关闭预览。/);
  assert.match(chinese.wordHtml, /无法渲染此文档，请使用系统软件打开。/);
  assert.doesNotMatch(chinese.wordHtml, /Rendering document…|Rendering is taking longer than expected|Cannot render this document/);
});

test('Excel renders merges, row and column sizing, frozen panes and date systems', async t => {
  const file = archive(t, {
    'xl/workbook.xml': '<workbook xmlns:r="rel"><workbookPr date1904="1"/><sheets><sheet name="Layout" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="sheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetViews><sheetView><pane state="frozen" xSplit="1" ySplit="1"/></sheetView></sheetViews><cols><col min="1" max="1" width="30"/></cols><sheetData><row r="1" ht="30"><c r="A1" t="inlineStr"><is><t>Merged title</t></is></c><c r="C1" t="inlineStr"><is><t>Header</t></is></c></row><row r="2"><c r="C2" s="1"><v>0</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Row label</t></is></c></row></sheetData><mergeCells><mergeCell ref="A1:B2"/></mergeCells></worksheet>',
  });
  const result = await readOfficePreview(file, 'spreadsheet');
  assert.equal(result.sheets.length, 1);
  assert.equal(result.sheets[0].title, 'Layout');
  assert.match(result.html, /rowspan="2" colspan="2"/);
  assert.match(result.html, /width:215px/);
  assert.match(result.html, /height:40px/);
  assert.match(result.html, /position:sticky;z-index:4;top:32px;left:48px[^>]*>Merged title/);
  assert.match(result.html, /position:sticky;z-index:3;top:32px[^>]*>Header/);
  assert.match(result.html, /position:sticky;z-index:2;left:48px[^>]*>Row label/);
  assert.match(result.html, /<th scope="row" style="position:sticky;left:0;z-index:4;top:32px">1<\/th>/);
  assert.match(result.html, /<th style="position:sticky;left:0;z-index:2"><\/th>/);
  assert.match(result.html, /min-width:215px;position:sticky;left:48px;z-index:1;[^>]*>A<\/th>/);
  assert.match(result.html, /\.sheet tbody th\{position:sticky;left:0;z-index:1\}/);
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

test('slides resolve master and layout decoration, theme colours and grouped shapes', async t => {
  const file = archive(t, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="master" Target="slideMasters/slideMaster1.xml"/><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:clrMap bg1="lt1" tx1="dk1" accent1="accent1"/><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Brand"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="400000"/></a:xfrm><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200"/><a:t>Brand bar</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="2" name="Prompt"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': '<Relationships><Relationship Id="theme" Target="../theme/theme1.xml"/></Relationships>',
    'ppt/theme/theme1.xml': '<a:theme xmlns:a="drawing"><a:themeElements><a:clrScheme name="T"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Major Sans"/></a:majorFont><a:minorFont><a:latin typeface="Minor Sans"/></a:minorFont></a:fontScheme><a:fmtScheme><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>',
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="3" name="Rule"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="500000"/><a:ext cx="6000000" cy="20000"/></a:xfrm><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill></p:spPr></p:sp></p:spTree></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': '<Relationships><Relationship Id="master" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:cSld><p:spTree><p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="10" name="Inner"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t>Grouped caption</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="layout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
  });
  const { html } = await readOfficePreview(file, 'presentation');
  assert.match(html, /background:#ff0000/);
  assert.match(html, /Brand bar/);
  assert.match(html, /background:#00aa00/);
  assert.match(html, /Grouped caption/);
  assert.match(html, /class="group"/);
  assert.doesNotMatch(html, /Click to edit Master text styles/);
});

test('slides inherit placeholder geometry from the next layer and never from themselves', async t => {
  const file = archive(t, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldSz cx="10000000" cy="5000000"/><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:clrMap bg1="lt1" tx1="dk1"/><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Master title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="100000" y="200000"/><a:ext cx="5000000" cy="600000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Master prompt</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="2" name="Master date"/><p:nvPr><p:ph type="dt" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="8000000" y="4500000"/><a:ext cx="1500000" cy="300000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>2024/01/01</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:sldMaster>',
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="3" name="Layout date"/><p:nvPr><p:ph type="dt" idx="9"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>Layout date text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': '<Relationships><Relationship Id="master" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="4" name="Title"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>Real title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="layout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
  });
  const { html } = await readOfficePreview(file, 'presentation');
  // ctrTitle fills the layout/master title slot, so the slide title takes that geometry.
  assert.match(html, /left:1%;top:4%;width:50%;height:12%/);
  assert.match(html, /Real title/);
  assert.doesNotMatch(html, /Master prompt/);
  assert.doesNotMatch(html, /2024\/01\/01/);
  // The layout date slot has no xfrm of its own, so it borrows the master's.
  assert.match(html, /Layout date text/);
  assert.match(html, /left:80%;top:90%/);
});

test('layout and master shapes never borrow a slide picture relationship', async t => {
  const file = archive(t, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldSz cx="1000" cy="1000"/><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="photo"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="layout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="photo" Target="../media/photo.png"/></Relationships>',
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:spTree><p:pic><p:blipFill><a:blip r:embed="photo"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic></p:spTree></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': '<Relationships/>',
    'ppt/media/photo.png': 'slide-photo',
  });
  const { html } = await readOfficePreview(file, 'presentation');
  assert.equal((html.match(/class="picture"/g) || []).length, 1);
  assert.equal((html.match(/class="picture missing"/g) || []).length, 1);
  assert.match(html, /src="data:image\/png;base64,/);
});

test('presentation previews carry the slide renderer truncation flag', async t => {
  const slides = {};
  const ids = [];
  for (let index = 0; index < 101; index++) {
    ids.push(`<p:sldId r:id="slide${index}"/>`);
    slides[`ppt/slides/slide${index}.xml`] = `<p:sld xmlns:p="ppt" xmlns:a="drawing"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="T"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Slide ${index}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  }
  const file = archive(t, {
    'ppt/presentation.xml': `<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldSz cx="1000" cy="1000"/><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>${ids.map((_, index) => `<Relationship Id="slide${index}" Target="slides/slide${index}.xml"/>`).join('')}</Relationships>`,
    ...slides,
  });
  const result = await readOfficePreview(file, 'presentation');
  assert.equal(result.truncated, true);
  assert.equal((result.html.match(/class="slide-page"/g) || []).length, 100);
});

test('slides render cached chart data and label undecodable EMF media', async t => {
  const file = archive(t, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="ppt" xmlns:r="rel"><p:sldSz cx="1000" cy="1000"/><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="ppt" xmlns:a="drawing" xmlns:r="rel"><p:cSld><p:spTree><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="1" name="Chart"/><p:nvPr/></p:nvGraphicFramePr><a:xfrm><a:off x="0" y="0"/><a:ext cx="800" cy="600"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="chart" r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame><p:pic><p:blipFill><a:blip r:embed="vector"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="700"/><a:ext cx="200" cy="200"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="chart" Target="../charts/chart1.xml"/><Relationship Id="vector" Target="../media/image1.emf"/></Relationships>',
    'ppt/charts/chart1.xml': '<c:chartSpace xmlns:c="chart" xmlns:a="drawing"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Cached ranking</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Model A</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Bench</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>0.9</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
    'ppt/media/image1.emf': 'emf-fixture',
  });
  const { html } = await readOfficePreview(file, 'presentation');
  assert.match(html, /Cached ranking/);
  assert.match(html, /Model A/);
  assert.match(html, /0\.9/);
  assert.match(html, /class="picture missing"/);
  assert.match(html, /image1\.emf/);
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

function docx(t, parts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-docx-edit-'));
  t.after(() => removeTree(directory));
  const file = path.join(directory, 'report.docx');
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' }).then(bytes => { fs.writeFileSync(file, bytes); return file; });
}

test('DOCX editing rewrites paragraph text and leaves every other part untouched', async t => {
  const body = '<?xml version="1.0"?><w:document xmlns:w="word"><w:body>'
    + '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> mix </w:t></w:r><w:r><w:t>italic</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Second &amp; last</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>';
  const file = await docx(t, {
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': body,
    'word/media/image1.png': Buffer.from([1, 2, 3, 4, 5]),
  });
  const snapshot = await readDocxEdit(file);
  assert.deepEqual(snapshot.blocks, ['Bold mix italic', 'Second & last', 'Cell']);
  const saved = await saveDocxEdit(snapshot, [{ index: 0, text: 'Edited <text> & more' }, { index: 2, text: 'Cell 2' }]);
  assert.ok(saved.file.size > 0);
  const archiveBytes = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(archiveBytes);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<w:t xml:space="preserve">Edited &lt;text&gt; &amp; more<\/w:t>/);
  assert.match(xml, /<w:t xml:space="preserve">Cell 2<\/w:t>/);
  assert.doesNotMatch(xml, /Bold mix italic/);
  assert.match(xml, /<w:jc w:val="center"\/>/);
  assert.match(xml, /<w:b\/>/);
  assert.deepEqual([...await zip.file('word/media/image1.png').async('nodebuffer')], [1, 2, 3, 4, 5]);
  assert.deepEqual((await readDocxEdit(file)).blocks, ['Edited <text> & more', 'Second & last', 'Cell 2']);
});

test('DOCX editing refuses external changes and keeps an unchanged file byte-identical', async t => {
  const body = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>One</w:t></w:r></w:p></w:body></w:document>';
  const file = await docx(t, { 'word/document.xml': body });
  const snapshot = await readDocxEdit(file);
  const original = fs.readFileSync(file);
  const unchanged = await saveDocxEdit(snapshot, []);
  assert.equal(unchanged.file.size, fs.statSync(file).size);
  assert.deepEqual(fs.readFileSync(file), original);
  await saveDocxEdit(snapshot, [{ index: 0, text: 'Two' }]);
  await assert.rejects(saveDocxEdit(snapshot, [{ index: 0, text: 'Three' }]), /changed on disk/);
  assert.deepEqual((await readDocxEdit(file)).blocks, ['Two']);
});

test('DOCX editing skips picture-only paragraphs that have no text runs', async t => {
  const body = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p>'
    + '<w:p><w:r><w:drawing/></w:r></w:p><w:p><w:r><w:t>After</w:t></w:r></w:p></w:body></w:document>';
  const file = await docx(t, { 'word/document.xml': body });
  const snapshot = await readDocxEdit(file);
  assert.deepEqual(snapshot.blocks, ['Before', '', 'After']);
  await saveDocxEdit(snapshot, [{ index: 0, text: 'Changed' }, { index: 1, text: '' }]);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
  assert.match(xml, /<w:drawing\/>/);
  assert.match(xml, /<w:t xml:space="preserve">Changed<\/w:t>/);
});

test('DOCX editing keeps a text box drawing while replacing the outer paragraph', async t => {
  const body = '<w:document xmlns:w="word"><w:body>'
    + '<w:p><w:r><w:t>Outer</w:t></w:r><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Inside</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>'
    + '</w:body></w:document>';
  const file = await docx(t, { 'word/document.xml': body });
  const snapshot = await readDocxEdit(file);
  // A text box is its own Word story. Its paragraph is not part of the outer
  // paragraph, and an outer edit must leave the whole drawing untouched.
  assert.deepEqual(snapshot.blocks, ['Outer']);
  await saveDocxEdit(snapshot, [{ index: 0, text: 'Outer changed' }]);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
  assert.match(xml, /<w:t>Inside<\/w:t>/);
  assert.match(xml, /<w:t xml:space="preserve">Outer changed<\/w:t>/);
});

test('DOCX editing round-trips tabs, line breaks and entities without duplicating markup', async t => {
  const body = '<w:document xmlns:w="word"><w:body>'
    + '<w:p><w:r><w:t>Name</w:t><w:tab/><w:t>42 &#x1F642; &#128512;</w:t><w:br/><w:t>Last</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Plain</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const file = await docx(t, { 'word/document.xml': body });
  const snapshot = await readDocxEdit(file);
  assert.deepEqual(snapshot.blocks, ['Name\t42 🙂 😀\nLast', 'Plain']);
  await saveDocxEdit(snapshot, [{ index: 0, text: 'Changed\tvalue\nsecond' }]);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
  assert.equal((xml.match(/<w:tab\/>/g) || []).length, 1);
  assert.equal((xml.match(/<w:br\/>/g) || []).length, 1);
  assert.match(xml, /<w:t xml:space="preserve">Changed<\/w:t><w:tab\/><w:t xml:space="preserve">value<\/w:t><w:br\/><w:t xml:space="preserve">second<\/w:t>/);
  assert.doesNotMatch(xml, /&#128512;|&#x1F642;/);
  assert.deepEqual((await readDocxEdit(file)).blocks, ['Changed\tvalue\nsecond', 'Plain']);
});

test('DOCX editing protects direct page breaks and reports locked paragraphs', async t => {
  const body = '<w:document xmlns:w="word"><w:body>'
    + '<w:p><w:r><w:t>Before</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>First page</w:t><w:br w:type="page"/><w:t>Second page</w:t></w:r></w:p>'
    + '<w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Inside</w:t><w:br w:type="page"/></w:r></w:p></w:txbxContent></w:drawing></w:r><w:t>Outer</w:t></w:p>'
    + '</w:body></w:document>';
  const file = await docx(t, { 'word/document.xml': body });
  const snapshot = await readDocxEdit(file);
  assert.deepEqual(snapshot.blocks, ['Before', 'First page\nSecond page', 'Outer']);
  assert.deepEqual(snapshot.editability, [true, false, true]);
  await assert.rejects(saveDocxEdit(snapshot, [{ index: 1, text: 'Merged' }]), /page break/);
  // A page break inside a text box belongs to that nested story and must not
  // make the outer paragraph read-only.
  await saveDocxEdit(snapshot, [{ index: 2, text: 'Outer changed' }]);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
  assert.match(xml, /<w:t>First page<\/w:t><w:br w:type="page"\/><w:t>Second page<\/w:t>/);
  assert.match(xml, /<w:t xml:space="preserve">Outer changed<\/w:t>/);
});

test('DOCX editing refuses a stale editability list after the page-break set changes', async t => {
  const safe = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:body></w:document>';
  const risky = safe.replace('<w:t>Two</w:t>', '<w:t>Two</w:t><w:br w:type="page"/>');
  const file = await docx(t, { 'word/document.xml': safe });
  const snapshot = await readDocxEdit(file);
  assert.deepEqual(snapshot.editability, [true, true]);
  // Model an external edit that keeps the same paragraph count but inserts a
  // page break. The save must re-scan the body, not trust the old list.
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  zip.file('word/document.xml', risky);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(saveDocxEdit(snapshot, [{ index: 1, text: 'Changed' }]), /changed on disk|page break/);
  assert.equal((await readDocxEdit(file)).blocks[1], 'Two\n');
});

test('DOCX editing exposes a paragraph containing only a tab or line break', async t => {
  const body = '<w:document xmlns:w="word"><w:body>'
    + '<w:p><w:r><w:tab/><w:br/></w:r></w:p>'
    + '</w:body></w:document>';
  const file = await docx(t, { 'word/document.xml': body });
  const snapshot = await readDocxEdit(file);
  assert.deepEqual(snapshot.blocks, ['\t\n']);
  assert.deepEqual(snapshot.editability, [true]);
  await saveDocxEdit(snapshot, [{ index: 0, text: 'Only a tab remains:\t' }]);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
  assert.match(xml, /<w:t xml:space="preserve">Only a tab remains:<\/w:t><w:tab\/>/);
});

test('DOCX editing rejects duplicate paragraph edits', async t => {
  const body = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>One</w:t></w:r></w:p></w:body></w:document>';
  const file = await docx(t, { 'word/document.xml': body });
  const snapshot = await readDocxEdit(file);
  await assert.rejects(saveDocxEdit(snapshot, [{ index: 0, text: 'A' }, { index: 0, text: 'B' }]), /Duplicate/);
});
