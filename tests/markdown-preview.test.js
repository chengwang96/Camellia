'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/renderer/chat/markdown-preview');
const baseUrl = 'file:///C:/project/README.md';

test('document math and footnotes render without allowing trusted TeX commands', () => {
  const html = render('Inline $x^2 + y^2$ and note[^source].\n\n$$\n\\frac{1}{2}\n$$\n\n[^source]: A **source**.');
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /id="fnpreview-note-1"/);
  assert.match(html, /href="#fnrefpreview-note-1"/);
  const unsafe = render('$\\href{javascript:alert(1)}{bad}$ $\\includegraphics{https://example.com/tracker}$');
  assert.doesNotMatch(unsafe, /<a\b|<img\b/);
  assert.doesNotThrow(() => render('$\\notARealCommand{value}$'));
});

test('highlighting preserves code text, escapes markup and bounds expensive work', () => {
  const { highlight } = require('../src/renderer/chat/markdown-preview');
  assert.match(highlight('js', 'const answer = 42;'), /class="hljs-keyword"/);
  assert.equal(highlight('unknown', '<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(highlight('js', 'x'.repeat(50001)), 'x'.repeat(50001));
  assert.doesNotMatch(render('```html\n<img src=x onerror=alert(1)>\n```'), /<img\b/);
});

test('document Markdown renders the reported README links and real nested lists', () => {
  const html = render('See [scheduled experiment checks](docs/scheduled-tasks.md).\n\n- [Configuration guide](docs/configuration.md) — providers\n  - Nested item\n- [Development guide](docs/development.md)\n\n1. First\n2. Second\n\n[Upstream](https://example.com/path_(one))', { baseUrl });
  assert.match(html, /href="file:\/\/\/C:\/project\/docs\/scheduled-tasks.md"/);
  assert.match(html, /<ul>\n<li><a[^>]*>Configuration guide<\/a>/);
  assert.match(html, /<ul>\n<li>Nested item<\/li>/);
  assert.match(html, /<ol>\n<li>First<\/li>/);
  assert.match(html, /href="https:\/\/example.com\/path_\(one\)" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /\[Configuration guide\]/);
});

test('Markdown supports references, images, emphasis, quotes, tasks and fenced code', () => {
  const html = render('# Heading\n\n[Reference][guide]\n\n[guide]: docs/guide.md\n\n![Diagram](assets/plot.png)\n\n*italic* ~~removed~~ **bold**\n\n> Quoted\n\n- [x] Done\n- [ ] Pending\n\n~~~js\n<script>no execution</script>\n~~~\n\n| Name | Value |\n| --- | ---: |\n| A | 42 |', { baseUrl });
  assert.match(html, /href="file:\/\/\/C:\/project\/docs\/guide.md"/);
  assert.match(html, /src="file:\/\/\/C:\/project\/assets\/plot.png" alt="Diagram"/);
  for (const tag of ['em', 's', 'strong', 'blockquote', 'table']) assert.match(html, new RegExp('<' + tag + '[ >]'));
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /<pre><code>&lt;script&gt;no execution&lt;\/script&gt;/);
});

test('untrusted Markdown cannot inject HTML, script URLs or network file shares', () => {
  const html = render('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[encoded](jav&#x61;script:alert(1))\n\n![bad](data:text/html,evil)\n\n[share](file://server/share)\n\n![share](//server/share.png)\n\n[local](file:///C:/secret.txt)', { baseUrl });
  assert.doesNotMatch(html, /<(?:script|img)\b|href="(?:javascript|file):/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(render('[blocked](ftp://example.com/file)', { baseUrl }), /data-preview-blocked="true"/);
});

test('heading anchors are scoped, unique and code renderers remain available', () => {
  const html = render('# Hello **world**\n\n# Hello world\n\n[Jump](#hello-world)\n\n```js\nvalue\n```', {
    baseUrl, codeBlock: (language, code) => `<pre data-language="${language}">${code}</pre>`,
  });
  assert.match(html, /id="preview-hello-world"/);
  assert.match(html, /id="preview-hello-world-1"/);
  assert.match(html, /href="#hello-world"/);
  assert.match(html, /<pre data-language="js">value/);
});
