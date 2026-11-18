'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/renderer/chat/markdown-preview');
const baseUrl = 'file:///C:/project/README.md';

test('preview formulas handle escaped dollars, multiline parentheses, nested containers and table cells', () => {
  for (const formula of [String.raw`$$\text{\$5} + x$$`, String.raw`\[\text{\$5} + x\]`, String.raw`\(x+
y\)`]) {
    const html = render(formula);
    assert.equal((html.match(/class="katex"/g) || []).length, 1);
    assert.doesNotMatch(html, /katex-error/);
  }
  const html = render(String.raw`- Formula:
  \[
  \frac{a}{b}
  \]

> $$
> x+y
> $$

| Formula | Value |
| --- | --- |
| \[x^2\] | $y$ |`);
  assert.equal((html.match(/class="katex"/g) || []).length, 4);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 3);
  assert.doesNotMatch(html, /katex-error/);
  assert.match(html, /<li>Formula:[\s\S]*?<section>/);
});

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
  assert.doesNotMatch(html, /<(?:script|img)\b|href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(render('[blocked](ftp://example.com/file)', { baseUrl }), /<a\b/);
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

test('explicit local file links open the local preview while network shares stay inert', () => {
  const explicit = render('[local](file:///C:/secret.txt)', { baseUrl });
  assert.match(explicit, /href="file:\/\/\/C:\/secret\.txt"/);
  assert.doesNotMatch(render('[share](file://server/share)', { baseUrl }), /<a\b/);
  assert.doesNotMatch(render('![share](//server/share.png)', { baseUrl }), /<img\b/);
});

test('bare file names stay literal while www hosts and e-mail addresses become links', () => {
  const html = render('README.md setup.sh main.rs example.com www.example.com person@example.com', { baseUrl });
  for (const name of ['README.md', 'setup.sh', 'main.rs']) assert.doesNotMatch(html, new RegExp('href="[^"]*' + name));
  assert.match(html, /href="http:\/\/example\.com\/"/);
  assert.match(html, /href="http:\/\/www\.example\.com\/"/);
  assert.match(html, /href="mailto:person@example\.com"/);
});

test('mailto links open instead of being marked as blocked', () => {
  const html = render('[Contact](mailto:person@example.com)', { baseUrl });
  assert.match(html, /href="mailto:person@example\.com"/);
  assert.doesNotMatch(html, /data-preview-blocked/);
});

test('Windows paths and heading fragments resolve to local file URLs', () => {
  assert.match(render('[doc](C:/project/docs/a.md#Install)', { baseUrl }), /href="file:\/\/\/C:\/project\/docs\/a\.md#Install"/);
  assert.match(render('[doc](C:\\project\\docs\\a.md)', { baseUrl }), /href="file:\/\/\/C:\/project\/docs\/a\.md"/);
  assert.match(render('[doc](file:///C:/project/docs/a.md#Install)', { baseUrl }), /href="file:\/\/\/C:\/project\/docs\/a\.md#Install"/);
});

test('Markdown video syntax renders a playback element in document previews', () => {
  const html = render('![Clip](media/clip.mp4)', { baseUrl });
  assert.match(html, /<video class="file-preview-video"[^>]*src="file:\/\/\/C:\/project\/media\/clip\.mp4"/);
  assert.match(html, /controls preload="metadata" playsinline/);
  assert.doesNotMatch(html, /<img\b/);
});

test('chunked rendering matches synchronous rendering and reports progress', async () => {
  const { render, renderChunked } = require('../src/renderer/chat/markdown-preview');
  const source = ('## Section\n\nParagraph with [link](https://example.com) and `code`.\n\n').repeat(900);
  const expected = render(source, { baseUrl });
  const chunks = [];
  const actual = await renderChunked(source, {
    baseUrl,
    onChunk: html => chunks.push(html),
    yieldControl: async () => {},
  });
  assert.equal(actual, expected);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), expected);
});

test('chunked rendering stops on abort without returning partial HTML', async () => {
  const { renderChunked } = require('../src/renderer/chat/markdown-preview');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderChunked('# Heading\n\nBody\n', { baseUrl, signal: controller.signal, yieldControl: async () => {} }),
    /cancelled/i,
  );
});

test('code blocks expose source line ranges for chat-to-preview navigation', () => {
  const html = render('Text\n\n```js\nconst value = 1;\n```\n', { baseUrl, sourceLines: true });
  assert.match(html, /<div class="preview-source-block" data-preview-line="3" data-preview-end-line="5">/);
});

test('heading anchors match their links without regard to case', () => {
  const html = render('## Install (Windows)\n\n[Jump](#install-windows)', { baseUrl });
  assert.match(html, /data-preview-anchor="install-windows"/);
  assert.match(html, /href="#install-windows"/);
});
