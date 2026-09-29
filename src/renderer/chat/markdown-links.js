'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('markdown-it'));
  else root.CamelliaMarkdownLinks = factory(root.markdownit);
})(typeof window === 'object' ? window : globalThis, function (MarkdownIt) {
  // Keep the chat's existing block layout, but use the Markdown parser for
  // inline links (including titles, escaped characters and balanced brackets).
  const parser = new MarkdownIt('zero').enable(['link', 'image', 'escape', 'entity', 'emphasis', 'newline']);
  const escape = parser.utils.escapeHtml;
  const controls = /[\x00-\x1f\x7f]/;

  function fileUrl(path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    if (/^[a-z]:\//i.test(path)) return 'file:///' + encoded.replace(/^([a-z])%3A/i, '$1:');
    if (path.startsWith('/') && !path.startsWith('//')) return 'file://' + encoded;
    return '';
  }

  function destination(value, cwd = '') {
    try {
      if (!value || controls.test(value)) return null;
      if (/^https?:/i.test(value)) {
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
    } else {
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
  // Local preview images are safe to load as image resources. Never fetch
  // arbitrary remote URLs automatically just because they occur in a reply.
  parser.renderer.rules.image = (tokens, index, options, environment) => {
    const token = tokens[index], target = destination(token.attrGet('src'), environment.cwd);
    const label = token.content || target?.path?.split('/').pop() || 'Image';
    if (!target?.path || !/\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(target.path))
      return escape('![' + token.content + '](' + token.attrGet('src') + ')');
    return '<img class="chat-inline-image" src="' + escape(target.href) + '" alt="' + escape(label)
      + '" title="' + escape(target.path) + '" data-chat-file="' + escape(target.path)
      + '" loading="lazy" decoding="async" tabindex="0" role="button">';
  };

  return { destination, renderInline: (source, cwd = '') => parser.renderInline(source, { cwd }) };
});
