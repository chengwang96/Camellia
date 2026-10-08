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
  const markup = render('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n![image](https://example.com/image.png)');
  assert.doesNotMatch(markup, /<script\b|<img src=x/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((markup.match(/<img\b/g) || []).length, 1);
  assert.match(markup, /<img class="chat-inline-image" src="https:\/\/example\.com\/image\.png"[^>]*referrerpolicy="no-referrer">/);
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

test('chat renders inline and display math while leaving prices and code literal', () => {
  const html = chatRenderer()('质能方程 $E = mc^2$，以及 $J_\\nu(z)=\\frac{1}{2}$。\n\n$$\n\\hat{H}\\,\\psi_n = E_n\\,\\psi_n\n$$\n\n价格 $5 and $10 today, `$E=mc^2$`.');
  assert.match(html, /质能方程 <eq><span class="katex">/);
  assert.match(html, /katex-display/);
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.match(html, /价格 \$5 and \$10 today, <code class="md-inline">\$E=mc\^2\$<\/code>\./);
  assert.match(html, /<span class="katex-mathml">/);
});

test('chat renders the reported bracket-delimited loss formula as display math', () => {
  const formula = String.raw`\[
L_{\mathrm{total}}
=L_{\mathrm{harm}}
+\lambda_1L_{\mathrm{anat}}
+\lambda_2L_{\mathrm{les}}
+\lambda_3L_{\mathrm{latent}}
+\lambda_4L_{\mathrm{edge}}
+\lambda_5L_{\mathrm{tex}}
\]`;
  const html = chatRenderer()('算法 2 又加入六项损失：\n\n' + formula + '\n\n它们分别约束：');
  assert.equal((html.match(/class="katex-display"/g) || []).length, 1);
  assert.match(html, /<math[^>]*display="block">/);
  assert.match(html, /<annotation encoding="application\/x-tex">\s*L_\{\\mathrm\{total\}\}/);
  assert.doesNotMatch(html, /katex-error|<ul|<blockquote|<hr/);
  assert.match(html, /^算法 2 又加入六项损失：\n\n<section>/);
  assert.match(html, /<\/section>\n\n它们分别约束：$/);
});

test('chat supports both math delimiter styles together and protects bracket formula contents', () => {
  const render = chatRenderer();
  const html = render(String.raw`行内 $x^2$ 与 \(y_1\)。

\[
- a \\ - b
> c
---
\]

$$z^2$$`);
  assert.equal((html.match(/class="katex"/g) || []).length, 4);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 2);
  assert.doesNotMatch(html, /<ul|<blockquote|<hr/);
});

test('bracket formula examples in code stay literal and incomplete streamed formulas wait for their close', () => {
  const render = chatRenderer();
  const formula = String.raw`\[x^2\]`;
  const examples = render('`' + formula + '`\n\n```tex\n' + formula + '\n```\n\n    ' + formula);
  assert.doesNotMatch(examples, /katex|\x01/);
  assert.match(examples, /<code class="md-inline">\\\[x\^2\\\]<\/code>/);
  assert.equal((examples.match(/<pre><code>\\\[x\^2\\\]\n?<\/code><\/pre>/g) || []).length, 2);
  assert.doesNotMatch(render(String.raw`\\[x^2\\]`), /katex/);
  const partial = String.raw`公式：\[
\frac{a}{b}`;
  assert.doesNotMatch(render(partial), /katex/);
  assert.match(render(partial), /\\frac\{a\}\{b\}/);
  const complete = render(partial + '\n\\]');
  assert.equal((complete.match(/class="katex-display"/g) || []).length, 1);
  assert.doesNotMatch(complete, /katex-error/);
});

test('chat math keeps unsupported TeX commands inert instead of executing them', () => {
  const html = chatRenderer()('$\\href{javascript:alert(1)}{bad}$');
  assert.doesNotMatch(html, /<a\b/);
  assert.doesNotThrow(() => chatRenderer()('$\\notARealCommand{value}$'));
});

test('chat renders lists with nesting, ordering and GitHub task checkboxes', () => {
  const render = chatRenderer();
  assert.match(render('- one\n- two'), /^<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>$/);
  assert.match(render('1. one\n2. two'), /^<ol class="md-list"><li>one<\/li><li>two<\/li><\/ol>$/);
  assert.match(render('3. three'), /^<ol class="md-list" start="3">/);
  assert.match(render('- parent\n  - child'), /<li>parent<ul class="md-list"><li>child<\/li><\/ul><\/li>/);
  const tasks = render('- [x] done\n- [ ] todo');
  assert.match(tasks, /<li class="md-task"><input type="checkbox" disabled checked aria-label="Completed"> done<\/li>/);
  assert.match(tasks, /<li class="md-task"><input type="checkbox" disabled aria-label="Not completed"> todo<\/li>/);
  assert.match(render('- **bold** and [Doc](D:/Code/DSH/docs/configuration.md:62)'), /<li><strong>bold<\/strong> and <a /);
  assert.match(render('- `npm test`'), /<li><code class="md-inline">npm test<\/code><\/li>/);
});

test('a bilingual line stays inside the list item it belongs to', () => {
  const render = chatRenderer();
  const html = render('- `Title one`\n中文译文一\n- `Title two`\n中文译文二');
  assert.match(html, /^<ul class="md-list"><li><code class="md-inline">Title one<\/code>\n中文译文一<\/li><li><code class="md-inline">Title two<\/code>\n中文译文二<\/li><\/ul>$/);
  assert.equal((html.match(/<ul /g) || []).length, 1);
  assert.match(render('- item\n  缩进的续行'), /<li>item\n缩进的续行<\/li>/);
  assert.match(render('- item\n    - child\n    子项续行'), /<li>item<ul class="md-list"><li>child\n子项续行<\/li><\/ul><\/li>/);
});

