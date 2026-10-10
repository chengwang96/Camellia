'use strict';

(function(root) {
  function safeLink(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  function safeMail(value) {
    return /^[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+$/.test(value) ? 'mailto:' + value : null;
  }
  const imageExtension = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)(?:[?#]|$)/i;
  function fileUrl(value) {
    const encoded = value.split('/').map(encodeURIComponent).join('/');
    if (/^[a-z]:\//i.test(value)) return 'file:///' + encoded.replace(/^([a-z])%3A/i, '$1:');
    if (value.startsWith('/') && !value.startsWith('//')) return 'file://' + encoded;
    return '';
  }
  // Images match the chat page: local files and explicit http(s) URLs load, while
  // data:, javascript: and network shares stay literal text.
  function imageTarget(value) {
    if (/^https?:\/\//i.test(value)) return imageExtension.test(value) && safeLink(value) ? value : null;
    if (/^file:/i.test(value)) {
      try { const url = new URL(value); return url.host || !imageExtension.test(decodeURIComponent(url.pathname)) ? null : url.href; }
      catch { return null; }
    }
    if (/^[a-z]:[\\/]/i.test(value)) {
      const path = value.replace(/\\/g, '/');
      return imageExtension.test(path) ? fileUrl(path) : null;
    }
    if (/^\/(?!\/)/.test(value)) return imageExtension.test(value) ? fileUrl(value) : null;
    return null;
  }
  // Discussions load their math library after this module, so resolve it at render time.
  const mathEngine = () => typeof module === 'object' && module.exports
    ? require('./markdown-math') : root.CamelliaMarkdownMath;
  function mathNode(document, span, standalone = false) {
    const html = mathEngine()?.render(span.tex, span.display);
    if (!html) return document.createTextNode(span.raw);
    const holder = document.createElement(standalone ? 'div' : 'span');
    holder.className = standalone ? 'md-math-display' : span.display ? 'md-math md-math-display' : 'md-math';
    holder.innerHTML = html;
    return holder;
  }
  // A leading "=" or "<" means the URL sits in an HTML attribute or a tag that
  // is being shown as literal text, so it is left alone.
  const bareLink = /(?<![=<])(?:https?:\/\/[^\s<>()[\]]+|www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^\s<>()[\]`"']*|[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+)/g;
  // Bare URLs and e-mail addresses become links, but a hostname alone does not:
  // "README.md" and "setup.sh" are file names, not domains.
  function appendText(document, parent, source) {
    let offset = 0, match;
    bareLink.lastIndex = 0;
    while ((match = bareLink.exec(source))) {
      const value = match[0].replace(/[.,;:!?]+$/, '');
      const href = /^https?:\/\//i.test(value) ? safeLink(value)
        : /^www\./i.test(value) ? safeLink('http://' + value) : safeMail(value);
      if (!href) continue;
      if (match.index > offset) parent.append(document.createTextNode(source.slice(offset, match.index)));
      const node = document.createElement('a');
      node.textContent = value; node.href = href; node.rel = 'noopener noreferrer'; node.dataset.remoteLink = href;
      parent.append(node);
      offset = match.index + value.length;
    }
    if (offset < source.length) parent.append(document.createTextNode(source.slice(offset)));
  }
  function cells(line) {
    let text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    return text.split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'));
  }
  function listMatch(line) {
    return /^(\s*)(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
  }
  // Four spaces or a tab start an indented code block, matching the chat page.
  function indentWidth(line) {
    if (!line.trim()) return null;
    return /^ {4}/.test(line) ? 4 : /^\t/.test(line) ? 1 : null;
  }
  // A line with no marker of its own continues the item above it, so bilingual
  // text such as a translation stays attached to its title. A blank line or a
  // line that opens another block ends the list instead.
  function listContinuation(line) {
    if (!line.trim()) return false;
    if (/^\s{0,3}>/.test(line)) return false;
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return false;
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return false;
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) return false;
    if (/^\s*\$\$/.test(line)) return false;
    return true;
  }
  // Button icons stay identical to the chat page so both surfaces read the same.
  function wrapIcon(on) {
    const path = on ? 'M12 3v5m0 8v5M3 12h18m-4-4 4 4-4 4' : 'M21 3v18M3 7h8a4 4 0 0 1 0 8H3m4-4-4 4 4 4';
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' + path + '"/></svg>';
  }
  function copyIcon(copied) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (copied ? '<path d="m5 12 4 4L19 6"/>' : '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>') + '</svg>';
  }
  // Fenced and indented code share one panel so both keep copy and word wrap.
  function codePanel(document, language, value, labels) {
    const panel = document.createElement('div'); panel.className = 'md-code-block';
    const header = document.createElement('div'); header.className = 'md-code-header';
    const name = document.createElement('span'); name.textContent = language;
    const actions = document.createElement('div'); actions.className = 'actions';
    const pre = document.createElement('pre'); pre.className = 'md-code';
    const content = document.createElement('code'); content.textContent = value; pre.append(content);
    const copyButton = document.createElement('button'); copyButton.type = 'button'; copyButton.className = 'md-code-copy';
    copyButton.innerHTML = copyIcon(false);
    copyButton.setAttribute('aria-label', labels.copyLabel); copyButton.title = labels.copyLabel;
    copyButton.onclick = async () => {
      let copied = true;
      try { await labels.copy(content.textContent); } catch { copied = false; }
      copyButton.innerHTML = copyIcon(copied);
      copyButton.title = copied ? labels.copiedLabel : labels.failedLabel;
      setTimeout(() => { copyButton.innerHTML = copyIcon(false); copyButton.title = labels.copyLabel; }, 2000);
    };
    const wrap = document.createElement('button'); wrap.type = 'button'; wrap.className = 'md-code-wrap';
    wrap.innerHTML = wrapIcon(false); wrap.setAttribute('aria-pressed', 'false');
    wrap.setAttribute('aria-label', labels.wrapLabel); wrap.title = labels.wrapLabel;
    wrap.onclick = () => {
      const wrapped = !pre.classList.contains('is-wrapped');
      pre.classList.toggle('is-wrapped', wrapped);
      wrap.setAttribute('aria-pressed', String(wrapped));
      wrap.innerHTML = wrapIcon(wrapped);
    };
    actions.append(wrap, copyButton); header.append(name, actions); panel.append(header, pre);
    return panel;
  }
  // One list block, keeping nested indentation and GitHub task checkboxes.
  function readList(document, lines, start, allowImages = true, mathTokens = []) {
    const base = listMatch(lines[start]);
    const baseIndent = base[1].length, ordered = Boolean(base[3]);
    const node = document.createElement(ordered ? 'ol' : 'ul');
    if (ordered) node.start = Number(base[3]);
    let index = start;
    while (index < lines.length) {
      const entry = listMatch(lines[index]);
      if (!entry) {
        if (node.lastChild && listContinuation(lines[index])) {
          node.lastChild.append(document.createTextNode('\n'));
          inline(document, node.lastChild, lines[index].trim(), 0, allowImages, mathTokens);
          index++;
          continue;
        }
        break;
      }
      const indent = entry[1].length;
      if (indent < baseIndent || (indent === baseIndent && Boolean(entry[3]) !== ordered)) break;
      if (indent > baseIndent && node.lastChild) {
        const nested = readList(document, lines, index, allowImages, mathTokens);
        node.lastChild.append(nested.node); index = nested.index; continue;
      }
      const item = document.createElement('li');
      const task = /^\[([ xX])\]\s+(.*)$/.exec(entry[4]);
      if (task) {
        const box = document.createElement('input');
        box.type = 'checkbox'; box.disabled = true; box.checked = task[1].toLowerCase() === 'x';
        box.setAttribute('aria-label', box.checked ? 'Completed' : 'Not completed');
        item.className = 'md-task'; item.append(box, document.createTextNode(' '));
        inline(document, item, task[2], 0, allowImages, mathTokens);
      } else inline(document, item, entry[4], 0, allowImages, mathTokens);
      node.append(item); index++;
    }
    return { index, node };
  }
  function inline(document, parent, source, depth = 0, allowImages = true, mathTokens = []) {
    if (depth > 8) { parent.append(document.createTextNode(source)); return; }
    // Text-only surfaces keep image syntax literal, including nested blocks,
    // without creating an image element or initiating a resource request.
    const pattern = /(\x01\d+\x01|!\[[^\]\n]*\]\([^\s)]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*)/g;
    let offset = 0, match;
    while ((match = pattern.exec(source))) {
      appendText(document, parent, source.slice(offset, match.index));
      const text = match[0]; let node;
      if (text.startsWith('\x01') && mathTokens[Number(text.slice(1, -1))]) {
        node = mathNode(document, mathTokens[Number(text.slice(1, -1))]);
      } else if (text.startsWith('![')) {
        const image = /^!\[([^\]\n]*)\]\(([^\s)]+)\)$/.exec(text);
        const href = image && allowImages ? imageTarget(image[2]) : null;
        if (href) {
          node = document.createElement('img');
          node.className = 'chat-inline-image'; node.src = href;
          node.alt = image[1] || 'Image'; node.title = href;
          node.loading = 'lazy'; node.decoding = 'async'; node.referrerPolicy = 'no-referrer';
        } else node = document.createTextNode(text);
      }
      else if (text.startsWith('`')) { node = document.createElement('code'); node.textContent = text.slice(1, -1); }
      else if (text.startsWith('[')) {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text), href = safeLink(link[2]);
        node = document.createElement(href ? 'a' : 'span'); node.textContent = link[1];
        if (href) { node.href = href; node.rel = 'noopener noreferrer'; node.dataset.remoteLink = href; }
      } else {
        const double = text.startsWith('**') || text.startsWith('~~');
        node = document.createElement(text.startsWith('**') ? 'strong' : text.startsWith('~~') ? 'del' : 'em');
        inline(document, node, text.slice(double ? 2 : 1, double ? -2 : -1), depth + 1, allowImages, mathTokens);
      }
      parent.append(node); offset = pattern.lastIndex;
    }
    appendText(document, parent, source.slice(offset));
  }
  function render(document, value, { allowImages = true, copyLabel = 'Copy code', wrapLabel = 'Word wrap', copiedLabel = 'Copied', failedLabel = 'Copy failed', copy = async text => root.navigator.clipboard.writeText(text) } = {}) {
    const fragment = document.createDocumentFragment();
    const mathTokens = [], source = String(value || '').replace(/\r\n?/g, '\n');
    const protectedSource = mathEngine()?.protect(source, span => {
      mathTokens.push(span);
      return '\x01' + (mathTokens.length - 1) + '\x01';
    }) ?? source;
    const lines = protectedSource.split('\n');
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      const formula = /^\s*\x01(\d+)\x01\s*$/.exec(line);
      if (formula && mathTokens[+formula[1]]?.display) {
        fragment.append(mathNode(document, mathTokens[+formula[1]], true)); index++; continue;
      }
      const fence = /^\s{0,3}(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
      if (fence) {
        index++; const code = [];
        const end = new RegExp('^\\s{0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
        while (index < lines.length && !end.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index++;
        fragment.append(codePanel(document, fence[2], code.join('\n'), { copyLabel, wrapLabel, copiedLabel, failedLabel, copy }));
        continue;
      }
      const delimiter = index + 1 < lines.length && lines[index + 1].includes('|') ? cells(lines[index + 1]) : [];
      const heading = line.includes('|') ? cells(line) : [];
      if (delimiter.length && heading.length === delimiter.length && delimiter.every(cell => /^:?-{3,}:?$/.test(cell))) {
        const wrapper = document.createElement('div'); wrapper.className = 'md-table-wrap';
        const table = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
        const appendRow = (values, parent, tag) => {
          const row = document.createElement('tr');
          heading.forEach((_value, position) => {
            const cell = document.createElement(tag); const align = delimiter[position];
            cell.className = align.startsWith(':') && align.endsWith(':') ? 'md-align-center' : align.endsWith(':') ? 'md-align-right' : 'md-align-left';
            inline(document, cell, values[position] || '', 0, allowImages, mathTokens); row.append(cell);
          }); parent.append(row);
        };
        appendRow(heading, head, 'th'); index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) appendRow(cells(lines[index++]), body, 'td');
        table.append(head, body); wrapper.append(table); fragment.append(wrapper); continue;
      }
      const title = /^(#{1,6})\s+(.+)$/.exec(line);
      if (title) { const node = document.createElement(`h${title[1].length}`); inline(document, node, title[2], 0, allowImages, mathTokens); fragment.append(node); index++; continue; }
      if (indentWidth(line)) {
        const code = [];
        let blank = false;
        while (index < lines.length) {
          const width = indentWidth(lines[index]);
          if (width) { code.push(lines[index].slice(width)); blank = false; index++; continue; }
          if (!blank && !lines[index].trim() && indentWidth(lines[index + 1] || '')) { code.push(''); blank = true; index++; continue; }
          break;
        }
        fragment.append(codePanel(document, '', code.join('\n'), { copyLabel, wrapLabel, copiedLabel, failedLabel, copy }));
        continue;
      }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { fragment.append(document.createElement('hr')); index++; continue; }
      if (listMatch(line)) {
        const list = readList(document, lines, index, allowImages, mathTokens);
        fragment.append(list.node); index = list.index; continue;
      }
      if (/^>\s?/.test(line)) {
        const node = document.createElement('blockquote'), text = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) text.push(lines[index++].replace(/^>\s?/, ''));
        inline(document, node, text.join('\n'), 0, allowImages, mathTokens); fragment.append(node); continue;
      }
      const paragraph = document.createElement('p'); inline(document, paragraph, line, 0, allowImages, mathTokens); fragment.append(paragraph); index++;
    }
    return fragment;
  }
  const api = { render, safeLink, cells };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamelliaMarkdown = api;
})(typeof window === 'undefined' ? globalThis : window);
