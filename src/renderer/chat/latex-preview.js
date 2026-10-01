'use strict';

// Renders LaTeX source with KaTeX in the browser, without a LaTeX toolchain.
// Only a small, explicit set of wrapper commands is stripped so pasted
// `\begin{document}` documents still preview; no other preprocessing happens.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(globalThis);
  else root.CamelliaLatexPreview = factory(root);
})(typeof window === 'object' ? window : globalThis, function (root) {
  const MAX_CHARACTERS = 20000;
  const MAX_DISPLAY_BLOCKS = 200;

  function katexVersion(katex) {
    return String(katex?.version || '').replace(/[^0-9.]/g, '');
  }

  // `\begin{equation}…\end{equation}` is valid LaTeX but KaTeX only accepts it in
  // display mode, so the wrapper is removed and its body rendered as a display
  // formula. A pasted whole document keeps working after its preamble and the
  // `document` environment are dropped; macro definitions are preserved because
  // a block may legitimately use them.
  function normalize(source) {
    let text = String(source || '').replace(/\r\n?/g, '\n').trim();
    const environment = /^\\begin\{(equation\*?|displaymath|math)\}([\s\S]*?)\\end\{\1\}\s*$/.exec(text);
    if (environment) return { body: environment[2].trim(), wrapped: true };
    const document = /\\begin\{document\}/.exec(text);
    if (document) text = text.slice(document.index + document[0].length);
    if (!document) return { body: text, wrapped: false };
    return {
      body: text.replace(/\\end\{document\}\s*$/, '')
        .replace(/\\documentclass(?:\[[^\]]*\])?\{[^}]*\}/g, '')
        .replace(/\\usepackage(?:\[[^\]]*\])?\{[^}]*\}/g, '')
        .replace(/\\(?:maketitle|tableofcontents|newpage|clearpage|pagestyle|thispagestyle|title|author|date)\b[^\n]*/g, '')
        .trim(),
      wrapped: true,
    };
  }

  // `\begin{align}…\end{align}` keeps working because KaTeX renders a whole
  // environment itself. A statement without any environment is treated as one
  // display formula, so `E = mc^2` alone previews too.
  function displaySource(body) {
    if (/\\begin\{[A-Za-z*]+\}/.test(body)) return body;
    return '\\displaystyle ' + body;
  }

  // Split on blank lines only when that does not fall inside an environment,
  // otherwise `\\[2mm]`-style spacing in one formula would be cut in half.
  function splitStatements(body) {
    const parts = []; let current = []; let depth = 0;
    for (const line of body.split('\n')) {
      if (/\\(?:begin|end)\{[A-Za-z*]+\}/.test(line)) depth = Math.max(0, depth + (line.includes('\\begin') ? 1 : 0) - (line.includes('\\end') ? 1 : 0));
      if (!line.trim() && depth === 0 && current.join('\n').trim()) { parts.push(current.join('\n').trim()); current = []; continue; }
      current.push(line);
    }
    if (current.join('\n').trim()) parts.push(current.join('\n').trim());
    return parts.length ? parts : [body];
  }

  function render(source, options = {}) {
    const katex = options.katex || root?.katex;
    const text = String(source || '');
    const truncated = text.length > MAX_CHARACTERS;
    if (!katex || typeof katex.renderToString !== 'function') return { ok: false, katex: false, truncated, blocks: [] };
    const settings = {
      throwOnError: true, strict: 'ignore', trust: false, maxExpand: 200, maxSize: 20,
      ...(options.katexOptions || {}),
    };
    const normalized = normalize(truncated ? text.slice(0, MAX_CHARACTERS) : text);
    if (!normalized.body || !/[^\s{}]/.test(normalized.body)) {
      return { ok: true, katex: true, version: katexVersion(katex), truncated, wrapped: normalized.wrapped, blocks: [], empty: true };
    }
    const blocks = [];
    for (const statement of splitStatements(normalized.body).slice(0, MAX_DISPLAY_BLOCKS)) {
      // KaTeX rejects `=` in an array preamble; the document flavour is common
      // enough in pasted code to normalize it instead of failing the preview.
      // KaTeX rejects `=` in an array preamble, but the "align the columns"
      // flavour is common enough in pasted LaTeX to normalize instead of fail.
      const body = displaySource(statement.replace(/(\\begin\{array\}\{[^}]*\})/g, preamble => preamble.replace(/=/g, 'c')));
      try {
        blocks.push({ html: katex.renderToString(body, { ...settings, displayMode: true }), source: statement });
      } catch (error) {
        blocks.push({ error: String(error?.message || error), source: statement });
      }
    }
    const failed = blocks.some(block => block.error);
    return { ok: !failed, katex: true, version: katexVersion(katex), truncated, wrapped: normalized.wrapped, blocks };
  }

  return { render, normalize, displaySource, splitStatements, MAX_CHARACTERS, MAX_DISPLAY_BLOCKS };
});