test('a list still ends at a blank line or the next block', () => {
  const render = chatRenderer();
  assert.match(render('- item\n\n普通段落'), /<\/ul>\n+普通段落$/);
  assert.match(render('- item\n## 标题'), /<\/ul>\n<strong>标题<\/strong>$/);
  assert.match(render('- item\n> 引用'), /<\/ul>\n<blockquote class="md-quote">引用<\/blockquote>$/);
  assert.match(render('- item\n---'), /<\/ul>\n<hr class="md-rule">$/);
  assert.match(render('- item\n```\ncode\n```'), /<\/ul>\n<pre><code>code\n<\/code><\/pre>$/);
});

test('chat renders blockquotes, rules and headings without touching fenced code', () => {
  const render = chatRenderer();
  assert.match(render('> quoted **text**'), /^<blockquote class="md-quote">quoted <strong>text<\/strong><\/blockquote>$/);
  assert.match(render('> first\n> second'), /<blockquote class="md-quote">first<br>second<\/blockquote>/);
  for (const rule of ['---', '***', '___']) assert.match(render('a\n\n' + rule + '\n\nb'), /a\n\n<hr class="md-rule">\n\nb/);
  assert.match(render('###### Six'), /^<strong>Six<\/strong>$/);
  assert.match(render('```\n- not a list\n> not a quote\n---\n```'), /<pre><code>- not a list\n&gt; not a quote\n---\n<\/code><\/pre>/);
  assert.match(render('`- flag`'), /<code class="md-inline">- flag<\/code>/);
});

test('display math is protected from the list and quote block rules', () => {
  const html = chatRenderer()('前文\n\n$$\n- a \\\\ - b\n$$\n\n后文');
  assert.match(html, /katex-display/);
  assert.doesNotMatch(html, /<ul class="md-list">/);
  const quote = chatRenderer()('$$\n> a\n$$');
  assert.match(quote, /katex-display/);
  assert.doesNotMatch(quote, /<blockquote/);
});

test('autolinks cover explicit schemes, www hosts and e-mail without faking file names', () => {
  const render = chatRenderer();
  assert.match(render('see https://example.com/path now'), /<a href="https:\/\/example\.com\/path"[^>]*>https:\/\/example\.com\/path<\/a>/);
  assert.match(render('see www.example.com now'), /<a href="http:\/\/www\.example\.com\/"[^>]*>www\.example\.com<\/a>/);
  const mail = render('mail me@example.com ok');
  assert.match(mail, /<a href="mailto:me@example\.com"[^>]*>me@example\.com<\/a>/);
  assert.doesNotMatch(mail, /target="_blank"/);
  assert.match(render('~~removed~~'), /^<s>removed<\/s>$/);
  for (const name of ['README.md', 'setup.sh', 'index.html', 'D:/Code/DSH/docs/configuration.md', 'D:/bad%00file.md']) {
    assert.doesNotMatch(render(name), /<a\b/, name);
  }
});

test('lists, quotes and autolinks stay inert for scripts and unsafe schemes', () => {
  const render = chatRenderer();
  assert.doesNotMatch(render('- <script>alert(1)</script>'), /<script\b/);
  assert.doesNotMatch(render('> <img src=x onerror=alert(1)>'), /<img\b/);
  assert.doesNotMatch(render('- [Bad](javascript:alert(1))'), /<a\b/);
  assert.doesNotMatch(render('- [Share](//server/share)'), /<a\b/);
});

test('chat renders indented code blocks and stops them at the next block', () => {
  const render = chatRenderer();
  assert.match(render('    const a = 1;\n    const b = 2;'), /^<pre><code>const a = 1;\nconst b = 2;<\/code><\/pre>$/);
  assert.match(render('    a\n\n    b'), /^<pre><code>a\n\nb<\/code><\/pre>$/);
  assert.match(render('    <b>x</b> **literal**'), /<pre><code>&lt;b&gt;x&lt;\/b&gt; \*\*literal\*\*<\/code><\/pre>/);
  assert.match(render('    code\n\n- item'), /<pre><code>code<\/code><\/pre>\n<ul class="md-list">/);
  assert.match(render('    code\n\n\ntext'), /<pre><code>code<\/code><\/pre>\n\ntext/);
  assert.doesNotMatch(render('    code\n\n- item'), /\[/);
});

test('chat renders prompts with the same Markdown rules as replies', () => {
  const html = chatRenderer()('- [ ] 待办\n\n**加粗** 与 `代码`\n\n1. 有序');
  assert.match(html, /<ul class="md-list"><li class="md-task"><input type="checkbox" disabled aria-label="Not completed"> 待办<\/li><\/ul>/);
  assert.match(html, /<strong>加粗<\/strong> 与 <code class="md-inline">代码<\/code>/);
  assert.match(html, /<ol class="md-list"><li>有序<\/li><\/ol>/);
  assert.doesNotMatch(chatRenderer()('![shot](javascript:alert(1))'), /<img\b/);
});

test('remote images render with a no-referrer hint and non-images stay literal', () => {
  const render = chatRenderer();
  assert.match(render('![chart](https://example.com/chart.png)'),
    /^<img class="chat-inline-image" src="https:\/\/example\.com\/chart\.png" alt="chart" title="https:\/\/example\.com\/chart\.png" loading="lazy" decoding="async" referrerpolicy="no-referrer">$/);
  for (const value of ['![x](https://example.com/file.txt)', '![x](//example.com/a.png)', '![x](data:image/png;base64,AAAA)']) {
    assert.doesNotMatch(render(value), /<img\b/, value);
  }
});
