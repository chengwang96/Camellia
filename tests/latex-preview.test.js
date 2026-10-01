'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const katex = require('katex');
const preview = require('../src/renderer/chat/latex-preview');

test('a full equation environment previews as a display formula', () => {
  const result = preview.render('\\begin{equation}\nE = mc^2\n\\end{equation}', { katex });
  assert.equal(result.ok, true);
  assert.equal(result.blocks.length, 1);
  assert.match(result.blocks[0].html, /class="katex-display"/);
  assert.doesNotMatch(result.blocks[0].html, /katex-error/);
});

test('environments, plain expressions and blank-line separated statements render', () => {
  const align = preview.render('\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}', { katex });
  assert.equal(align.ok, true);
  assert.match(align.blocks[0].html, /class="katex-display"/);
  const plain = preview.render('E = mc^2', { katex });
  assert.equal(plain.ok, true);
  assert.match(plain.blocks[0].html, /class="katex"/);
  const multiple = preview.render('x^2 + y^2\n\n\\frac{1}{2}', { katex });
  assert.equal(multiple.blocks.length, 2);
  assert.equal(multiple.ok, true);
});

test('wrapped commands are stripped and macro definitions survive', () => {
  const document = preview.render('\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nE = mc^2\n\\end{document}', { katex });
  assert.equal(document.ok, true);
  assert.equal(document.wrapped, true);
  const macros = preview.render('\\def\\R{\\mathbb{R}}\n\\R^2', { katex });
  assert.equal(macros.ok, true);
});

test('unsupported LaTeX stays inert and never throws', () => {
  const result = preview.render('\\begin{subequations}a=b\\end{subequations}', { katex });
  assert.equal(result.ok, false);
  assert.match(result.blocks[0].error, /subequations/);
  assert.equal(result.blocks[0].source, '\\begin{subequations}a=b\\end{subequations}');
  assert.doesNotThrow(() => preview.render('\\notARealCommand{value}', { katex }));
});

test('rendering is bounded and reports when the source was truncated', () => {
  const long = preview.render('x'.repeat(preview.MAX_CHARACTERS + 1), { katex });
  assert.equal(long.truncated, true);
  const many = preview.render(Array.from({ length: preview.MAX_DISPLAY_BLOCKS + 5 }, (unused, index) => String(index)).join('\n\n'), { katex });
  assert.equal(many.blocks.length, preview.MAX_DISPLAY_BLOCKS);
  const empty = preview.render('   \n', { katex });
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.blocks, []);
  assert.equal(preview.render('E=mc^2', {}).ok, false);
});
