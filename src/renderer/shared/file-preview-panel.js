'use strict';
const TEXT_PREVIEW_AUTOSAVE_MS = 1000;
const monacoBase = new URL('../../../node_modules/monaco-editor/min/vs/', document.currentScript.src);
const monacoStyles = new WeakMap();
let monacoLoading;
const textPreviewClosers = new Set();
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
    for (const close of textPreviewClosers) if (!await close()) return false;
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
    $('fileViewerMeta').textContent = [formatFileSize(file.size), file.path && file.path + location].filter(Boolean).join('  ·  ');
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
  function renderFilePreview(file) {
    previewedFile = file;
    fileViewer.dataset.mode = 'preview';
    $('fileViewerReveal').hidden = false;
    $('fileViewerExternal').hidden = false;
    editButton.hidden = file.kind !== 'text' || file.truncated || !file.editToken;
    $('fileViewerTitle').textContent = file.name;
    $('fileViewerType').textContent = previewLabel(file);
    updatePreviewMeta(file);
    body.replaceChildren();
    if (file.kind === 'text') {
      const format = window.CamelliaArtifacts.documentFormat(file);
      if (format === 'html') {
        body.appendChild(window.CamelliaHtmlPreview.render(file));
      } else if (format === 'markdown') {
        const article = document.createElement('article'); article.className = 'file-preview-markdown md';
        article.setAttribute('translate', 'no'); article.innerHTML = mdRender((file.text || '').replace(/^\uFEFF/, ''), true, file.url);
        article.addEventListener('click', event => {
          const link = event.target.closest('a');
          if (!link) return;
          event.preventDefault();
          if (link.dataset.previewBlocked) return;
          const href = link.getAttribute('href');
          if (href.startsWith('#')) {
            let anchor;
            try { anchor = decodeURIComponent(href.slice(1)); } catch { return; }
            [...article.querySelectorAll('[data-preview-anchor], [id]')].find(target => target.dataset.previewAnchor === anchor || target.id === anchor)?.scrollIntoView({ block: 'start' });
          } else if (/^https?:/.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
          else if (href.startsWith('file:')) {
            try {
              const url = new URL(href);
              const path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
              void openFilePreview(path);
            } catch {}
          }
        });
        body.appendChild(article);
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
      const notice = document.createElement('p'); notice.className = 'office-preview-notice';
      notice.dataset.i18n = ''; notice.textContent = 'Document preview · Complex layouts may differ from the original.';
      stage.appendChild(notice);
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
    } else if (anchor) [...body.querySelectorAll('[data-preview-anchor], [id]')]
      .find(node => node.dataset.previewAnchor === anchor || node.id === anchor)?.scrollIntoView({ block: 'start' });
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
    focusPreviewLocation(previewLocation);
  }
  async function showRenderedPreview() {
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
    focusPreviewLocation(previewLocation);
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
    if (textEditor && !await finishTextEdit()) return false;
    previewRequest++;
    finishPreviewResize();
    fileViewer.hidden = true;
    editButton.hidden = true;
    body.replaceChildren();
    previewedFile = null;
    onClose();
    return true;
  }
  editButton.onclick = startTextEdit;
  $('fileViewerClose').onclick = () => void closeFilePreview();
  $('fileViewerExternal').onclick = () => void openPreviewExternally();
  $('fileViewerReveal').title = revealLabel();
  $('fileViewerReveal').setAttribute('aria-label', revealLabel());
  $('fileViewerReveal').onclick = () => void revealFile(previewedFile?.path);
  window.addEventListener('camellia:language', () => {
    if (!textEditor) return;
    textEditor.input.updateOptions({ ariaLabel: t('File contents') });
    updateEditor(textEditor);
  });
  fileViewer.addEventListener('keydown', event => {
    if (!textEditor || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    event.stopPropagation();
    if (!textEditor.leaving) void flushTextEdit(textEditor);
  }, true);
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || fileViewer.hidden || root.querySelector('dialog[open]')) return;
    if (textEditor) { event.preventDefault(); void showRenderedPreview(); }
    else void closeFilePreview();
  });

  return { openFilePreview, closeFilePreview, openPreviewExternally, revealFile, revealLabel, formatFileSize, attachmentDragType };
} };
