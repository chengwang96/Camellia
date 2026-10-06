'use strict';
window.CamelliaFilePreview = { create({ fileViewer, inputCard, mdRender, setStatus, finishPreviewResize = () => {}, root = document }) {
  const $ = id => root.getElementById(id);
  let previewedFile = null;
  let previewRequest = 0;
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
    $('fileViewerTitle').textContent = file.name;
    $('fileViewerTitle').title = file.path;
    $('fileViewerType').textContent = previewLabel(file);
    $('fileViewerMeta').textContent = [formatFileSize(file.size), file.path].filter(Boolean).join('  ·  ');
    const body = $('fileViewerBody');
    body.replaceChildren();
    if (file.kind === 'text') {
      const format = window.CamelliaArtifacts.documentFormat(file);
      if (format === 'html') {
        body.appendChild(window.CamelliaHtmlPreview.render(file));
      } else if (format === 'markdown') {
        const article = document.createElement('article'); article.className = 'file-preview-markdown md';
        article.setAttribute('translate', 'no'); article.innerHTML = mdRender(file.text || '', true, file.url);
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
          select.setAttribute('aria-label', 'Worksheet / 工作表'); select.className = 'office-sheet-select';
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
  function focusPreviewLocation({ line = 0, anchor = '' } = {}) {
    const body = $('fileViewerBody');
    if (line) {
      const candidates = [...body.querySelectorAll('[data-preview-line]')]
        .filter(node => Number(node.dataset.previewLine) <= line && Number(node.dataset.previewEndLine) >= line)
        .sort((a, b) => Number(b.dataset.previewLine) - Number(a.dataset.previewLine));
      if (candidates.length) candidates[0].scrollIntoView({ block: 'center' });
      else {
        const text = body.querySelector('.file-preview-text')?.firstChild;
        if (text) {
          let offset = 0;
          for (let current = 1; current < line; current++) {
            const end = text.textContent.indexOf('\n', offset);
            if (end < 0) break;
            offset = end + 1;
          }
          const range = document.createRange();
          range.setStart(text, offset); range.setEnd(text, Math.min(offset + 1, text.length));
          body.scrollTop += range.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2;
        }
      }
      $('fileViewerMeta').textContent += ':' + line;
    } else if (anchor) [...body.querySelectorAll('[data-preview-anchor], [id]')]
      .find(node => node.dataset.previewAnchor === anchor || node.id === anchor)?.scrollIntoView({ block: 'start' });
  }
  async function openFilePreview(filePath, location = {}) {
    if (!filePath) return;
    const request = ++previewRequest;
    let result;
    try { result = await window.dshDesktop.previewFile(filePath); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (request !== previewRequest) return;
    if (!result.ok) {
      previewedFile = { path: filePath, name: String(filePath).split(/[\\/]/).pop(), kind: 'unsupported' };
      $('fileViewerTitle').textContent = previewedFile.name;
      $('fileViewerType').textContent = window.CamelliaI18n.t('Preview');
      $('fileViewerMeta').textContent = filePath;
      fileViewer.hidden = false;
      renderUnsupportedPreview(result.error || window.CamelliaI18n.t('The file could not be opened.'));
      return;
    }
    if (result.file.kind === 'directory') {
      await openPreviewExternally(result.file.path);
      return;
    }
    renderFilePreview(result.file);
    focusPreviewLocation(location);
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
  function closeFilePreview() {
    previewRequest++;
    finishPreviewResize();
    fileViewer.hidden = true;
    $('fileViewerBody').replaceChildren();
    previewedFile = null;
  }
  $('fileViewerClose').onclick = closeFilePreview;
  $('fileViewerExternal').onclick = () => void openPreviewExternally();
  $('fileViewerReveal').title = revealLabel();
  $('fileViewerReveal').setAttribute('aria-label', revealLabel());
  $('fileViewerReveal').onclick = () => void revealFile(previewedFile?.path);
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && !fileViewer.hidden) closeFilePreview(); });

  return { openFilePreview, closeFilePreview, openPreviewExternally, revealFile, revealLabel, formatFileSize, attachmentDragType };
} };
