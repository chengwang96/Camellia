'use strict';

(function(root) {
  function safeLink(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  function cells(line) {
    let text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    return text.split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'));
  }
  function inline(document, parent, source, depth = 0) {
    if (depth > 8) { parent.append(document.createTextNode(source)); return; }
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|(?<!!)\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*)/g;
    let offset = 0, match;
    while ((match = pattern.exec(source))) {
      parent.append(document.createTextNode(source.slice(offset, match.index)));
      const text = match[0]; let node;
      if (text.startsWith('`')) { node = document.createElement('code'); node.textContent = text.slice(1, -1); }
      else if (text.startsWith('[')) {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text), href = safeLink(link[2]);
        node = document.createElement(href ? 'a' : 'span'); node.textContent = link[1];
        if (href) { node.href = href; node.rel = 'noopener noreferrer'; node.dataset.remoteLink = href; }
      } else {
        const double = text.startsWith('**') || text.startsWith('~~');
        node = document.createElement(text.startsWith('**') ? 'strong' : text.startsWith('~~') ? 'del' : 'em');
        inline(document, node, text.slice(double ? 2 : 1, double ? -2 : -1), depth + 1);
      }
      parent.append(node); offset = pattern.lastIndex;
    }
    parent.append(document.createTextNode(source.slice(offset)));
  }
  function render(document, value, { copyLabel = 'Copy code', wrapLabel = 'Word wrap', copiedLabel = 'Copied', failedLabel = 'Copy failed', copy = async text => root.navigator.clipboard.writeText(text) } = {}) {
    const fragment = document.createDocumentFragment();
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      const fence = /^\s{0,3}(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
      if (fence) {
        index++; const code = [];
        const end = new RegExp('^\\s{0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
        while (index < lines.length && !end.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index++;
        const panel = document.createElement('div'); panel.className = 'md-code-block';
        const header = document.createElement('div'); header.className = 'md-code-header';
        const language = document.createElement('span'); language.textContent = fence[2];
        const actions = document.createElement('div'); actions.className = 'actions';
        const pre = document.createElement('pre'); pre.className = 'md-code';
        const content = document.createElement('code'); content.textContent = code.join('\n'); pre.append(content);
        const copyButton = document.createElement('button'); copyButton.type = 'button'; copyButton.textContent = copyLabel; copyButton.className = 'md-code-copy';
        copyButton.onclick = async () => { try { await copy(content.textContent); copyButton.textContent = copiedLabel; } catch { copyButton.textContent = failedLabel; } };
        const wrap = document.createElement('button'); wrap.type = 'button'; wrap.textContent = wrapLabel; wrap.className = 'md-code-wrap'; wrap.setAttribute('aria-pressed', 'false');
        wrap.onclick = () => { pre.classList.toggle('is-wrapped'); wrap.setAttribute('aria-pressed', String(pre.classList.contains('is-wrapped'))); };
        actions.append(wrap, copyButton); header.append(language, actions); panel.append(header, pre); fragment.append(panel); continue;
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
            inline(document, cell, values[position] || ''); row.append(cell);
          }); parent.append(row);
        };
        appendRow(heading, head, 'th'); index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) appendRow(cells(lines[index++]), body, 'td');
        table.append(head, body); wrapper.append(table); fragment.append(wrapper); continue;
      }
      const title = /^(#{1,6})\s+(.+)$/.exec(line);
      if (title) { const node = document.createElement(`h${title[1].length}`); inline(document, node, title[2]); fragment.append(node); index++; continue; }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { fragment.append(document.createElement('hr')); index++; continue; }
      const list = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
      if (list) {
        const node = document.createElement(list[2] ? 'ol' : 'ul');
        if (list[2]) node.start = Number(list[2]);
        while (index < lines.length) {
          const entry = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index]);
          if (!entry || Boolean(entry[2]) !== Boolean(list[2])) break;
          const item = document.createElement('li'); inline(document, item, entry[3]); node.append(item); index++;
        }
        fragment.append(node); continue;
      }
      if (/^>\s?/.test(line)) {
        const node = document.createElement('blockquote'), text = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) text.push(lines[index++].replace(/^>\s?/, ''));
        inline(document, node, text.join('\n')); fragment.append(node); continue;
      }
      const paragraph = document.createElement('p'); inline(document, paragraph, line); fragment.append(paragraph); index++;
    }
    return fragment;
  }
  const api = { render, safeLink, cells };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamelliaMarkdown = api;
})(typeof window === 'undefined' ? globalThis : window);
