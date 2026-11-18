'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('markdown-it'), require('markdown-it-footnote'), require('../shared/markdown-math'), require('@highlightjs/cdn-assets/highlight.min.js'));
  else root.CamelliaMarkdownPreview = factory(root.markdownit, root.markdownitFootnote, root.CamelliaMarkdownMath, root.hljs);
})(typeof window === 'object' ? window : globalThis, function (MarkdownIt, footnote, math, highlighter) {
  const parser = new MarkdownIt({ html: false, linkify: true, breaks: false });
  parser.use(footnote);
  parser.use(math.install);
  const normalizeLink = parser.normalizeLink.bind(parser);
  parser.normalizeLink = value => /^[a-z]:\\/i.test(value)
    ? value.replace(/\\/g, '/')
    : normalizeLink(value);
  const escape = parser.utils.escapeHtml;
  const defaultImage = parser.renderer.rules.image;
  parser.renderer.rules.footnote_anchor_name = (tokens, index) => 'preview-note-' + (tokens[index].meta.id + 1);
  const videoExtension = /\.(?:mp4|m4v|mov|webm|ogv)(?:[?#]|$)/i;

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
      if (/^[a-z]:[\\/]/i.test(value)) {
        const hash = value.indexOf('#');
        const source = hash < 0 ? value : value.slice(0, hash);
        const anchor = hash < 0 ? '' : value.slice(hash);
        const path = source.replace(/\\/g, '/').split('/')
          .map((part, index) => index === 0 ? part : encodeURIComponent(part)).join('/');
        return 'file:///' + path.replace(/^([a-z])%3A/i, '$1:') + anchor;
      }
      if (image && /^file:/i.test(value)) {
        const url = new URL(value);
        return url.protocol === 'file:' && !url.host ? url.href : '';
      }
      if (/^file:/i.test(value)) {
        const url = new URL(value);
        if (url.protocol === 'file:' && !url.host && baseUrl?.startsWith('file:')) return url.href;
        return '';
      }
      const relative = !/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[\\/]{2}/.test(value);
      const url = new URL(value, baseUrl || undefined);
      if (['http:', 'https:', 'mailto:'].includes(url.protocol)) return url.href;
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
    if (videoExtension.test(source)) {
      return '<video class="file-preview-video" src="' + escape(source) + '" controls preload="metadata" playsinline'
        + ' aria-label="' + escape(token.content || 'Video') + '" data-preview-video="true"></video>';
    }
    token.attrSet('src', source);
    token.attrSet('loading', 'lazy');
    token.attrSet('referrerpolicy', 'no-referrer');
    return defaultImage(tokens, index, options, environment, renderer);
  };
  parser.renderer.rules.code_inline = (tokens, index) => '<code class="md-inline">' + escape(tokens[index].content) + '</code>';
  const sourceBlock = (token, body, environment) => {
    const lines = environment.sourceLines && token.map
      ? ' data-preview-line="' + (token.map[0] + 1) + '" data-preview-end-line="' + token.map[1] + '"'
      : '';
    return '<div class="preview-source-block"' + lines + '>' + body + '</div>';
  };
  parser.renderer.rules.fence = (tokens, index, options, environment) =>
    sourceBlock(tokens[index], environment.codeBlock(tokens[index].info.trim(), tokens[index].content), environment);
  parser.renderer.rules.code_block = (tokens, index, options, environment) =>
    sourceBlock(tokens[index], environment.codeBlock('', tokens[index].content), environment);
  parser.renderer.rules.table_open = () => '<div class="md-table-wrap"><table class="md-table">';
  parser.renderer.rules.table_close = () => '</table></div>';
  parser.core.ruler.after('block', 'preview_source_lines', state => {
    if (!state.env.sourceLines) return;
    for (const token of state.tokens) {
      if (!token.map) continue;
      token.attrSet('data-preview-line', String(token.map[0] + 1));
      token.attrSet('data-preview-end-line', String(token.map[1]));
    }
  });
  parser.core.ruler.after('inline', 'preview_anchors', state => {
    const counts = state.env.anchorCounts || (state.env.anchorCounts = new Map());
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type !== 'heading_open') continue;
      const inline = state.tokens[index + 1];
      const title = (inline?.children || []).filter(child => ['text', 'code_inline'].includes(child.type))
        .map(child => child.content).join('');
      const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s/g, '-') || 'section';
      const suffix = counts.get(slug) || 0;
      counts.set(slug, suffix + 1);
      const anchor = suffix ? `${slug}-${suffix}` : slug;
      token.attrSet('id', 'preview-' + anchor);
      token.attrSet('data-preview-anchor', anchor);
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

  const linkifyMatch = parser.linkify.match.bind(parser.linkify);
  const fileLikeHost = /\.(?:md|markdown|txt|rst|adoc|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|sass|less|js|cjs|mjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|php|sh|bash|zsh|fish|ps1|bat|cmd|sql|tex|lua|dart|ex|exs|erl|hrl|r|m|mm|pl|pm|nim|zig|asm|s|lock|pdf|docx?|pptx?|xlsx?|odt|ods|odp|zip|tar|gz|tgz|bz2|xz|7z|rar|png|jpe?g|gif|webp|bmp|svg|ico|avif|tiff?|psd|ai|mp4|m4v|mov|webm|ogv|avi|mkv|mp3|wav|ogg|m4a|flac|aac|opus|apk|aab|ipa|exe|msi|dmg|pkg|deb|rpm|appimage)(?:[?#].*)?$/i;
  parser.linkify.match = value => {
    const links = linkifyMatch(value);
    if (!links) return links;
    return links.filter(link => {
      if (/^(?:https?:\/\/|www\.)/i.test(link.text) || /^mailto:/i.test(link.text)) return true;
      if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(link.text)) return true;
      return !fileLikeHost.test(link.text);
    });
  };
  parser.validateLink = value => {
    if (/^(?:#|https?:|mailto:)/i.test(value)) return true;
    if (/^file:/i.test(value)) return Boolean(destination(value, 'file:///'));
    if (/^[a-z]:[\\/]/i.test(value)) return Boolean(destination(value, 'file:///'));
    return !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
  };

  function render(source, { baseUrl = '', codeBlock, sourceLines = false } = {}) {
    return parser.render(String(source), {
      baseUrl, sourceLines,
      codeBlock: codeBlock || ((language, code) => '<pre><code>' + highlight(language, code) + '</code></pre>'),
    });
  }
  function renderOptions({ baseUrl = '', codeBlock, sourceLines = false } = {}) {
    return {
      baseUrl, sourceLines,
      codeBlock: codeBlock || ((language, code) => '<pre><code>' + highlight(language, code) + '</code></pre>'),
    };
  }
  async function renderChunked(source, {
    baseUrl = '', codeBlock, sourceLines = false, signal, onChunk, yieldControl, blockBudget = 48 * 1024,
  } = {}) {
    const environment = renderOptions({ baseUrl, codeBlock, sourceLines });
    const tokens = parser.parse(String(source), environment);
    const groups = [];
    for (let index = 0; index < tokens.length;) {
      const token = tokens[index];
      const start = index;
      if (token.nesting === 1) {
        let depth = 0;
        do {
          if (tokens[index].nesting === 1) depth++;
          else if (tokens[index].nesting === -1) depth--;
          index++;
        } while (index < tokens.length && depth > 0);
      } else {
        index++;
      }
      groups.push(tokens.slice(start, index));
    }
    const yieldNow = yieldControl || (() => new Promise(resolve => setTimeout(resolve, 0)));
    const chunks = [];
    let html = '';
    for (const group of groups) {
      if (signal?.aborted) throw new DOMException('Preview rendering was cancelled.', 'AbortError');
      html += parser.renderer.render(group, parser.options, environment);
      // Yield once the pending HTML reaches this budget. An indivisible group,
      // such as one very long paragraph, is flushed by itself so the renderer
      // gets a turn instead of waiting for the entire document.
      if (html.length >= blockBudget) {
        chunks.push(html);
        onChunk?.(html, chunks.length);
        html = '';
        await yieldNow();
      }
    }
    if (html) {
      chunks.push(html);
      onChunk?.(html, chunks.length);
    }
    if (signal?.aborted) throw new DOMException('Preview rendering was cancelled.', 'AbortError');
    return chunks.join('');
  }
  return { render, renderChunked, highlight, renderOptions };
});
