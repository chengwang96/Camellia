'use strict';

// Chat, previews and discussions share delimiter parsing and KaTeX options.
// Scan delimiters directly: an escaped dollar in TeX belongs to the formula.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('katex'));
  else root.CamelliaMarkdownMath = factory(root.katex);
})(typeof window === 'object' ? window : globalThis, function (katex) {
  const MAX_LENGTH = 20000;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function escaped(source, index) {
    let slashes = 0;
    while (index > 0 && source[--index] === '\\') slashes++;
    return Boolean(slashes % 2);
  }
  function read(source, index = 0) {
    if (source[index] !== '$' && !source.startsWith('\\[', index) && !source.startsWith('\\(', index)) return null;
    if (escaped(source, index)) return null;
    let open, close, display;
    if (source.startsWith('$$', index)) { open = close = '$$'; display = true; }
    else if (source[index] === '$') {
      if (/[\d$]/.test(source[index - 1] || '') || !source[index + 1] || /\s/.test(source[index + 1])) return null;
      open = close = '$'; display = false;
    } else if (source.startsWith('\\[', index)) { open = '\\['; close = '\\]'; display = true; }
    else if (source.startsWith('\\(', index)) { open = '\\('; close = '\\)'; display = false; }
    else return null;
    const start = index + open.length, limit = Math.min(source.length, start + MAX_LENGTH + close.length);
    let braces = 0;
    for (let end = start; end < limit; end++) {
      if (close === '$' && source[end] === '\n') return null;
      if (close === '$' && /\d/.test(source[start]) && source[end] === '`' && !braces) return null;
      if ((source[end] === '{' || source[end] === '}') && !escaped(source, end)) {
        if (source[end] === '{') braces++;
        else if (source[end] === '}') braces = Math.max(0, braces - 1);
      }
      if (source.startsWith(close, end) && !escaped(source, end)) {
        if (end === start || end - start > MAX_LENGTH) return null;
        if (close === '$' && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] || ''))) return null;
        const length = end + close.length - index;
        return { tex: source.slice(start, end), raw: source.slice(index, index + length), length, display };
      }
    }
    return null;
  }
  function render(tex, display = false) {
    if (!katex || tex.length > MAX_LENGTH) return null;
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, maxExpand: 200, maxSize: 20 });
    } catch { return null; }
  }
  function html(span) {
    const body = render(span.tex, span.display);
    if (!body) return escape(span.raw);
    return span.display ? '<section><eqn>' + body + '</eqn></section>' : '<eq>' + body + '</eq>';
  }

  // Protect formulas before list/table rules, keeping code samples literal.
  // A surrounding quote marker belongs to Markdown rather than TeX.
  function protect(source, replace) {
    let output = '', offset = 0, fence = '';
    for (let index = 0; index < source.length; index++) {
      if (index === 0 || source[index - 1] === '\n') {
        const end = source.indexOf('\n', index);
        const line = source.slice(index, end === -1 ? source.length : end);
        const marker = /^\s{0,3}(?:>\s*)*(`{3,}|~{3,})/.exec(line);
        if (fence || marker || /^(?: {4}|\t)/.test(line)) {
          if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length)) fence = fence ? '' : marker[1];
          index = end === -1 ? source.length : end;
          continue;
        }
      }
      if (source[index] === '`' && !escaped(source, index)) {
        let end = index + 1;
        while (source[end] === '`') end++;
        const close = source.indexOf(source.slice(index, end), end);
        index = close === -1 ? source.length : close + end - index - 1;
        continue;
      }
      if (source[index] !== '$' && source[index] !== '\\') continue;
      const span = read(source, index);
      if (!span) continue;
      const before = source.slice(source.lastIndexOf('\n', index - 1) + 1, index);
      const quote = /^\s{0,3}((?:>\s*)+)/.exec(before);
      if (quote) {
        const depth = (quote[1].match(/>/g) || []).length;
        span.tex = span.tex.replace(new RegExp('\n(?:[ \\t]{0,3}>[ \\t]?){1,' + depth + '}', 'g'), '\n');
      }
      output += source.slice(offset, index) + replace(span);
      index += span.length - 1;
      offset = index + 1;
    }
    return output + source.slice(offset);
  }
  function install(md) {
    md.inline.ruler.before('escape', 'camellia_math', (state, silent) => {
      const span = read(state.src, state.pos);
      if (!span || state.pos + span.length > state.posMax) return false;
      if (!silent) state.push('camellia_math', '', 0).meta = span;
      state.pos += span.length;
      return true;
    });
    md.renderer.rules.camellia_math = (tokens, index) => html(tokens[index].meta);
    md.block.ruler.before('fence', 'camellia_math_block', (state, start, end, silent) => {
      if (state.sCount[start] - state.blkIndent >= 4) return false;
      const position = state.bMarks[start] + state.tShift[start];
      if (!state.src.startsWith('$$', position) && !state.src.startsWith('\\[', position) && !state.src.startsWith('\\(', position)) return false;
      const raw = read(state.src, position);
      if (!raw) return false;
      const next = start + raw.raw.split('\n').length;
      if (next > end) return false;
      const source = state.getLines(start, next, state.blkIndent, false).trimStart();
      const span = read(source);
      if (!span || !span.display && !span.raw.includes('\n')) return false;
      const tail = source.slice(span.length).split('\n')[0].trim();
      const number = /^\(([^()\r\n]+)\)$/.exec(tail);
      if (tail && !number) return false;
      if (silent) return true;
      const token = state.push('camellia_math_block', '', 0);
      token.block = true;
      token.meta = span;
      token.info = number ? number[1] : '';
      state.line = next;
      token.map = [start, state.line];
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
    md.renderer.rules.camellia_math_block = (tokens, index) => {
      const token = tokens[index];
      if (!token.info) return html(token.meta) + '\n';
      const body = render(token.meta.tex, true) || escape(token.meta.raw);
      return '<section class="eqno"><eqn>' + body + '</eqn><span>(' + escape(token.info) + ')</span></section>\n';
    };
  }
  return { read, render, html, protect, install, escaped };
});
