'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const math = require('../src/renderer/shared/markdown-math');

test('math delimiters ignore escaped TeX dollars and escaped bracket commands', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    const tex = String.raw`\text{\$5} + \begin{matrix}a&b\\[2pt]c&d\end{matrix}`;
    const source = open + tex + close;
    assert.deepEqual(math.read(source), { tex, raw: source, length: source.length, display: open === '$$' || open === '\\[' });
    assert.doesNotMatch(math.html(math.read(source)), /katex-error/);
  }
  assert.equal(math.read(String.raw`\\[x\\]`), null);
  assert.equal(math.read(String.raw`\$x\$`, 1), null);
  assert.equal(math.read('5$x$10', 1), null);
  assert.equal(math.read('$5 and $10'), null);
  assert.equal(math.read('$10 today, `$x$`'), null);
});

test('incomplete and overlong math remains literal, including at every chunk boundary', () => {
  for (const source of [String.raw`\[\frac{a}{b}\]`, String.raw`$$\text{\$5} + x$$`, String.raw`\(x+

y\)`]) {
    for (let length = 1; length < source.length; length++) assert.equal(math.read(source.slice(0, length)), null);
    assert.ok(math.read(source));
  }
  assert.equal(math.read('$$' + 'x'.repeat(20001) + '$$'), null);
  assert.equal(math.render('x'.repeat(20001)), null);
});

test('protecting math skips fenced, inline and indented code and removes only enclosing quote markers', () => {
  const formulas = [];
  const source = String.raw`Inline \(x\).

> \[
> a+b
> \]

\[
> c
\]

    $$literal$$

~~~tex
\[literal\]

$$literal$$
~~~

` + '`$literal$`';
  const protectedSource = math.protect(source, span => { formulas.push(span); return '@math' + formulas.length; });
  assert.equal(formulas.length, 3);
  assert.equal(formulas[1].tex.trim(), 'a+b');
  assert.equal(formulas[2].tex.trim(), '> c');
  assert.match(protectedSource, /    \$\$literal\$\$/);
  assert.match(protectedSource, /\\\[literal\\\]/);
  assert.match(protectedSource, /`\$literal\$`/);
});

test('untrusted TeX and broken formulas never activate URLs or throw', () => {
  for (const tex of [String.raw`\href{javascript:alert(1)}{bad}`, String.raw`\includegraphics{https://example.com/tracker}`, String.raw`\unknownCommand{value}`]) {
    assert.doesNotThrow(() => math.render(tex));
    assert.doesNotMatch(math.render(tex), /<a\b|<img\b|<script\b/);
  }
  assert.doesNotMatch(math.render(String.raw`\def\a{\a}\a`), /<script\b/);
});
