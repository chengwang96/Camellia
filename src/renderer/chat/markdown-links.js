'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('markdown-it'), require('markdown-it-texmath'), require('katex'));
  else root.CamelliaMarkdownLinks = factory(root.markdownit, root.texmath, root.katex);
})(typeof window === 'object' ? window : globalThis, function (MarkdownIt, texmath, katex) {
  // Keep the chat's existing block layout, but use the Markdown parser for
  // inline links (including titles, escaped characters and balanced brackets)
  // and for inline/display math, which shares the file preview's renderer.
  const parser = new MarkdownIt('zero', { linkify: true })
    .enable(['link', 'image', 'escape', 'entity', 'emphasis', 'newline', 'strikethrough', 'linkify', 'autolink']);
  // Bare hostnames are left alone: fuzzyLink would turn file names like
  // "README.md" or "setup.sh" into fake domains. Explicit schemes are handled
  // by `autolink`/`linkify`, e-mail by `fuzzyEmail`, and "www." by the rule below.
  parser.linkify.set({ fuzzyLink: false, fuzzyEmail: true, fuzzyIP: false });
  parser.use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { trust: false, strict: 'ignore', maxExpand: 200, maxSize: 20 } });
  const escape = parser.utils.escapeHtml;
  const controls = /[\x00-\x1f\x7f]/;

  const wwwPattern = /www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^\s<>()[\]`"']*/g;

  // "www.example.com" is unambiguous, but linkify-it only finds it through the
  // fuzzy-host rule this parser deliberately disables, so link it here.
  function linkifyWww(state) {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      const output = [];
      let linkDepth = 0, changed = false;
      for (const token of block.children) {
        if (token.type === 'link_open') { linkDepth++; output.push(token); continue; }
        if (token.type === 'link_close') { linkDepth--; output.push(token); continue; }
        if (linkDepth > 0 || token.type !== 'text' || !token.content.includes('www.')) { output.push(token); continue; }
        const source = token.content;
        const parts = [];
        let last = 0, match;
        wwwPattern.lastIndex = 0;
        while ((match = wwwPattern.exec(source))) {
          const label = match[0].replace(/[.,;:!?]+$/, '');
          const href = state.md.normalizeLink('http://' + label);
          if (!/^https?:\/\//.test(href) || !state.md.validateLink(href)) continue;
          if (match.index > last) {
            const lead = new state.Token('text', '', 0);
            lead.content = source.slice(last, match.index);
            parts.push(lead);
          }
          const open = new state.Token('link_open', 'a', 1);
          open.attrs = [['href', href]];
          open.markup = 'linkify';
          open.info = 'auto';
          const text = new state.Token('text', '', 0);
          text.content = label;
          const close = new state.Token('link_close', 'a', -1);
          close.markup = 'linkify';
          close.info = 'auto';
          parts.push(open, text, close);
          last = match.index + label.length;
        }
        if (!parts.length) { output.push(token); continue; }
        if (last < source.length) {
          const tail = new state.Token('text', '', 0);
          tail.content = source.slice(last);
          parts.push(tail);
        }
        changed = true;
        output.push(...parts);
      }
      if (changed) block.children = output;
    }
  }
  parser.core.ruler.after('linkify', 'linkify_www', linkifyWww);

  function fileUrl(path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    if (/^[a-z]:\//i.test(path)) return 'file:///' + encoded.replace(/^([a-z])%3A/i, '$1:');
    if (path.startsWith('/') && !path.startsWith('//')) return 'file://' + encoded;
    return '';
  }

  function destination(value, cwd = '') {
    try {
      if (!value || controls.test(value)) return null;
      if (/^mailto:/i.test(value)) {
        if (!/^mailto:[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i.test(value)) return null;
        return { href: new URL(value).href, mailto: true };
      }
      // Require the slashes so a Windows path such as "C:/x.md" is not read as
      // a URL scheme; anything else scheme-qualified is not a local file either.
      if (/^https?:\/\//i.test(value)) {
        const url = new URL(value);
        return url.username || url.password ? null : { href: url.href };
      }
      let path = value, line = 0, anchor = '';
      const hash = path.indexOf('#');
      if (hash !== -1) { anchor = decodeURIComponent(path.slice(hash + 1)); path = path.slice(0, hash); }
      const location = /^(?:L)(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/.exec(anchor)
        || /:(\d+)(?::\d+)?$/.exec(path);
      if (location) {
        line = Number(location[1]);
        if (anchor) anchor = ''; else path = path.slice(0, -location[0].length);
        if (!Number.isSafeInteger(line) || line < 1) return null;
      }
      if (/^file:/i.test(path)) {
        const url = new URL(path);
        if (url.host || url.search) return null;
        path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
      } else path = decodeURIComponent(path);
      path = path.replace(/\\/g, '/');
      if (!path || controls.test(path) || controls.test(anchor) || path.startsWith('//')) return null;
      const absolute = fileUrl(path);
      if (!absolute && /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
      const base = cwd ? fileUrl(String(cwd).replace(/\\/g, '/').replace(/\/?$/, '/')) : '';
      if (!absolute && !base) return null;
      const url = new URL(absolute || path.split('/').map(encodeURIComponent).join('/'), base || undefined);
      path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
      if (path.startsWith('//')) return null;
      url.hash = line ? 'L' + line : anchor;
      return { href: url.href, path, line, anchor };
    } catch { return null; }
  }

  // Validation is repeated with the actual conversation directory at render
  // time. A synthetic base here only lets relative file links be tokenized.
  parser.validateLink = value => Boolean(destination(value, '/'));
  parser.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    const token = tokens[index], target = destination(token.attrGet('href'), environment.cwd);
    if (!target) return '<span>';
    token.attrSet('href', target.href);
    if (target.path) {
      token.attrSet('data-chat-file', target.path);
      if (target.line) token.attrSet('data-chat-line', String(target.line));
      if (target.anchor) token.attrSet('data-chat-anchor', target.anchor);
    } else if (!target.mailto) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    if (!token.attrGet('title') || controls.test(token.attrGet('title'))) token.attrSet('title', target.path ? target.path + (target.line ? ':' + target.line : '') : target.href);
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.link_close = (tokens, index, options, environment) => {
    let open = index - 1;
    while (open >= 0 && tokens[open].type !== 'link_open') open--;
    return destination(tokens[open]?.attrGet('href'), environment.cwd) ? '</a>' : '</span>';
  };
  // Local files and explicit http(s) URLs render inline, matching the file
  // preview. The browser only issues the request because the author wrote an
  // image, so remote hosts are reachable without being auto-fetched from prose.
  parser.renderer.rules.image = (tokens, index, options, environment) => {
    const token = tokens[index], target = destination(token.attrGet('src'), environment.cwd);
    const label = token.content || target?.path?.split('/').pop() || 'Image';
    if (!target) return escape('![' + token.content + '](' + token.attrGet('src') + ')');
    if (target.path) {
      if (!/\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(target.path))
        return escape('![' + token.content + '](' + token.attrGet('src') + ')');
      return '<img class="chat-inline-image" src="' + escape(target.href) + '" alt="' + escape(label)
        + '" title="' + escape(target.path) + '" data-chat-file="' + escape(target.path)
        + '" loading="lazy" decoding="async" referrerpolicy="no-referrer" tabindex="0" role="button">';
    }
    if (!/^https?:/i.test(target.href) || !/\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)(?:[?#]|$)/i.test(target.href))
      return escape('![' + token.content + '](' + token.attrGet('src') + ')');
    return '<img class="chat-inline-image" src="' + escape(target.href) + '" alt="' + escape(label)
      + '" title="' + escape(target.href) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
  };

  return { destination, renderInline: (source, cwd = '') => parser.renderInline(source, { cwd }) };
});
