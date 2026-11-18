'use strict';
(() => {
  function isImagePath(p) { return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p); }

  // Attachment chips draw a themed glyph instead of an OS emoji, so a pasted
  // file reads as part of the workbench rather than a stray default icon.
  const ATTACHMENT_GLYPHS = {
    text: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13.5h6M9 17h4"/>',
    sheet: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 17h7M12 13v4"/>',
    slides: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v6m0 0-2.5-2.5M12 18l2.5-2.5"/>',
    pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 17v-5h1.6a1.7 1.7 0 0 1 0 3.4H9"/>',
    archive: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M11 12.5h2M11 15.5h2M11 18.5h2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.4"/><path d="m20 16-4.5-4.5L6 21"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  };
  function attachmentGlyphKind(name, isImage) {
    if (isImage) return 'image';
    const extension = String(name || '').split('.').pop().toLowerCase();
    if (extension === 'pdf') return 'pdf';
    if (['xls', 'xlsx', 'xlsm', 'ods', 'numbers', 'csv', 'tsv'].includes(extension)) return 'sheet';
    if (['ppt', 'pptx', 'odp', 'key'].includes(extension)) return 'slides';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'].includes(extension)) return 'archive';
    if (['txt', 'text', 'md', 'markdown', 'rst', 'log', 'tex', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'xml'].includes(extension)) return 'text';
    return 'file';
  }
  function attachmentGlyph(name, isImage, className) {
    const kind = attachmentGlyphKind(name, isImage);
    return '<span class="' + className + ' attchip-file-' + kind + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      ATTACHMENT_GLYPHS[kind] + '</svg></span>';
  }
  function fileUrl(p) {
    const normalized = String(p).replace(/\\/g, '/');
    const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return normalized.startsWith('//') ? 'file:' + encoded : 'file:///' + encoded.replace(/^\//, '');
  }

  function toolIcon(name) {
    const n = String(name || '').toLowerCase();
    if (/pwsh|bash|shell|cmd|powershell/.test(n)) return '💻';
    if (/read|glob/.test(n)) return '📄';
    if (/edit|write/.test(n)) return '✏️';
    if (/grep|search|web/.test(n)) return '🔍';
    if (/todo|task/.test(n)) return '☑️';
    if (/mcp|workflow|subagent|agent/.test(n)) return '🤖';
    return '🔧';
  }

  function toolSummary(name, inputData) {
    if (!inputData) return '';
    const c = typeof inputData === 'string' ? inputData
      : inputData.command || inputData.CommandLine || inputData.file_path || inputData.TargetFile
        || inputData.AbsolutePath || inputData.pattern || inputData.path || inputData.description
        || inputData.url || inputData.query || '';
    if (!c) return '';
    const line = String(c).split('\n')[0];
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
  }

  // Web search results are model/tool data, not trusted markup. Keep the
  // presentation in one pure function so the card, tests and future citation
  // markers agree on ordering, deduplication and labels.
  const TRACKING_PARAMS = new Set([
    'gclid', 'dclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid',
    'ref', 'ref_src', 'ref_url', 'spm', 'scm', 'share_source', 'share_medium',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  ]);

  // Native harnesses wrap MCP results as { content: [{ type: 'text', text }] },
  // and some add another JSON string layer. Unwrap those envelopes before the
  // card looks for the real web-tool result. Never coerce arbitrary text into a
  // fake payload: an unrecognised shape stays unrecognised and falls back to
  // the plain tool output.
  function toolPayload(output) {
    let value = output;
    for (let depth = 0; depth < 8; depth += 1) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return null;
        try { value = JSON.parse(trimmed); } catch { return null; }
        continue;
      }
      if (!value || typeof value !== 'object') return null;
      if (Array.isArray(value.content)) {
        const texts = value.content
          .filter(item => item && (item.type === 'text' || item.type === undefined) && typeof item.text === 'string')
          .map(item => item.text);
        if (!texts.length) return null;
        value = texts.join('\n');
        continue;
      }
      return value;
    }
    return null;
  }

  // A source key must survive the harmless spelling differences a model writes:
  // missing scheme, case differences, a trailing slash, a fragment, and common
  // tracking parameters. Keep the visible URL as written; only the key is
  // normalized, so the card never rewrites the user's citation.
  function sourceKey(value) {
    const raw = String(value || '').trim();
    if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return '';
    let url;
    try {
      if (/^https?:\/\//i.test(raw)) url = new URL(raw);
      else if (/^www\./i.test(raw)) url = new URL('https://' + raw);
      else if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return '';
      else url = new URL('https://' + raw);
    } catch { return ''; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const name of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name);
    }
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  }

  function webSearchView(name, output) {
    if (!/^camellia_web_search$/i.test(String(name || ''))) return null;
    let value = toolPayload(output);
    if (!value || typeof value !== 'object') return null;
    if (value.ok === false) {
      return { error: String(value.error || 'Search failed'), results: [] };
    }
    const rows = Array.isArray(value.results) ? value.results : [];
    const seen = new Set();
    const results = [];
    for (const row of rows) {
      if (!row || typeof row.url !== 'string' || typeof row.title !== 'string') continue;
      const key = sourceKey(row.url);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      let site = '';
      try { site = new URL(key).hostname; } catch {}
      results.push({
        index: results.length + 1,
        title: row.title,
        url: String(row.url),
        key,
        site,
        summary: typeof row.summary === 'string' ? row.summary : '',
        date: typeof row.date === 'string' && row.date ? row.date : '',
      });
    }
    return { error: '', results, provider: typeof value.provider === 'string' ? value.provider : '',
      truncated: value.truncated === true };
  }

  // A fetched page is one source, not a result list. Present its identity
  // (title, site, final URL, which fetcher answered) before its readable text,
  // so a long page does not look like an undifferentiated wall of output.
  function webFetchView(name, output) {
    if (!/^camellia_web_fetch$/i.test(String(name || ''))) return null;
    let value = toolPayload(output);
    if (!value || typeof value !== 'object') return null;
    if (value.ok === false) {
      return {
        error: String(value.error || 'Page fetch failed'),
        code: typeof value.code === 'string' ? value.code : '',
        url: typeof value.url === 'string' ? value.url : '',
        fallbackFrom: typeof value.fallback_from === 'string' ? value.fallback_from : '',
        fallbackReason: typeof value.fallback_reason === 'string' ? value.fallback_reason : '',
      };
    }
    const url = typeof value.final_url === 'string' && value.final_url ? value.final_url
      : typeof value.url === 'string' ? value.url : '';
    let site = '';
    try { site = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    return {
      error: '',
      title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : url,
      url,
      site,
      provider: typeof value.provider === 'string' ? value.provider : '',
      fallbackFrom: typeof value.fallback_from === 'string' ? value.fallback_from : '',
      fallbackReason: typeof value.fallback_reason === 'string' ? value.fallback_reason : '',
      connectionMode: typeof value.connection_mode === 'string' ? value.connection_mode : '',
      content: typeof value.content === 'string' ? value.content : '',
      truncated: value.truncated === true,
    };
  }

  // Search order is metadata, not citation order. Allocate a number only when
  // a reply actually links a source, including fetched or directly linked pages.
  function sourceRegistry(list = []) {
    const byUrl = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'object') continue;
      const key = item.key || sourceKey(item.url);
      if (key && !byUrl.has(key)) byUrl.set(key, item);
    }
    const cited = new Map();
    return {
      get size() { return cited.size; },
      get(url) { return cited.get(sourceKey(url)) || null; },
      numberFor(url) {
        const key = sourceKey(url);
        if (!key) return 0;
        if (!cited.has(key)) {
          cited.set(key, { ...byUrl.get(key), url, key, index: cited.size + 1 });
        }
        return cited.get(key).index;
      },
    };
  }

  // Streaming parses only the unfinished suffix, and may revisit table rows.
  // Reconcile labels against the displayed link order across all answer blocks
  // so fragments and repeated canonical snapshots cannot reserve extra numbers.
  function renumberSources(elements) {
    const registry = sourceRegistry();
    for (const element of elements) {
      for (const link of element.querySelectorAll('a[data-chat-source]')) {
        const marker = link.nextElementSibling;
        if (!marker?.classList.contains('md-source-marker')) continue;
        const number = String(registry.numberFor(link.getAttribute('href')));
        if (link.dataset.chatSource !== number) link.dataset.chatSource = number;
        if (marker.textContent !== number) marker.textContent = number;
        if (marker.getAttribute('aria-label') !== 'Source ' + number) marker.setAttribute('aria-label', 'Source ' + number);
        if (marker.title !== 'Open source ' + number) marker.title = 'Open source ' + number;
      }
    }
  }

  function previewableToolPath(name, inputData) {
    if (!inputData || typeof inputData !== 'object') return '';
    if (!/(write|edit|create|save|output|export|patch)/.test(String(name || '').toLowerCase())) return '';
    const candidate = inputData.file_path || inputData.TargetFile || inputData.path || inputData.output_path || inputData.destination || inputData.filename || '';
    return typeof candidate === 'string' ? candidate : '';
  }

  function makeToolCard(name, inputData, openFilePreview) {
    const el = document.createElement('div');
    el.className = 'tool-card';
    el.innerHTML =
      '<div class="tool-head">' +
      '  <span class="arrow">▶</span>' +
      '  <span class="tool-icon">' + toolIcon(name) + '</span>' +
      '  <span class="tool-name"></span>' +
      '  <span class="tool-summary"></span>' +
      '  <span class="tool-state"></span>' +
      '</div>' +
      '<div class="tool-body">' +
      "  <div class=\"tool-section-label\" data-i18n>Input</div>" +
      '  <div class="tool-code tool-input"></div>' +
      "  <div class=\"tool-section-label\" data-i18n>Output</div>" +
      "  <div class=\"tool-output\" data-i18n>Waiting for result…</div>" +
      '</div>';
    el.querySelector('.tool-name').textContent = name || 'tool';
    el.querySelector('.tool-head').addEventListener('click', () => el.classList.toggle('open'));
    const card = {
      name, el,
      inputEl: el.querySelector('.tool-input'),
      outputEl: el.querySelector('.tool-output'),
      stateEl: el.querySelector('.tool-state'),
      summaryEl: el.querySelector('.tool-summary'),
      setInput(data) {
        this.inputData = data;
        this.previewPath = previewableToolPath(this.name, data);
        this.summaryEl.textContent = toolSummary(this.name, data);
        if (typeof data === 'string') {
          this.inputEl.textContent = data;
        } else if (data && data.command) {
          this.inputEl.textContent = data.command +
            Object.keys(data).filter((k) => k !== 'command')
              .map((k) => '\n' + k + ': ' + (typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k]))).join('');
        } else if (data) {
          this.inputEl.textContent = JSON.stringify(data, null, 2);
        } else {
          this.inputEl.textContent = "(No input)";
        }
      },
      setOutput(text, isErr) {
        this.finished = true;
        this.failed = !!isErr;
        const search = isErr ? null : webSearchView(this.name, text);
        const page = isErr ? null : webFetchView(this.name, text);
        this.outputEl.textContent = '';
        this.outputEl.classList.toggle('err', !!isErr);
        if (search) renderWebSearch(this.outputEl, search);
        else if (page) renderWebFetch(this.outputEl, page);
        else this.outputEl.textContent = text || "(No output)";
        this.stateEl.className = 'tool-state ' + (isErr ? 'err' : 'done');
        this.summaryEl.textContent = search ? webSearchSummary(search)
          : page ? webFetchSummary(page)
            : toolSummary(this.name, this.inputData);
        if (search || page) this.summaryEl.dataset.i18n = '';
        else delete this.summaryEl.dataset.i18n;
        if (!isErr && this.previewPath && !this.el.querySelector('.tool-preview-file')) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'tool-preview-file';
          button.textContent = window.CamelliaI18n.t('Preview') + ' · ' + String(this.previewPath).split(/[\\/]/).pop();
          button.addEventListener('click', event => { event.stopPropagation(); void openFilePreview(this.previewPath); });
          this.outputEl.after(button);
        }
      },
    };
    card.setInput(inputData || null);
    return card;
  }

  function webSearchSummary(view) {
    if (view.error) return window.CamelliaI18n.t('Search failed');
    const count = view.results.length;
    return count === 1 ? '1 source' : count + ' sources';
  }

  // Search output is structured: a title, a site label and a summary per row,
  // with the original text still available for copy and inspection. Links are
  // anchors with a fixed protocol check, never innerHTML from the result.
  function renderWebSearch(container, view) {
    const t = window.CamelliaI18n.t;
    if (view.error) {
      const error = document.createElement('div');
      error.className = 'tool-output-err';
      error.textContent = view.error;
      container.append(error);
      return;
    }
    const list = document.createElement('ol');
    list.className = 'web-search-results';
    for (const item of view.results) {
      const row = document.createElement('li');
      row.className = 'web-search-result';
      const title = document.createElement('a');
      title.href = item.url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      title.textContent = item.title;
      title.className = 'web-search-title';
      row.append(title);
      if (item.site || item.date) {
        const meta = document.createElement('div');
        meta.className = 'web-search-meta';
        meta.textContent = [item.site, item.date].filter(Boolean).join(' · ');
        row.append(meta);
      }
      if (item.summary) {
        const summary = document.createElement('div');
        summary.className = 'web-search-summary';
        summary.textContent = item.summary;
        row.append(summary);
      }
      list.append(row);
    }
    container.append(list);
    if (view.truncated) {
      const note = document.createElement('div');
      note.className = 'web-search-note';
      note.dataset.i18n = '';
      note.textContent = 'Some results were omitted because the response was too large.';
      container.append(note);
    }
  }

  function webFetchSummary(view) {
    if (view.error) return window.CamelliaI18n.t('Page fetch failed');
    const title = String(view.title || '').trim();
    return title.length > 72 ? title.slice(0, 72) + '…' : title;
  }

  const FETCH_PREVIEW_CHARS = 1600;

  // The provider label explains why a page may look different between modes;
  // the fallback line records that DeepSeek was tried first and failed.
  function renderWebFetch(container, view) {
    const t = window.CamelliaI18n.t;
    if (view.error) {
      const error = document.createElement('div');
      error.className = 'web-fetch-error';
      const message = document.createElement('p');
      message.className = 'web-fetch-error-message';
      message.textContent = view.error;
      error.append(message);
      const meta = [view.url, view.code && 'Code: ' + view.code,
        view.fallbackFrom && t('Fell back from {0}').replace('{0}', view.fallbackFrom),
        view.fallbackReason].filter(Boolean);
      if (meta.length) {
        const detail = document.createElement('p');
        detail.className = 'web-fetch-error-meta';
        detail.textContent = meta.join(' · ');
        error.append(detail);
      }
      container.append(error);
      return;
    }
    const header = document.createElement('div');
    header.className = 'web-fetch-card';
    const title = document.createElement('a');
    title.className = 'web-fetch-title';
    title.href = view.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = view.title;
    header.append(title);
    const labels = [];
    if (view.site) labels.push({ text: view.site });
    if (view.provider === 'local') labels.push({ text: 'Local fetch', translate: true });
    else if (view.provider === 'deepseek') labels.push({ text: 'DeepSeek fetch', translate: true });
    if (view.fallbackFrom) labels.push({ text: 'Fell back from ' + view.fallbackFrom, translate: true });
    if (view.connectionMode) labels.push({ text: view.connectionMode });
    if (labels.filter(Boolean).length) {
      const meta = document.createElement('div');
      meta.className = 'web-fetch-meta';
      labels.forEach((label, index) => {
        if (index) meta.append(' · ');
        const part = document.createElement('span');
        if (label.translate) part.dataset.i18n = '';
        part.textContent = label.text;
        meta.append(part);
      });
      header.append(meta);
    }
    container.append(header);
    if (view.content.trim()) {
      const text = view.content.trim();
      const preview = document.createElement('pre');
      preview.className = 'web-fetch-content';
      preview.textContent = text.slice(0, FETCH_PREVIEW_CHARS)
        + (text.length > FETCH_PREVIEW_CHARS ? '\n…' : '');
      container.append(preview);
      if (text.length > FETCH_PREVIEW_CHARS) {
        const more = document.createElement('details');
        more.className = 'web-fetch-more';
        const summary = document.createElement('summary');
        summary.dataset.i18n = '';
        summary.textContent = 'Show the rest of the page text';
        const rest = document.createElement('pre');
        rest.className = 'web-fetch-content';
        rest.textContent = text.slice(FETCH_PREVIEW_CHARS);
        more.append(summary, rest);
        container.append(more);
      }
      const stats = document.createElement('div');
      stats.className = 'web-fetch-stats';
      stats.dataset.i18n = '';
      stats.textContent = text.length + ' characters read'
        + (view.truncated ? ' · Content was truncated by the fetcher.' : '');
      container.append(stats);
    } else {
      const empty = document.createElement('div');
      empty.className = 'web-fetch-empty';
      empty.dataset.i18n = '';
      empty.textContent = 'The page returned no readable text.';
      container.append(empty);
    }
  }

  // An expanded process buries its own summary above the viewport, so the
  // disclosure carries a second collapse control next to where the reader
  // ends up after scanning dozens of tool calls.
  const collapseChevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m7 14 5-5 5 5"/></svg>';
  function setExecutionProcessOpen(el, open, fromFooter = false) {
    const header = el.closest('.turn')?.querySelector('.completion-label') || el.querySelector('summary');
    const previousTop = header.getBoundingClientRect().top;
    // Notify the owner before layout changes, including an already queued
    // follow frame. A disclosure click is an explicit reading action.
    el.dispatchEvent(new CustomEvent('camellia:process-reading', { bubbles: true }));
    el.dataset.userExpanded = String(open);
    el.open = open;
    const scroll = el.closest('#chatScroll');
    if (scroll) {
      const viewport = scroll.getBoundingClientRect();
      const rect = header.getBoundingClientRect();
      const top = viewport.top + scroll.clientTop + 16;
      const bottom = viewport.top + scroll.clientTop + scroll.clientHeight;
      const preview = open ? Math.min(160, scroll.clientHeight * .35) : 0;
      const target = previousTop >= top && previousTop + rect.height + preview <= bottom
        ? previousTop : top;
      // One synchronous layout and an instant scroll also handle thousands of
      // process rows without painting an intermediate position at their end.
      scroll.scrollTo({ top: scroll.scrollTop + rect.top - target, behavior: 'instant' });
    }
    if (fromFooter) header.focus({ preventScroll: true });
  }
  function executionProcess() {
    const el = document.createElement('details');
    el.className = 'execution-process';
    el.innerHTML = '<summary><span data-i18n>Execution process</span><span class="execution-process-count" data-i18n></span></summary><div class="execution-process-body"></div>';
    el.querySelector('summary').addEventListener('click', event => {
      event.preventDefault();
      setExecutionProcessOpen(el, !el.open);
    });
    const collapse = document.createElement('button');
    collapse.type = 'button'; collapse.className = 'execution-process-collapse';
    collapse.innerHTML = collapseChevron + 'Collapse';
    collapse.dataset.i18n = ''; collapse.dataset.i18nAttrs = 'aria-label title';
    collapse.setAttribute('aria-label', 'Collapse execution process');
    collapse.title = 'Collapse execution process';
    collapse.addEventListener('click', () => {
      setExecutionProcessOpen(el, false, true);
    });
    el.append(collapse);
    return el;
  }

  function renderAttachments(row, files, { preview, remove, collapsible = false } = {}) {
    const previous = row.querySelector('.attach-overflow');
    const previousPaths = new Set(Array.from(row.querySelectorAll('.attchip'), chip => chip.title));
    const expanded = previous?.open && files.some(file => previousPaths.has(file.path));
    const scrollTop = previous?.querySelector('.attach-list')?.scrollTop || 0;
    row.replaceChildren(); row.classList.toggle('has', files.length > 0);
    row.classList.toggle('attach-composer', collapsible);
    let list = row;
    if (collapsible && files.length > 12) {
      const details = document.createElement('details'); details.className = 'attach-overflow'; details.open = Boolean(expanded);
      const summary = document.createElement('summary'); summary.className = 'attach-summary';
      const count = document.createElement('span'); count.className = 'attach-count'; count.dataset.i18n = ''; count.textContent = files.length + ' attachments';
      const expand = document.createElement('span'); expand.className = 'attach-expand'; expand.dataset.i18n = ''; expand.textContent = 'Expand attachments';
      const collapse = document.createElement('span'); collapse.className = 'attach-collapse'; collapse.dataset.i18n = ''; collapse.textContent = 'Collapse attachments';
      summary.append(count, expand, collapse);
      list = document.createElement('div'); list.className = 'attach-list';
      details.append(summary, list); row.append(details);
    }
    for (const [index, file] of files.entries()) {
      const chip = document.createElement('div'); chip.className = 'attchip'; chip.title = file.path;
      if (file.isImage || file.kind === 'image') { const image = document.createElement('img'); image.src = fileUrl(file.path); image.alt = ''; chip.append(image); }
      else if (file.kind === 'conversation') {
        const glyph = document.createElement('span'); glyph.className = 'attchip-fileicon attchip-conversation-icon';
        glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        chip.append(glyph);
      } else { const glyph = document.createElement('span'); glyph.innerHTML = attachmentGlyph(file.name, false, 'attchip-fileicon'); chip.append(...glyph.childNodes); }
      const name = document.createElement('span'); name.className = 'attchip-name'; name.textContent = file.name;
      name.tabIndex = 0; name.role = 'button'; name.title = window.CamelliaI18n.t('Preview');
      name.onclick = () => preview?.(file.path);
      name.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); preview?.(file.path); } };
      chip.append(name);
      if (remove) { const button = document.createElement('button'); button.type = 'button'; button.className = 'attchip-x'; button.title = window.CamelliaI18n.t('Remove'); button.textContent = '✕'; button.onclick = () => remove(index); chip.append(button); }
      list.append(chip);
    }
    if (list !== row) list.scrollTop = scrollTop;
  }
  function resizeAnswerField(field) {
    if (!field || field.tagName !== 'TEXTAREA') return;
    field.style.height = 'auto';
    field.style.height = Math.min(Math.max(field.scrollHeight, 40), 180) + 'px';
  }
  function resizeQuestionFields(container) {
    for (const field of container?.querySelectorAll('.question-custom textarea') || []) resizeAnswerField(field);
  }
  function questionFields(container, questions, { saved = {}, changed = () => {} } = {}) {
    const fields = []; container.replaceChildren();
    for (const [index, question] of questions.entries()) {
      const field = document.createElement('fieldset');
      const legend = document.createElement('legend'); legend.textContent = question.question; field.append(legend);
      // The native payload carries a short topic header ("下一步", "任务确认").
      // Surface it under the question so a queued dialog still states its subject.
      const topic = typeof question.header === 'string' ? question.header.trim() : '';
      if (topic) { const tag = document.createElement('span'); tag.className = 'question-tag'; tag.textContent = topic; field.append(tag); }
      if (question.multiSelect) { const note = document.createElement('p'); note.className = 'question-hint'; note.dataset.i18n = ''; note.textContent = 'Select one or more'; field.append(note); }
      const choices = [];
      for (const option of question.options || []) {
        const label = document.createElement('label'); label.className = 'question-choice';
        const choice = document.createElement('input'); choice.type = question.multiSelect ? 'checkbox' : 'radio'; choice.name = 'question-' + index; choice.value = option.label;
        choice.checked = Boolean(saved[question.id]?.selected?.includes(option.label));
        const content = document.createElement('span'), name = document.createElement('strong'); name.textContent = option.label; content.append(name);
        if (option.description) { const description = document.createElement('span'); description.textContent = option.description; content.append(description); }
        label.append(choice, content); field.append(label); choices.push(choice);
      }
      const customLabel = document.createElement('label'); customLabel.className = 'question-custom';
      const customTitle = document.createElement('span'); customTitle.dataset.i18n = ''; customTitle.textContent = choices.length ? 'Or write your own answer' : 'Your answer';
      const custom = document.createElement(question.isSecret ? 'input' : 'textarea');
      if (question.isSecret) custom.type = 'password'; else custom.rows = 1;
      custom.autocomplete = 'off'; custom.value = question.isSecret ? '' : saved[question.id]?.custom || '';
      customLabel.append(customTitle, custom); field.append(customLabel); container.append(field);
      fields.push({ question, choices, custom });
      custom.oninput = () => {
        resizeAnswerField(custom);
        if (!question.multiSelect && custom.value) choices.forEach(choice => choice.checked = false);
        changed(fields);
      };
      custom.addEventListener('focus', () => resizeAnswerField(custom));
      requestAnimationFrame(() => resizeAnswerField(custom));
      choices.forEach(choice => { choice.onchange = () => { if (!question.multiSelect) custom.value = ''; changed(fields); }; });
    }
    return fields;
  }
  window.CamelliaChatControls = { isImagePath, attachmentGlyph, fileUrl, makeToolCard, executionProcess, setExecutionProcessOpen, renderAttachments, questionFields, resizeQuestionFields, webSearchView, webFetchView, sourceRegistry, sourceKey, renumberSources };
})();
