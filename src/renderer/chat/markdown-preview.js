'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('markdown-it'), require('markdown-it-footnote'), require('markdown-it-texmath'), require('katex'), require('@highlightjs/cdn-assets/highlight.min.js'));
  else root.CamelliaMarkdownPreview = factory(root.markdownit, root.markdownitFootnote, root.texmath, root.katex, root.hljs);
})(typeof window === 'object' ? window : globalThis, function (MarkdownIt, footnote, texmath, katex, highlighter) {
  const parser = new MarkdownIt({ html: false, linkify: true, breaks: false });
  parser.use(footnote);
  parser.use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { trust: false, strict: 'ignore', maxExpand: 200, maxSize: 20 } });
  const escape = parser.utils.escapeHtml;
  const defaultImage = parser.renderer.rules.image;
  parser.renderer.rules.footnote_anchor_name = (tokens, index) => 'preview-note-' + (tokens[index].meta.id + 1);

  function highlight(language, code) {
    const name = language.split(/\s+/)[0].toLowerCase();
    if (code.length <= 50000 && highlighter.getLanguage(name)) {
      try { return highlighter.highlight(code, { language: name, ignoreIllegals: true }).value; } catch {}
    }
    return escape(code);
  }

  function destination(value, baseUrl, image = false) {
    try {
      if (value.startsWith('#') && !image) return value;
      const relative = !/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[\\/]{2}/.test(value);
      const url = new URL(value, baseUrl || undefined);
      if (['http:', 'https:'].includes(url.protocol)) return url.href;
      if (url.protocol === 'file:' && relative && !url.host && baseUrl?.startsWith('file:')) return url.href;
    } catch {}
    return '';
  }

  parser.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const href = destination(token.attrGet('href') || '', environment.baseUrl);
    token.attrSet('href', href || '#');
    if (!href) token.attrSet('data-preview-blocked', 'true');
    else if (/^https?:/.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.image = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const source = destination(token.attrGet('src') || '', environment.baseUrl, true);
    if (!source) return escape(token.content);
    token.attrSet('src', source);
    token.attrSet('loading', 'lazy');
    token.attrSet('referrerpolicy', 'no-referrer');
    return defaultImage(tokens, index, options, environment, renderer);
  };
  parser.renderer.rules.heading_open = (tokens, index, options, environment, renderer) => {
    const inline = tokens[index + 1];
    const title = (inline.children || []).filter(token => ['text', 'code_inline'].includes(token.type)).map(token => token.content).join('');
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s/g, '-') || 'section';
    let anchor = slug, suffix = 0;
    while (environment.anchors.has(anchor)) anchor = `${slug}-${++suffix}`;
    environment.anchors.add(anchor);
    tokens[index].attrSet('id', 'preview-' + anchor);
    tokens[index].attrSet('data-preview-anchor', anchor);
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.code_inline = (tokens, index) => '<code class="md-inline">' + escape(tokens[index].content) + '</code>';
  parser.renderer.rules.fence = (tokens, index, options, environment) => environment.codeBlock(tokens[index].info.trim(), tokens[index].content);
  parser.renderer.rules.code_block = (tokens, index, options, environment) => environment.codeBlock('', tokens[index].content);
  parser.renderer.rules.table_open = () => '<div class="md-table-wrap"><table class="md-table">';
  parser.renderer.rules.table_close = () => '</table></div>';
  parser.core.ruler.after('block', 'preview_source_lines', state => {
    if (!state.env.sourceLines) return;
    for (const token of state.tokens) {
      if (!token.map || token.nesting !== 1) continue;
      token.attrSet('data-preview-line', String(token.map[0] + 1));
      token.attrSet('data-preview-end-line', String(token.map[1]));
    }
  });
  parser.core.ruler.after('inline', 'preview_task_lists', state => {
    for (let index = 2; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type !== 'inline' || state.tokens[index - 1].type !== 'paragraph_open' || state.tokens[index - 2].type !== 'list_item_open') continue;
      const first = token.children?.[0];
      const match = first?.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content);
      if (!match) continue;
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input type="checkbox" disabled${match[1].toLowerCase() === 'x' ? ' checked' : ''} aria-label="${match[1].toLowerCase() === 'x' ? 'Completed' : 'Not completed'}"> `;
      token.children.unshift(checkbox);
      state.tokens[index - 2].attrJoin('class', 'preview-task');
    }
  });

  function render(source, { baseUrl = '', codeBlock, sourceLines = false } = {}) {
    return parser.render(String(source), {
      baseUrl, sourceLines, anchors: new Set(),
      codeBlock: codeBlock || ((language, code) => '<pre><code>' + highlight(language, code) + '</code></pre>'),
    });
  }
  return { render, highlight };
});
