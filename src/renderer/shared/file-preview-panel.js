'use strict';
const TEXT_PREVIEW_AUTOSAVE_MS = 1000;
const monacoBase = new URL('../../../node_modules/monaco-editor/min/vs/', document.currentScript.src);
const monacoStyles = new WeakMap();
let monacoLoading;
const textPreviewClosers = new Set();
const wordPreviewClosers = new Set();
let textPreviewsClosing;

function loadMonacoScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(path, monacoBase).href;
    script.onerror = reject;
    script.onload = resolve;
    document.head.append(script);
  });
}

function loadTextPreviewMonaco(root) {
  monacoLoading ??= (async () => {
    await Promise.all([loadMonacoScript('loader.js'), window.CamelliaI18n.language === 'zh-CN'
      ? loadMonacoScript('nls/lang/zh-cn.js') : null]);
    window.require.config({ paths: { vs: monacoBase.href.slice(0, -1) } });
    return new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], resolve, reject));
  })();
  if (root === document) return monacoLoading;
  if (!monacoStyles.has(root)) {
    monacoStyles.set(root, new Promise((resolve, reject) => {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = new URL('editor/editor.main.css', monacoBase).href;
      stylesheet.onload = resolve;
      stylesheet.onerror = reject;
      root.append(stylesheet);
    }));
  }
  return Promise.all([monacoLoading, monacoStyles.get(root)]).then(([monaco]) => monaco);
}

function textPreviewLanguage(monaco, file) {
  const name = file.name.toLowerCase();
  const extension = '.' + file.extension?.toLowerCase();
  const aliases = { '.cjs': 'javascript', '.mjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript' };
  return aliases[extension] || monaco.languages.getLanguages().find(language =>
    language.filenames?.some(filename => filename.toLowerCase() === name) || language.extensions?.includes(extension))?.id || 'plaintext';
}

function textPreviewTheme() {
  const theme = document.documentElement.dataset.theme;
  return (theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) ? 'vs-dark' : 'vs';
}

function closeTextPreviewEditors() {
  textPreviewsClosing ??= (async () => {
    for (const close of [...wordPreviewClosers, ...textPreviewClosers]) if (!await close()) return false;
    return true;
  })().finally(() => { textPreviewsClosing = null; });
  return textPreviewsClosing;
}

