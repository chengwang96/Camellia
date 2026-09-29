'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MarkdownIt = require('markdown-it');
const links = require('../src/renderer/chat/markdown-links');
const preview = require('../src/renderer/chat/markdown-preview');
const escape = new MarkdownIt().utils.escapeHtml;
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');

function chatRenderer(cwd = 'D:/Code/DSH') {
  const context = {
    window: { CamelliaMarkdownLinks: links, CamelliaMarkdownPreview: preview },
    sidebar: { sessions: [{ id: 'chat', cwd }], workspaces: [] },
    context: { sessionId: 'chat', workspaceId: null },
    SENT: '\x01', esc: escape,
    renderCodeBlock: (_language, code) => '<pre><code>' + escape(code) + '</code></pre>',
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function splitTableRow('), source.indexOf('  // Chat block layout')), context);
  vm.runInContext(source.slice(source.indexOf('  function mdRender('), source.indexOf("  chat.addEventListener('click'")), context);
  return context.mdRender;
}

test('the reported Windows Markdown link renders a label and a preview path without the line suffix', () => {
  const html = chatRenderer()('对应说明：[多账号管理](D:/Code/DSH/docs/configuration.md:62)。');
  assert.match(html, /^对应说明：<a /);
  assert.match(html, /data-chat-file="D:\/Code\/DSH\/docs\/configuration.md"/);
  assert.match(html, /data-chat-line="62"/);
  assert.match(html, />多账号管理<\/a>。$/);
  assert.doesNotMatch(html, /\[多账号管理\]/);
});

test('web links support balanced parentheses, titles, formatted labels and escaped attributes', () => {
  const html = chatRenderer()('[**Guide** `v2`](https://example.com/guide_(v2)?a=1&b=2 "A & B")');
  assert.match(html, /href="https:\/\/example.com\/guide_\(v2\)\?a=1&amp;b=2"/);
  assert.match(html, /title="A &amp; B"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<strong>Guide<\/strong> <code class="md-inline">v2<\/code><\/a>/);
});

test('local links support spaces, Unicode, backslashes, file URLs and line/column suffixes', () => {
  for (const target of [
    'D:/My Project/说明 (final).md:62:4',
    'D:\\My Project\\说明 (final).md:62:4',
    'file:///D:/My%20Project/说明%20(final).md#L62C4',
  ]) {
    const html = chatRenderer()('[文档](<' + target + '>)');
    assert.match(html, /data-chat-file="D:\/My Project\/说明 \(final\).md"/);
    assert.match(html, /data-chat-line="62"/);
  }
  assert.equal(links.destination('/home/me/guide.md:4').path, '/home/me/guide.md');
  assert.equal(links.destination('C:/100%25/notes%23L62.md').path, 'C:/100%/notes#L62.md');
});

test('relative links resolve from the conversation directory and retain heading anchors', () => {
  const html = chatRenderer()('[Doc](docs/configuration.md#several-accounts-of-one-provider)');
  assert.match(html, /data-chat-file="D:\/Code\/DSH\/docs\/configuration.md"/);
  assert.match(html, /data-chat-anchor="several-accounts-of-one-provider"/);
  assert.equal(links.destination('../guide.md:3', '/home/me/project').path, '/home/me/guide.md');
  assert.doesNotMatch(chatRenderer('')('[Doc](docs/configuration.md)'), /<a /);
});

test('code examples remain literal and links in tables render with the same rules as prose', () => {
  const link = '[Doc](D:/Code/DSH/docs/configuration.md:62)';
  const html = chatRenderer()('## Reference\n\n`' + link + '`\n\n```md\n' + link + '\n```\n\n| Guide | Value |\n| --- | ---: |\n| ' + link + ' | **Ready** `a|b` |');
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.match(html, /<code class="md-inline">\[Doc\]/);
  assert.match(html, /<pre><code>\[Doc\]/);
  assert.match(html, /<td><a /);
  assert.match(html, /<strong>Ready<\/strong> <code class="md-inline">a\|b<\/code>/);
});

test('incomplete streaming links stay readable until their closing delimiter arrives', () => {
  const render = chatRenderer(), partial = '[多账号管理](D:/Code/DSH/docs/configuration.md:62';
  assert.equal(render(partial), partial);
  assert.match(render(partial + ')'), /<a [^>]*>多账号管理<\/a>/);
});

test('untrusted message markup, active URL schemes and network shares do not become active content', () => {
  const render = chatRenderer();
  for (const target of ['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html,evil',
    'vbscript:evil', 'ftp://example.com/file', 'file://server/share', '//server/share',
    '%5C%5Cserver%5Cshare', '/tmp/..//server/share', 'D:/bad%00file.md', 'https://user:pass@example.com']) {
    assert.doesNotMatch(render('[Bad](' + target + ')'), /<a\b/, target);
  }
  assert.doesNotMatch(render('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n![image](https://example.com/image.png)'), /<(?:img|script)\b/);
  assert.match(render('[Doc](<D:/notes/quoted"file.md>)'), /data-chat-file="D:\/notes\/quoted&quot;file.md"/);
});

test('Markdown previews expose source lines for finding a linked section', () => {
  const html = preview.render('# Title\n\nIntro\n\n## Accounts\n\nDetails', { sourceLines: true });
  assert.match(html, /<h2[^>]*data-preview-line="5"[^>]*data-preview-end-line="5"[^>]*>Accounts<\/h2>/);
  assert.match(html, /<p[^>]*data-preview-line="7"[^>]*>Details<\/p>/);
});

test('chat renders local Markdown images with resolved paths and preview controls', () => {
  for (const target of ['D:/Code/DSH/artifacts/preview.png', 'artifacts/preview.png', 'file:///D:/Code/DSH/artifacts/preview.png']) {
    const html = chatRenderer()('![预览](' + target + ')');
    assert.match(html, /<img class="chat-inline-image"/);
    assert.match(html, /src="file:\/\/\/D:\/Code\/DSH\/artifacts\/preview.png"/);
    assert.match(html, /data-chat-file="D:\/Code\/DSH\/artifacts\/preview.png"/);
    assert.match(html, /alt="预览"/);
    assert.match(html, /loading="lazy"/);
    assert.match(html, /tabindex="0" role="button"/);
  }
  assert.match(chatRenderer()('![Preview](<D:/My images/图 1.png>)'), /My%20images/);
  assert.doesNotMatch(chatRenderer()('![Preview](D:/Code/DSH/index.html)'), /<img /);
  assert.doesNotMatch(chatRenderer()('`![Preview](D:/Code/DSH/image.png)`'), /<img /);
  assert.doesNotMatch(chatRenderer()('![Preview](D:/Code/DSH/image.png'), /<img /);
});
