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
    if (!inputData || typeof inputData !== 'object') return '';
    const c = inputData.command || inputData.CommandLine || inputData.file_path || inputData.TargetFile || inputData.AbsolutePath || inputData.pattern || inputData.path || inputData.description || '';
    if (!c) return '';
    const line = String(c).split('\n')[0];
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
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
        if (data && data.command) {
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
        this.outputEl.textContent = text || "(No output)";
        this.outputEl.classList.toggle('err', !!isErr);
        this.stateEl.className = 'tool-state ' + (isErr ? 'err' : 'done');
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

  function renderAttachments(row, files, { preview, remove } = {}) {
    row.replaceChildren(); row.classList.toggle('has', files.length > 0);
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
      row.append(chip);
    }
  }
  function questionFields(container, questions, { saved = {}, changed = () => {} } = {}) {
    const fields = []; container.replaceChildren();
    for (const [index, question] of questions.entries()) {
      const field = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = question.question; field.append(legend);
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
      const custom = document.createElement('input'); custom.type = question.isSecret ? 'password' : 'text'; custom.autocomplete = 'off'; custom.value = question.isSecret ? '' : saved[question.id]?.custom || '';
      customLabel.append(customTitle, custom); field.append(customLabel); container.append(field);
      fields.push({ question, choices, custom });
      custom.oninput = () => { if (!question.multiSelect && custom.value) choices.forEach(choice => choice.checked = false); changed(fields); };
      choices.forEach(choice => { choice.onchange = () => { if (!question.multiSelect) custom.value = ''; changed(fields); }; });
    }
    return fields;
  }
  window.CamelliaChatControls = { isImagePath, attachmentGlyph, fileUrl, makeToolCard, renderAttachments, questionFields };
})();