window.CamelliaFilePreview = { closeTextEditors: closeTextPreviewEditors, create({
  fileViewer, inputCard, mdRender, setStatus, finishPreviewResize = () => {}, beforeOpen = () => {}, onClose = () => {}, root = document
}) {
  const $ = id => root.getElementById(id);
  const t = text => window.CamelliaI18n.t(text);
  const body = $('fileViewerBody');
  const editButton = document.createElement('button');
  editButton.type = 'button'; editButton.id = 'fileViewerEdit'; editButton.className = 'file-preview-edit-button';
  editButton.dataset.i18n = ''; editButton.textContent = 'Edit'; editButton.hidden = true;
  $('fileViewerReveal').before(editButton);
  let previewedFile = null;
  let previewRequest = 0;
  let previewLocation = {};
  let textEditor = null;
  let wordEditor = null;
  let markdownRender = null;
  let focusRequest = 0;
  const attachmentDragType = 'application/x-camellia-attachment-path';
  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 * 10 ? 1 : 0) + ' MB';
  }
  function previewLabel(file) {
    return file.extension || { text: 'TEXT', image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', pdf: 'PDF' }[file.kind] || 'FILE';
  }
  function updatePreviewMeta(file) {
    const location = previewLocation.line ? ':' + previewLocation.line : '';
    const filePath = file.path && file.path + location;
    const meta = $('fileViewerMeta');
    if (file.office) {
      const summary = document.createElement('span');
      summary.className = 'file-preview-meta-summary';
      summary.textContent = [formatFileSize(file.size), t('Document preview · Complex layouts may differ from the original.')].filter(Boolean).join('  ·  ');
      summary.title = filePath || '';
      meta.replaceChildren(summary);
      return;
    }
    meta.textContent = [formatFileSize(file.size), filePath].filter(Boolean).join('  ·  ');
  }
  // A toast in the chat's status line is easy to miss while the user is
  // looking at the preview, so editor failures also appear inside the panel.
  function setPreviewMessage(message) {
    let notice = body.querySelector('.file-preview-message');
    if (!notice) {
      notice = document.createElement('p');
      notice.className = 'file-preview-notice file-preview-message';
      notice.setAttribute('role', 'status');
      body.prepend(notice);
    }
    notice.textContent = message;
  }
  function renderUnsupportedPreview(message) {
    const empty = document.createElement('div');
    empty.className = 'file-preview-empty';
    empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><strong></strong><span></span><button type="button"></button>';
    empty.querySelector('strong').textContent = message || window.CamelliaI18n.t('This file type cannot be previewed in Camellia.');
    empty.querySelector('span').textContent = window.CamelliaI18n.t('Open it with the system app instead.');
    empty.querySelector('button').textContent = window.CamelliaI18n.t('Open with system app');
    empty.querySelector('button').onclick = () => openPreviewExternally();
    $('fileViewerBody').replaceChildren(empty);
  }
  function findAnchor(container, anchor) {
    const wanted = String(anchor).toLowerCase();
    return [...container.querySelectorAll('[data-preview-anchor], [id]')]
      .find(node => node.dataset.previewAnchor?.toLowerCase() === wanted || node.id.toLowerCase() === wanted);
  }
  function attachPreviewLinks(article) {
    article.addEventListener('click', event => {
      const link = event.target.closest('a');
      if (!link) return;
      event.preventDefault();
      if (link.dataset.previewBlocked) return;
      const href = link.getAttribute('href');
      if (href.startsWith('#')) {
        let anchor;
        try { anchor = decodeURIComponent(href.slice(1)); } catch { return; }
        findAnchor(article, anchor)?.scrollIntoView({ block: 'start' });
      } else if (/^(?:https?|mailto):/.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
      else if (href.startsWith('file:')) {
        try {
          const url = new URL(href);
          const path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
          let anchor = '';
          try { anchor = decodeURIComponent(url.hash.slice(1)); } catch {}
          void openFilePreview(path, anchor ? { anchor, line: 0 } : {});
        } catch {}
      }
    });
  }
  function renderMarkdownPreview(file, article) {
    const text = (file.text || '').replace(/^\uFEFF/, '');
    article.textContent = '';
    const status = document.createElement('p');
    status.className = 'file-preview-notice file-preview-rendering';
    status.setAttribute('role', 'status');
    status.textContent = window.CamelliaI18n.t('Rendering Markdown…');
    body.replaceChildren(status, article);
    markdownRender?.controller?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const render = { controller, finished: false };
    markdownRender = render;
    const options = {
      baseUrl: file.url,
      sourceLines: true,
      signal: controller?.signal,
      onChunk: html => {
        if (markdownRender === render) article.insertAdjacentHTML('beforeend', html);
      },
    };
    const work = window.dshDesktop.markdownPreview
      ? window.CamelliaMarkdownPreview.renderChunkedOffloaded(text, options)
      : window.CamelliaMarkdownPreview.renderChunked(text, options);
    render.done = Promise.resolve(work).catch(error => {
      if (error?.name !== 'AbortError') {
        article.textContent = '';
        status.textContent = error?.message || window.CamelliaI18n.t('The Markdown preview could not be rendered.');
        status.classList.remove('file-preview-rendering');
        render.failed = true;
      }
    }).finally(() => {
      render.finished = true;
      if (!render.failed) status.remove();
      if (markdownRender === render) markdownRender = null;
    });
    return render.done;
  }
  function renderFilePreview(file) {
    markdownRender?.controller?.abort();
    markdownRender = null;
    previewedFile = file;
    fileViewer.dataset.mode = 'preview';
    $('fileViewerReveal').hidden = false;
    $('fileViewerExternal').hidden = false;
    editButton.hidden = file.kind !== 'text'
      ? !((file.kind === 'word' || file.kind === 'document') && file.wordEditToken && Array.isArray(file.paragraphs))
      : file.truncated || !file.editToken;
    $('fileViewerTitle').textContent = file.name;
    $('fileViewerType').textContent = previewLabel(file);
    updatePreviewMeta(file);
    body.replaceChildren();
    // A new preview starts at the top; a requested line or anchor then
    // overrides this once its Markdown render has finished.
    body.scrollTop = 0;
    if (file.kind === 'text') {
      const format = window.CamelliaArtifacts.documentFormat(file);
      if (format === 'html') {
        body.appendChild(window.CamelliaHtmlPreview.render(file));
      } else if (format === 'markdown') {
        const article = document.createElement('article'); article.className = 'file-preview-markdown md';
        article.setAttribute('translate', 'no');
        attachPreviewLinks(article);
        body.appendChild(article);
        renderMarkdownPreview(file, article);
      } else if (window.CamelliaDataPreview.supports(file)) {
        body.appendChild(window.CamelliaDataPreview.render(file));
      } else {
        const text = document.createElement('pre'); text.className = 'file-preview-text'; text.textContent = file.text;
        body.appendChild(text);
      }
      if (file.truncated) {
        const notice = document.createElement('p'); notice.className = 'file-preview-notice';
        notice.dataset.i18n = ''; notice.textContent = 'Text preview is limited to the first 20 MB.';
        body.appendChild(notice);
      }
    } else if (file.kind === 'image') {
      const stage = document.createElement('div'); stage.className = 'file-preview-image';
      const image = document.createElement('img'); image.src = file.url; image.alt = file.name;
      image.draggable = true;
      image.addEventListener('dragstart', event => {
        if (!event.dataTransfer || !file.path) { event.preventDefault(); return; }
        event.dataTransfer.setData(attachmentDragType, file.path);
        event.dataTransfer.effectAllowed = 'copy';
      });
      image.addEventListener('dragend', () => inputCard.classList.remove('dragging'));
      stage.appendChild(image); body.appendChild(stage);
    } else if (file.kind === 'pdf') {
      const frame = document.createElement('iframe'); frame.src = file.url; frame.title = file.name; body.appendChild(frame);
    } else if (file.kind === 'video' || file.kind === 'audio') {
      const media = document.createElement(file.kind); media.src = file.url; media.controls = true; media.preload = 'metadata';
      if (file.kind === 'video') media.setAttribute('playsinline', '');
      body.appendChild(media);
    } else if (file.office) {
      const stage = document.createElement('div'); stage.className = 'file-preview-office';
      // Rich conversion failed (no Word, or Word refused the file). The text
      // fallback is still readable, but say why it is not the full layout.
      if (file.office.richError) {
        const reason = document.createElement('p'); reason.className = 'file-preview-notice';
        reason.dataset.i18n = '';
        reason.textContent = 'Showing text only: ' + file.office.richError;
        stage.appendChild(reason);
      }
      if (file.office.wordHtml) {
        const frame = document.createElement('iframe'); frame.title = file.name;
        frame.className = 'file-preview-office-document'; frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer'; frame.srcdoc = file.office.wordHtml;
        stage.appendChild(frame);
      } else if (file.office.html) {
        const frame = document.createElement('iframe'); frame.title = file.name;
        frame.className = 'file-preview-office-document'; frame.setAttribute('sandbox', '');
        frame.referrerPolicy = 'no-referrer';
        frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'none\'; frame-src \'none\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'">' + file.office.html;
        if (file.office.sheets?.length) {
          const select = document.createElement('select');
          select.setAttribute('aria-label', 'Worksheet'); select.dataset.i18nAttrs = 'aria-label'; select.className = 'office-sheet-select';
          file.office.sheets.forEach((sheet, index) => select.append(new Option(sheet.title, String(index))));
          const prefix = frame.srcdoc.slice(0, frame.srcdoc.indexOf('<body>') + 6);
          const showSheet = () => { frame.srcdoc = prefix + file.office.sheets[Number(select.value)].html + '</body></html>'; };
          select.onchange = showSheet; showSheet(); stage.appendChild(select);
        }
        stage.appendChild(frame);
      } else for (const section of file.office.sections) {
        const page = document.createElement('section'); page.className = 'office-preview-section';
        if (section.title) { const heading = document.createElement('h3'); heading.textContent = section.title; page.appendChild(heading); }
        if (section.rows) {
          const table = document.createElement('table');
          for (const row of section.rows) {
            const line = document.createElement('tr');
            const number = document.createElement('th'); number.scope = 'row'; number.textContent = row.number; line.appendChild(number);
            for (const value of row.cells) { const cell = document.createElement('td'); cell.textContent = value; line.appendChild(cell); }
            table.appendChild(line);
          }
          page.appendChild(table);
        } else for (const paragraph of section.paragraphs) {
          const text = document.createElement('p'); text.textContent = paragraph; page.appendChild(text);
        }
        stage.appendChild(page);
      }
      if (file.office.truncated) {
        const note = document.createElement('p'); note.dataset.i18n = ''; note.textContent = 'Preview truncated. Open with the system app to see the complete file.'; stage.appendChild(note);
      }
      body.appendChild(stage);
    } else renderUnsupportedPreview();
    fileViewer.hidden = false;
  }
  function lineOffset(text, line) {
    let offset = 0;
    for (let current = 1; current < line; current++) {
      const end = text.indexOf('\n', offset);
      if (end < 0) break;
      offset = end + 1;
    }
    return offset;
  }
  function focusPreviewLocation({ line = 0, anchor = '' } = {}) {
    if (line) {
      const candidates = [...body.querySelectorAll('[data-preview-line]')]
        .filter(node => Number(node.dataset.previewLine) <= line && Number(node.dataset.previewEndLine) >= line)
        .sort((a, b) => Number(b.dataset.previewLine) - Number(a.dataset.previewLine));
      if (candidates.length) candidates[0].scrollIntoView({ block: 'center' });
      else {
        const text = body.querySelector('.file-preview-text')?.firstChild;
        if (text) {
          const offset = lineOffset(text.textContent, line);
          const range = document.createRange();
          range.setStart(text, offset); range.setEnd(text, Math.min(offset + 1, text.length));
          body.scrollTop += range.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2;
        }
      }
    } else if (anchor) findAnchor(body, anchor)?.scrollIntoView({ block: 'start' });
  }
  function focusWhenRendered(location) {
    const request = ++focusRequest;
    const pending = markdownRender;
    if (!pending || pending.finished) {
      focusPreviewLocation(location);
      return;
    }
    // Chunked rendering completes after the first frame. Wait for this exact
    // render so an older document cannot scroll the replacement preview.
    void pending.done.then(() => {
      if (request === focusRequest) focusPreviewLocation(location);
    });
  }
  function isDirty(editor) { return editor.model.getAlternativeVersionId() !== editor.savedVersion; }
  function updateEditor(editor) {
    const dirty = isDirty(editor);
    editor.save.disabled = !dirty || Boolean(editor.pending) || editor.leaving || editor.composing;
    editor.preview.disabled = editor.leaving;
    const error = dirty && editor.error;
    editor.status.classList.toggle('error', Boolean(error));
    const label = t(editor.pending ? 'Saving…' : dirty ? error || 'Unsaved changes' : editor.hasSaved ? 'Saved' : 'Auto-save on');
    if (editor.status.textContent !== label) editor.status.textContent = label;
  }
  function scheduleTextSave(editor) {
    clearTimeout(editor.timer);
    if (!editor.composing && !editor.pending && !editor.leaving && isDirty(editor)) {
      editor.timer = setTimeout(() => { void saveTextEdit(editor); }, TEXT_PREVIEW_AUTOSAVE_MS);
    }
    updateEditor(editor);
  }
  function saveTextEdit(editor) {
    if (editor.pending) return editor.pending;
    clearTimeout(editor.timer);
    if (editor.composing || !isDirty(editor)) return !editor.composing;
    const version = editor.model.getAlternativeVersionId();
    const text = editor.model.getValue();
    editor.error = '';
    editor.pending = Promise.resolve().then(() => window.dshDesktop.savePreviewText(editor.file.editToken, text))
      .then(result => {
        if (!result?.ok) throw new Error(result?.error || 'Could not save the file.');
        editor.file = previewedFile = { ...editor.file, ...result.file };
        editor.savedVersion = version;
        editor.hasSaved = true;
        updatePreviewMeta(previewedFile);
        return true;
      }).catch(error => {
        editor.error = error.message || 'Could not save the file.';
        return false;
      }).finally(() => {
        editor.pending = null;
        if (editor.model.getAlternativeVersionId() !== version) scheduleTextSave(editor);
        else updateEditor(editor);
      });
    updateEditor(editor);
    return editor.pending;
  }
  async function flushTextEdit(editor) {
    while (!editor.composing && (editor.pending || isDirty(editor))) {
      if (!await saveTextEdit(editor)) break;
    }
    return !editor.composing && !isDirty(editor);
  }
  async function finishTextEdit() {
    const editor = textEditor;
    if (!editor) return true;
    if (editor.leaving || editor.composing) return false;
    editor.leaving = true;
    editor.input.updateOptions({ readOnly: true });
    updateEditor(editor);
    try {
      if (!await flushTextEdit(editor)
        && !window.confirm(t(editor.error || 'Could not save the file.') + '\n\n' + t('Discard unsaved changes to this file?'))) return false;
      clearTimeout(editor.timer);
      textPreviewClosers.delete(closeFilePreview);
      editor.discarded = isDirty(editor);
      textEditor = null;
      editor.dispose();
      return true;
    } finally {
      if (textEditor === editor) {
        editor.leaving = false;
        editor.input.updateOptions({ readOnly: false });
        updateEditor(editor);
      }
    }
  }
  function renderSavedPreview() {
    renderFilePreview(previewedFile);
    focusWhenRendered(previewLocation);
  }
  // Word text is stored per paragraph, not per rendered page. Each cell keeps
  // its original document index for text saves and same-parent structure edits.
  function wordEditorBlocks(file) {
    if (file.wordFormat === 'docx' && Array.isArray(file.wordCells)) {
      return file.wordCells.map(cell => ({
        index: cell.index, text: file.paragraphs[cell.index] || '',
        locked: file.paragraphEditability?.[cell.index] === false,
        parent: cell.parent, canMove: Boolean(cell.canMove), notebook: true,
      }));
    }
    const blocks = [];
    file.paragraphs?.forEach((text, index) => {
      // A page break or inline picture has no editable text; the marker is
      // deliberately dropped rather than shown as a row that a save would
      // overwrite.
      if (!text.trim() || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return;
      blocks.push({ index, text, locked: file.paragraphEditability?.[index] === false, notebook: false });
    });
    return blocks;
  }
  function wordEditorDirty(editor, onlyBlock = null) {
    return editor.blocks.some(block => (!onlyBlock || block === onlyBlock) && !block.locked && block.input.value !== block.original);
  }
  function updateWordEditor(editor) {
    const dirty = wordEditorDirty(editor);
    const busy = Boolean(editor.structurePending || editor.cellPreviewPending);
    editor.save.disabled = !dirty || Boolean(editor.pending) || editor.leaving || busy;
    editor.preview.disabled = editor.leaving || busy;
    const error = editor.error;
    editor.status.classList.toggle('error', Boolean(error));
    const label = t(editor.cellPreviewPending ? 'Rendering cell preview…' : editor.structurePending ? 'Saving cell layout…'
      : editor.pending ? dirty ? 'Saving… newer edits are not saved yet' : 'Saving…'
        : error || (dirty ? 'Unsaved changes' : editor.hasSaved ? 'Saved' : 'Text only · formatting is kept'));
    if (editor.status.textContent !== label) editor.status.textContent = label;
    for (const block of editor.blocks) {
      if (!block.notebook) continue;
      block.input.readOnly = block.locked || busy || editor.leaving;
      block.edit.disabled = busy || editor.leaving;
      block.previewCell.disabled = busy || editor.leaving;
      block.insert.disabled = busy || editor.leaving;
      block.grip.disabled = busy || editor.leaving || !block.canMove;
      block.grip.draggable = block.canMove && !busy && !editor.leaving;
      block.edit.classList.toggle('active', block.mode === 'edit');
      block.previewCell.classList.toggle('active', block.mode === 'preview');
      block.edit.setAttribute('aria-pressed', String(block.mode === 'edit'));
      block.previewCell.setAttribute('aria-pressed', String(block.mode === 'preview'));
    }
  }
  function updateWordFile(editor, result) {
    editor.file = previewedFile = {
      ...editor.file, ...result.file, paragraphs: result.paragraphs,
      ...(Array.isArray(result.editable) ? { paragraphEditability: result.editable } : {}),
      ...(Array.isArray(result.cells) ? { wordCells: result.cells } : {}),
    };
  }
  function saveWordEdit(editor, onlyBlock = null) {
    if (editor.pending) return editor.pending;
    const changes = editor.blocks
      .filter(block => (!onlyBlock || block === onlyBlock) && !block.locked && block.input.value !== block.original)
      .map(block => ({ index: block.index, text: block.input.value }));
    // Nothing to save is always a clean close, even while Word is still being
    // asked for its exact paragraph list.
    if (!changes.length) return Promise.resolve(true);
    const submitted = new Map(changes.map(change => [change.index, change.text]));
    editor.error = '';
    const save = editor.file.wordFormat === 'doc'
      ? window.dshDesktop.savePreviewDoc(editor.file.wordEditToken, changes)
      : window.dshDesktop.savePreviewWord(editor.file.wordEditToken, changes);
    editor.pending = Promise.resolve().then(() => save)
      .then(result => {
        if (!result?.ok) throw new Error(result?.error || 'Could not save the document.');
        updateWordFile(editor, result);
        // A word editor stays editable while Word saves. Mark only the text
        // actually submitted; a keystroke made during the save must remain
        // dirty and be sent on the next save instead of being mislabeled as
        // saved because the input already moved on.
        for (const block of editor.blocks) {
          if (submitted.has(block.index)) block.original = submitted.get(block.index);
        }
        editor.hasSaved = true;
        updatePreviewMeta(previewedFile);
        return true;
      }).catch(error => {
        editor.error = error.message || 'Could not save the document.';
        return false;
      }).finally(() => {
        editor.pending = null;
        updateWordEditor(editor);
      });
    updateWordEditor(editor);
    return editor.pending;
  }
  async function flushWordEdit(editor, onlyBlock = null) {
    while (editor.pending || wordEditorDirty(editor, onlyBlock)) {
      if (editor.pending) { if (!await editor.pending) return false; }
      if (wordEditorDirty(editor, onlyBlock) && !await saveWordEdit(editor, onlyBlock)) return false;
    }
    return true;
  }
  async function finishWordEdit() {
    const editor = wordEditor;
    if (!editor) return true;
    if (editor.leaving || editor.structurePending || editor.cellPreviewPending) return false;
    if (!wordEditorDirty(editor)) {
      wordPreviewClosers.delete(closeFilePreview);
      editor.resizeObserver?.disconnect();
      editor.resizeObserver = null;
      wordEditor = null;
      return true;
    }
    editor.leaving = true;
    updateWordEditor(editor);
    try {
      if (!await flushWordEdit(editor) && !window.confirm(t(editor.error || 'Could not save the document.') + '\n\n' + t('Discard unsaved changes to this file?'))) return false;
      wordPreviewClosers.delete(closeFilePreview);
      editor.resizeObserver?.disconnect();
      editor.resizeObserver = null;
      editor.discarded = wordEditorDirty(editor);
      wordEditor = null;
      return true;
    } finally {
      if (wordEditor === editor) {
        editor.leaving = false;
        updateWordEditor(editor);
      }
    }
  }
  function setWordCellMode(block, mode) {
    block.mode = mode;
    block.input.hidden = mode !== 'edit';
    block.previewPane.hidden = mode !== 'preview';
    block.row.classList.toggle('previewing', mode === 'preview');
  }
  async function previewWordCell(editor, block) {
    if (block.mode === 'preview' || editor.structurePending || editor.cellPreviewPending) return;
    editor.cellPreviewPending = true;
    editor.error = '';
    updateWordEditor(editor);
    try {
      if (!await flushWordEdit(editor, block)) return;
      const result = await window.dshDesktop.previewWordCell(editor.file.wordEditToken, block.index);
      if (!result?.ok) throw new Error(result?.error || 'Could not preview this cell.');
      block.previewPane.innerHTML = result.html;
      setWordCellMode(block, 'preview');
    } catch (error) {
      editor.error = error.message || 'Could not preview this cell.';
    } finally {
      editor.cellPreviewPending = false;
      updateWordEditor(editor);
    }
  }
  function refreshWordStructure(editor, result) {
    updateWordFile(editor, result);
    editor.blocks.forEach((block, position) => {
      const cell = result.cells[position];
      block.index = cell.index;
      block.parent = cell.parent;
      block.canMove = Boolean(cell.canMove);
      block.locked = result.editable[cell.index] === false;
      block.row.classList.toggle('locked', block.locked);
      block.number.textContent = String(cell.index + 1);
      block.original = result.paragraphs[cell.index] || '';
      block.input.value = block.original;
      block.input.setAttribute('aria-label', t('Paragraph ') + (block.index + 1) + (block.locked ? ', ' + t('read-only') : ''));
    });
    updatePreviewMeta(previewedFile);
    editor.fitAll();
  }
  async function runWordStructure(editor, operation, apply) {
    if (editor.structurePending || editor.cellPreviewPending || editor.leaving) return;
    editor.structurePending = true;
    editor.error = '';
    updateWordEditor(editor);
    try {
      if (!await flushWordEdit(editor)) return;
      const result = await window.dshDesktop.structurePreviewWord(editor.file.wordEditToken, operation);
      if (!result?.ok) throw new Error(result?.error || 'Could not change the cell layout.');
      apply(result);
      refreshWordStructure(editor, result);
      editor.hasSaved = true;
    } catch (error) {
      editor.error = error.message || 'Could not change the cell layout.';
    } finally {
      editor.structurePending = false;
      updateWordEditor(editor);
    }
  }
  async function insertWordCell(editor, source) {
    await runWordStructure(editor, { type: 'insertAfter', index: source.index }, result => {
      const created = editor.createBlock({ index: source.index + 1, text: '', locked: false, parent: source.parent, canMove: true, notebook: true });
      source.row.after(created.row);
      editor.blocks.splice(editor.blocks.indexOf(source) + 1, 0, created);
      editor.fitAll();
      created.input.focus();
    });
  }
  async function moveWordCell(editor, source, target, position) {
    if (source === target || !source.canMove || source.parent !== target.parent) return;
    await runWordStructure(editor, { type: 'move', from: source.index, to: target.index, position }, () => {
      if (position === 'before') target.row.before(source.row);
      else target.row.after(source.row);
      const from = editor.blocks.indexOf(source);
      editor.blocks.splice(from, 1);
      const targetPosition = editor.blocks.indexOf(target);
      editor.blocks.splice(targetPosition + (position === 'after' ? 1 : 0), 0, source);
    });
  }
  function clearWordDropIndicators(editor) {
    for (const block of editor.blocks) block.row.classList.remove('drop-before', 'drop-after', 'dragging');
  }
  function showWordEditor() {
    if (wordEditor || textEditor || !previewedFile?.wordEditToken) return;
    const file = previewedFile;
    const blocks = wordEditorBlocks(file);
    if (!blocks.length) return;
    const panel = document.createElement('div'); panel.className = 'file-preview-editor file-preview-word';
    const toolbar = document.createElement('div'); toolbar.className = 'file-preview-editor-toolbar';
    const status = document.createElement('div'); status.className = 'file-preview-editor-status'; status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'file-preview-editor-actions';
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'btn-primary';
    preview.dataset.i18n = ''; preview.textContent = 'Preview';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-secondary';
    save.dataset.i18n = ''; save.textContent = 'Save';
    save.setAttribute('aria-keyshortcuts', window.dshDesktop.platform === 'darwin' ? 'Meta+S' : 'Control+S');
    actions.append(save, preview); toolbar.append(status, actions);
    const list = document.createElement('div'); list.className = 'file-preview-word-blocks';
    const editor = wordEditor = { file, blocks: [], status, save, preview, pending: null, hasSaved: false };
    // Wrapped text is taller than its line count, so the box has to follow the
    // rendered content instead of the raw paragraph newlines. This also runs
    // after a width change, when more or fewer characters fit on each line.
    const fitInput = input => {
      if (input.hidden) return;
      input.style.height = 'auto';
      // scrollHeight covers the content but not the textarea's own border;
      // without this the last line is clipped by exactly one pixel per edge.
      const border = input.offsetHeight - input.clientHeight;
      input.style.height = input.scrollHeight + Math.max(0, border) + 'px';
    };
    const fitAll = () => {
      const inputs = editor.blocks.map(block => block.input).filter(input => !input.hidden);
      for (const input of inputs) input.style.height = 'auto';
      const heights = inputs.map(input => input.scrollHeight + Math.max(0, input.offsetHeight - input.clientHeight));
      inputs.forEach((input, index) => { input.style.height = heights[index] + 'px'; });
    };
    editor.fitAll = fitAll;
    editor.createBlock = data => {
      const row = document.createElement(data.notebook ? 'section' : 'label');
      row.className = 'file-preview-word-block' + (data.notebook ? ' notebook' : '');
      const input = document.createElement('textarea');
      input.value = data.text; input.rows = 1;
      const block = { ...data, original: data.text, input, row, mode: 'edit' };
      if (data.locked) {
        input.readOnly = true;
        row.classList.add('locked');
        input.title = t('This paragraph contains a picture or page break and is read-only.');
      } else if (file.wordFormat === 'doc') {
        // The legacy preview is Word's own rendering, so the editor rows must
        // say which part of that page they change. They are not a paginated
        // WYSIWYG editor.
        row.title = t('Text only. Pictures and page breaks are shown in Preview and are not edited here.');
      }
      input.setAttribute('aria-label', t('Paragraph ') + (data.index + 1) + (data.locked ? ', ' + t('read-only') : ''));
      input.addEventListener('input', () => {
        fitInput(input);
        editor.error = '';
        updateWordEditor(editor);
      });
      if (!data.notebook) {
        row.appendChild(input);
        return block;
      }
      const bar = document.createElement('div'); bar.className = 'file-preview-word-cell-bar';
      const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'file-preview-word-cell-grip';
      grip.innerHTML = '<span aria-hidden="true">↕</span>';
      grip.title = t('Drag to reorder. Arrow keys also move this cell.');
      grip.setAttribute('aria-label', grip.title);
      grip.draggable = data.canMove;
      const number = document.createElement('span'); number.className = 'file-preview-word-cell-number';
      number.textContent = String(data.index + 1);
      const cellActions = document.createElement('div'); cellActions.className = 'file-preview-word-cell-actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.dataset.i18n = ''; edit.textContent = t('Edit');
      const previewCell = document.createElement('button'); previewCell.type = 'button'; previewCell.dataset.i18n = ''; previewCell.textContent = t('Preview');
      const insert = document.createElement('button'); insert.type = 'button'; insert.dataset.i18n = ''; insert.textContent = t('New same format');
      cellActions.append(edit, previewCell, insert);
      bar.append(grip, number, cellActions);
      const previewPane = document.createElement('div'); previewPane.className = 'file-preview-word-cell-preview'; previewPane.hidden = true;
      row.append(bar, input, previewPane);
      Object.assign(block, { grip, number, edit, previewCell, insert, previewPane });
      edit.onclick = () => {
        setWordCellMode(block, 'edit');
        updateWordEditor(editor);
        fitInput(input);
        input.focus();
      };
      previewCell.onclick = () => void previewWordCell(editor, block);
      insert.onclick = () => void insertWordCell(editor, block);
      grip.addEventListener('dragstart', event => {
        if (!block.canMove || editor.structurePending || editor.cellPreviewPending) { event.preventDefault(); return; }
        editor.dragging = block;
        event.dataTransfer?.setData('application/x-camellia-word-cell', String(block.index));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      grip.addEventListener('dragend', () => {
        editor.dragging = null;
        clearWordDropIndicators(editor);
      });
      grip.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const siblings = editor.blocks.filter(candidate => candidate.parent === block.parent);
        const position = siblings.indexOf(block);
        const target = siblings[position + (event.key === 'ArrowUp' ? -1 : 1)];
        if (!target) return;
        event.preventDefault();
        void moveWordCell(editor, block, target, event.key === 'ArrowUp' ? 'before' : 'after');
      });
      row.addEventListener('dragover', event => {
        const source = editor.dragging;
        if (!source || source === block || !source.canMove || source.parent !== block.parent) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
        row.classList.toggle('drop-before', !after);
        row.classList.toggle('drop-after', after);
      });
      row.addEventListener('dragleave', event => {
        if (row.contains(event.relatedTarget)) return;
        row.classList.remove('drop-before', 'drop-after');
      });
      row.addEventListener('drop', event => {
        const source = editor.dragging;
        if (!source || source === block || source.parent !== block.parent) return;
        event.preventDefault();
        const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
        editor.dragging = null;
        clearWordDropIndicators(editor);
        void moveWordCell(editor, source, block, after ? 'after' : 'before');
      });
      return block;
    };
    for (const data of blocks) {
      const block = editor.createBlock(data);
      editor.blocks.push(block);
      list.appendChild(block.row);
    }
    if (file.officeTruncated) {
      const note = document.createElement('p'); note.dataset.i18n = ''; note.className = 'file-preview-notice';
      note.textContent = 'Only the first 2,000 paragraphs can be edited here.'; list.appendChild(note);
    }
    panel.append(toolbar, list);
    editButton.hidden = true;
    body.replaceChildren(panel);
    // The first measurement needs layout, and a webfont may still be loading;
    // both would otherwise leave the initial height at one row.
    requestAnimationFrame(fitAll);
    if (root.defaultView?.ResizeObserver) {
      let lastWidth = 0;
      editor.resizeObserver = new root.defaultView.ResizeObserver(entries => {
        const width = entries[0]?.contentRect.width || 0;
        if (Math.abs(width - lastWidth) < 1) return;
        lastWidth = width;
        requestAnimationFrame(fitAll);
      });
      editor.resizeObserver.observe(list);
    }
    document.fonts?.ready.then(() => { if (wordEditor === editor) fitAll(); }).catch(() => {});
    wordPreviewClosers.add(closeFilePreview);
    save.onclick = () => void saveWordEdit(editor);
    preview.onclick = async () => {
      if (!await finishWordEdit()) return;
      await openFilePreview(file.path, previewLocation);
      if (!editButton.hidden) editButton.focus();
    };
    updateWordEditor(editor);
    editor.blocks[0]?.input.focus();
  }
  async function showRenderedPreview() {
    if (wordEditor) {
      const path = wordEditor.file.path;
      if (!await finishWordEdit()) return;
      await openFilePreview(path, previewLocation);
      if (!editButton.hidden) editButton.focus();
      return;
    }
    const editor = textEditor;
    if (!editor || !await finishTextEdit()) return;
    if (editor.discarded) await openFilePreview(editor.file.path, previewLocation);
    else renderSavedPreview();
    if (!editButton.hidden) editButton.focus();
  }
  async function startTextEdit() {
    if (editButton.hidden || editButton.disabled || textEditor) return;
    const request = previewRequest, file = previewedFile;
    editButton.disabled = true;
    let monaco;
    try {
      monaco = await loadTextPreviewMonaco(root);
    } catch {
      if (request === previewRequest) setStatus(t('Could not load the text editor.'));
      return;
    } finally {
      if (request === previewRequest) editButton.disabled = false;
    }
    if (request !== previewRequest || fileViewer.hidden) return;
    const host = document.createElement('div'); host.className = 'file-preview-editor-input';
    const panel = document.createElement('div'); panel.className = 'file-preview-editor';
    const toolbar = document.createElement('div'); toolbar.className = 'file-preview-editor-toolbar';
    const status = document.createElement('div'); status.className = 'file-preview-editor-status'; status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'file-preview-editor-actions';
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'btn-primary';
    preview.dataset.i18n = ''; preview.textContent = 'Preview'; preview.onclick = () => void showRenderedPreview();
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-secondary';
    save.dataset.i18n = ''; save.textContent = 'Save';
    save.setAttribute('aria-keyshortcuts', window.dshDesktop.platform === 'darwin' ? 'Meta+S' : 'Control+S');
    actions.append(save, preview); toolbar.append(status, actions); panel.append(toolbar, host);
    editButton.hidden = true;
    body.replaceChildren(panel);
    body.scrollTop = 0;
    let model, input;
    try {
      model = monaco.editor.createModel(file.text.replace(/^\uFEFF/, ''), textPreviewLanguage(monaco, file));
      input = monaco.editor.create(host, {
        model, theme: textPreviewTheme(), ariaLabel: t('File contents'), automaticLayout: true,
        minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false, links: false,
        fontSize: 13, padding: { top: 12, bottom: 12 }, stickyScroll: { enabled: false },
      });
    } catch {
      model?.dispose();
      renderSavedPreview();
      setStatus(t('Could not load the text editor.'));
      editButton.focus();
      return;
    }
    const themePreference = matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => monaco.editor.setTheme(textPreviewTheme());
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    themePreference.addEventListener('change', updateTheme);
    const editor = textEditor = { file, input, model, savedVersion: model.getAlternativeVersionId(), status, save, preview,
      dispose() {
        themeObserver.disconnect();
        themePreference.removeEventListener('change', updateTheme);
        input.dispose();
        model.dispose();
      } };
    textPreviewClosers.add(closeFilePreview);
    save.onclick = () => void flushTextEdit(editor);
    input.onDidChangeModelContent(() => scheduleTextSave(editor));
    input.onDidCompositionStart(() => { editor.composing = true; scheduleTextSave(editor); });
    input.onDidCompositionEnd(() => { editor.composing = false; scheduleTextSave(editor); });
    updateEditor(editor);
    const lineNumber = Math.min(previewLocation.line || 1, model.getLineCount());
    input.setPosition({ lineNumber, column: 1 });
    input.revealLineInCenterIfOutsideViewport(lineNumber);
    input.focus();
  }
  async function openFilePreview(filePath, location = {}) {
    if (!filePath) return;
    if (wordEditor) {
      const editing = wordEditor;
      if (!await finishWordEdit()) return;
      if (editing.file.path === filePath) {
        previewLocation = location;
        renderSavedPreview();
        return;
      }
    }
    if (textEditor) {
      if (!await finishTextEdit()) return;
      renderSavedPreview();
    }
    beforeOpen();
    fileViewer.dataset.mode = 'preview';
    $('fileViewerReveal').hidden = false;
    $('fileViewerExternal').hidden = false;
    editButton.disabled = true;
    const request = ++previewRequest;
    let result;
    try { result = await window.dshDesktop.previewFile(filePath); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (request !== previewRequest) return;
    editButton.disabled = false;
    if (!result?.ok) {
      previewedFile = { path: filePath, name: String(filePath).split(/[\\/]/).pop(), kind: 'unsupported' };
      $('fileViewerTitle').textContent = previewedFile.name;
      $('fileViewerType').textContent = window.CamelliaI18n.t('Preview');
      $('fileViewerMeta').textContent = filePath;
      editButton.hidden = true;
      fileViewer.hidden = false;
      renderUnsupportedPreview(result?.error || t('The file could not be opened.'));
      return;
    }
    if (result.file.kind === 'directory') {
      await openPreviewExternally(result.file.path);
      return;
    }
    previewLocation = location;
    renderFilePreview(result.file);
    await markdownRender?.done;
    if (request !== previewRequest) return;
    focusWhenRendered(location);
  }
  async function openPreviewExternally(filePath = previewedFile?.path) {
    if (!filePath) return;
    try {
      const result = await window.dshDesktop.openFileExternally(filePath);
      if (!result.ok) setStatus(result.error || 'Could not open the file.');
    } catch (error) { setStatus(error.message); }
  }
  async function revealFile(filePath) {
    if (!filePath) return;
    try {
      const result = await window.dshDesktop.revealFile(filePath);
      if (!result.ok) setStatus(result.error || 'Could not open the file.');
    } catch (error) { setStatus(error.message); }
  }
  // The file manager has a different name and gesture on each desktop, so the
  // menu label follows the host platform instead of using one generic wording.
  function revealLabel() {
    const platform = window.dshDesktop.platform;
    if (platform === 'darwin') return 'Reveal in Finder';
    if (platform === 'win32') return 'Show in File Explorer';
    if (platform === 'linux') return 'Show in file manager';
    return 'Show in folder';
  }
  async function closeFilePreview() {
    if (wordEditor && !await finishWordEdit()) return false;
    if (textEditor && !await finishTextEdit()) return false;
    previewRequest++;
    markdownRender?.controller?.abort();
    markdownRender = null;
    finishPreviewResize();
    fileViewer.hidden = true;
    editButton.hidden = true;
    body.replaceChildren();
    previewedFile = null;
    wordEditor?.resizeObserver?.disconnect();
    wordEditor = null;
    onClose();
    return true;
  }
  editButton.onclick = async () => {
    const file = previewedFile;
    if (!file) return;
    if (file.wordEditToken && (file.kind === 'word' || file.kind === 'document')) {
      // Word's paragraph list is exact but starts a hidden Word process, so
      // legacy .doc fetches it only when the user asks to edit.
      if (file.wordFormat === 'doc') {
        if (typeof window.dshDesktop.previewWordParagraphs !== 'function') {
          setPreviewMessage(t('Camellia needs to be restarted once to enable Word editing. Quit and reopen the app.'));
          return;
        }
        editButton.disabled = true;
        // Word takes 10-20 seconds here. The preview shows why nothing has
        // happened yet instead of looking like a dead button.
        setPreviewMessage(t('Opening the document in Word… this can take a few seconds.'));
        setStatus(t('Opening the document for editing…'));
        try {
          const exact = await window.dshDesktop.previewWordParagraphs(file.wordEditToken);
          if (!exact?.ok) throw new Error(exact?.error || 'Could not read the Word paragraphs.');
          file.paragraphs = exact.paragraphs;
          file.paragraphEditability = exact.editable;
        } catch (error) {
          const message = t('Could not open the editor: ') + (error?.message || error);
          setPreviewMessage(message);
          setStatus(message);
          return;
        }
        finally { editButton.disabled = false; }
      }
      showWordEditor();
      return;
    }
    void startTextEdit();
  };
  $('fileViewerClose').onclick = () => void closeFilePreview();
  $('fileViewerExternal').onclick = () => void openPreviewExternally();
  $('fileViewerReveal').title = revealLabel();
  $('fileViewerReveal').setAttribute('aria-label', revealLabel());
  $('fileViewerReveal').onclick = () => void revealFile(previewedFile?.path);
  window.addEventListener('camellia:language', () => {
    if (previewedFile) updatePreviewMeta(previewedFile);
    if (textEditor) {
      textEditor.input.updateOptions({ ariaLabel: t('File contents') });
      updateEditor(textEditor);
    }
    if (wordEditor) {
      for (const block of wordEditor.blocks) block.input.setAttribute('aria-label', t('Paragraph ') + (block.index + 1));
      updateWordEditor(wordEditor);
    }
  });
  fileViewer.addEventListener('keydown', event => {
    const editor = textEditor || wordEditor;
    if (!editor || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    event.stopPropagation();
    if (!editor.leaving) void (textEditor ? flushTextEdit(textEditor) : saveWordEdit(wordEditor));
  }, true);
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || fileViewer.hidden || root.querySelector('dialog[open]')) return;
    if (textEditor || wordEditor) { event.preventDefault(); void showRenderedPreview(); }
    else void closeFilePreview();
  });

  return { openFilePreview, closeFilePreview, openPreviewExternally, revealFile, revealLabel, formatFileSize, attachmentDragType };
} };
