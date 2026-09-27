'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('papaparse'));
  else root.CamelliaDataPreview = factory(root.Papa);
})(typeof window === 'object' ? window : globalThis, function (Papa) {
  const PAGE_SIZE = 100;
  const MAX_ROWS = 20000;
  const MAX_COLUMNS = 200;
  const MAX_SEARCH_NODES = 20000;
  const extension = file => String(file.extension || file.name?.split('.').pop() || '').replace(/^\./, '').toLowerCase();
  const supports = file => ['csv', 'tsv', 'json'].includes(extension(file));

  function parseTable(text, delimiter) {
    const result = Papa.parse(text, { delimiter, skipEmptyLines: 'greedy', preview: MAX_ROWS + 1 });
    const rows = result.data.slice(0, MAX_ROWS);
    const truncated = result.data.length > MAX_ROWS || result.meta.truncated || rows.some(row => row.length > MAX_COLUMNS);
    return { rows: rows.map(row => row.slice(0, MAX_COLUMNS)), truncated, errors: result.errors };
  }
  function searchJson(value, query) {
    const matches = [], pending = [{ value, path: '$', depth: 0 }];
    let visited = 0, skipped = false;
    while (pending.length && visited < MAX_SEARCH_NODES && matches.length < 100) {
      const entry = pending.pop(); visited++;
      if (entry.path.toLowerCase().includes(query) || (entry.value === null || typeof entry.value !== 'object') && String(entry.value).toLowerCase().includes(query)) matches.push(entry);
      if (entry.value && typeof entry.value === 'object' && entry.depth < 50) {
        const keys = Object.keys(entry.value);
        const available = Math.max(0, MAX_SEARCH_NODES - visited - pending.length);
        skipped ||= keys.length > available;
        for (const key of keys.slice(0, available).reverse()) {
          pending.push({ value: entry.value[key], path: entry.path + (Array.isArray(entry.value) ? `[${key}]` : `[${JSON.stringify(key)}]`), depth: entry.depth + 1 });
        }
      } else if (entry.value && typeof entry.value === 'object') skipped = true;
    }
    return { matches, limited: skipped || pending.length > 0 || visited >= MAX_SEARCH_NODES || matches.length >= 100 };
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function render(file) {
    const chinese = document.documentElement.lang.toLowerCase().startsWith('zh');
    const text = (zh, en) => chinese ? zh : en;
    const root = element('section', undefined, 'data-preview');
    const controls = element('div', undefined, 'data-preview-controls');
    const search = element('input'); search.type = 'search'; search.placeholder = text('搜索', 'Search'); search.setAttribute('aria-label', search.placeholder);
    const status = element('p', '', 'data-preview-status'); status.setAttribute('role', 'status');
    const content = element('div', undefined, 'data-preview-content');
    root.append(controls, status, content);
    const raw = message => {
      status.textContent = message;
      content.replaceChildren(element('pre', file.text, 'file-preview-text'));
    };
    if (extension(file) === 'json') {
      if (file.truncated) { raw(text('文件超过预览大小限制，无法解析完整 JSON；显示已读取的文本。', 'JSON exceeds the preview limit; showing the available text instead.')); return root; }
      let value;
      try { value = JSON.parse((file.text || '').replace(/^\uFEFF/, '')); }
      catch { raw(text('JSON 格式无效，显示原始文本。', 'Invalid JSON; showing the original text.')); return root; }
      controls.append(search);
      const collapse = element('button', text('收起全部', 'Collapse all')); collapse.type = 'button'; controls.append(collapse);
      function tree(value, label, depth = 0) {
        if (value === null || typeof value !== 'object') return element('div', `${label}: ${JSON.stringify(value)}`, 'json-value');
        const keys = Object.keys(value);
        const node = element('details', undefined, 'json-node');
        node.append(element('summary', `${label} ${Array.isArray(value) ? '[' : '{'}${keys.length}${Array.isArray(value) ? ']' : '}'}`));
        const children = element('div', undefined, 'json-children'); node.append(children);
        let count = 0, loaded = false;
        const more = element('button', text('加载更多', 'Load more')); more.type = 'button';
        const populate = () => {
          more.remove();
          for (const key of keys.slice(count, count + PAGE_SIZE)) children.append(tree(value[key], key, depth + 1));
          count += PAGE_SIZE;
          if (count < keys.length) children.append(more);
        };
        more.onclick = populate;
        node.addEventListener('toggle', () => {
          if (!node.open || loaded) return;
          loaded = true;
          if (depth >= 50) children.append(element('p', text('已达到预览层级限制。', 'Preview depth limit reached.')));
          else populate();
        });
        return node;
      }
      const showTree = () => { content.replaceChildren(tree(value, '$')); status.textContent = text('点击节点展开；子项按需加载。', 'Expand a node to load its children.'); };
      showTree();
      collapse.onclick = () => content.querySelectorAll('details').forEach(node => { node.open = false; });
      search.oninput = () => {
        const query = search.value.trim().toLowerCase();
        if (!query) { showTree(); return; }
        const result = searchJson(value, query);
        content.replaceChildren(...result.matches.map(entry => tree(entry.value, entry.path)));
        status.textContent = `${result.matches.length} ${text('个匹配', 'matches')}${result.limited ? text(' · 搜索结果或扫描范围已达上限', ' · Result or scan limit reached') : ''}`;
      };
    } else {
      const result = parseTable(file.text || '', extension(file) === 'tsv' ? '\t' : ',');
      const label = element('label');
      const header = element('input'); header.type = 'checkbox'; header.checked = true;
      label.append(header, document.createTextNode(text('首行为列名', 'First row is header')));
      controls.append(search, label);
      const previous = element('button', text('上一页', 'Previous')), next = element('button', text('下一页', 'Next'));
      previous.type = next.type = 'button'; controls.append(previous, next);
      let page = 0, filtered = [];
      function draw() {
        const width = Math.max(0, ...result.rows.map(row => row.length));
        const names = header.checked ? result.rows[0] || [] : [];
        const table = element('table');
        const heading = element('tr'); heading.append(element('th', '#'));
        for (let column = 0; column < width; column++) { const cell = element('th', names[column] || String(column + 1)); cell.scope = 'col'; heading.append(cell); }
        const head = element('thead'); head.append(heading); table.append(head);
        const body = element('tbody');
        for (const entry of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
          const row = element('tr'); const number = element('th', entry.index + 1); number.scope = 'row'; row.append(number);
          for (let column = 0; column < width; column++) row.append(element('td', entry.row[column] || ''));
          body.append(row);
        }
        table.append(body); content.replaceChildren(table);
        previous.disabled = page === 0; next.disabled = (page + 1) * PAGE_SIZE >= filtered.length;
        status.textContent = `${filtered.length} ${text('行', 'rows')} · ${page + 1} / ${Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}` +
          (result.truncated ? text(' · 最多预览 20000 行、200 列', ' · Preview limited to 20000 rows and 200 columns') : '') +
          (result.errors.length ? text(' · 文件格式异常，部分单元格可能不准确', ' · Parse warnings: some cells may be inaccurate') : '');
      }
      const filter = () => {
        const query = search.value.trim().toLowerCase(); page = 0;
        filtered = result.rows.map((row, index) => ({ row, index })).filter(entry => (!header.checked || entry.index > 0) && (!query || entry.row.some(cell => cell.toLowerCase().includes(query))));
        draw();
      };
      search.oninput = filter; header.onchange = filter;
      previous.onclick = () => { page--; draw(); }; next.onclick = () => { page++; draw(); };
      filter();
    }
    return root;
  }
  return { supports, render, parseTable, searchJson };
});
