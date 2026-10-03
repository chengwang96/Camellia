'use strict';
window.CamelliaDiscussionRich = { create({ getGroup, call, mutate, getAttachments, setAttachments, changed, error, root = document, isVisible = () => true }) {
  const $ = id => root.getElementById(id), t = text => window.CamelliaI18n.t(text), desktop = window.dshDesktop;
  const controls = window.CamelliaChatControls, cards = new Map(), artifacts = new Map(), questionDrafts = new Map();
  const preview = window.CamelliaFilePreview.create({ root, fileViewer: $('fileViewer'), inputCard: $('inputCard'), setStatus: text => error(new Error(text)),
    mdRender: (text, _documentMode, baseUrl) => window.CamelliaMarkdownPreview.render(text, { baseUrl, sourceLines: true }) });
  let uploading = false, pending = null, fields = [], answering = false, deferred = null;
  const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className || ''; if (text !== undefined) el.textContent = text; return el; };
  const action = (label, run, className = 'btn-secondary') => { const b = node('button', className, t(label)); b.type = 'button'; b.onclick = () => Promise.resolve(run()).catch(error); return b; };
  async function openToolFile(filePath) {
    const result = await desktop.resolveArtifacts({ paths: [filePath], cwd: getGroup()?.cwd });
    return preview.openFilePreview(result.files?.[0]?.path || filePath);
  }
  function attachments(row, files, removable = false) {
    controls.renderAttachments(row, files, { preview: preview.openFilePreview, ...(removable ? { remove: index => { const next = [...getAttachments()]; next.splice(index, 1); setAttachments(next); changed(); render(); } } : {}) });
  }
  async function importFiles(paths, groupId = getGroup()?.id) {
    const group = getGroup(); if (!group || !paths.length || uploading) return;
    if (groupId !== group.id) throw new Error(t('Discussion changed. Add attachments again.'));
    uploading = true; changed();
    try {
      if (getAttachments().length + paths.length > 16) throw new Error(t('Choose at most 16 attachments.'));
      const result = await call('import-attachments', { id: group.id, paths });
      if (getGroup()?.id !== group.id) throw new Error(t('Discussion changed. Add attachments again.'));
      setAttachments([...getAttachments(), ...result.attachments]); changed(); render();
    } finally { uploading = false; changed(); }
  }
  $('attachFiles').onclick = async () => { const groupId = getGroup()?.id; try { const result = await desktop.pickAttachments(); if (!result.canceled) await importFiles(result.paths, groupId); } catch (err) { error(err); } };
  $('inputCard').addEventListener('dragover', event => { event.preventDefault(); $('inputCard').classList.add('dragging'); });
  $('inputCard').addEventListener('dragleave', () => $('inputCard').classList.remove('dragging'));
  root.addEventListener('dragover', event => event.preventDefault());
  root.addEventListener('drop', event => {
    event.preventDefault(); $('inputCard').classList.remove('dragging');
    try { const local = event.dataTransfer.getData('application/x-camellia-attachment-path');
      void importFiles(local ? [local] : [...event.dataTransfer.files].map(f => desktop.attachmentPath(f)).filter(Boolean)).catch(error);
    } catch (err) { error(err); }
  });
  $('message').addEventListener('paste', async event => {
    const groupId = getGroup()?.id;
    const files = [...(event.clipboardData?.files || [])], text = event.clipboardData?.getData('text/plain') || '';
    if (!files.length && !window.CamelliaLongPaste.shouldAttach(text)) return;
    event.preventDefault();
    try {
      const paths = [];
      for (const file of files) {
        let path; try { path = desktop.attachmentPath(file); } catch { /* pasted bitmap */ }
        if (!path && file.type.startsWith('image/')) {
          const result = await desktop.saveClipboardImage({ type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
          if (!result.ok) throw new Error(result.error); path = result.attachment.path;
        }
        if (!path) throw new Error(t('Could not attach the pasted file.')); paths.push(path);
      }
      if (!files.length) { const result = await desktop.savePastedText({ text }); if (!result.ok) throw new Error(result.error); paths.push(result.attachment.path); }
      await importFiles(paths, groupId);
    } catch (err) { error(err); }
  });
  $('groupWorkspace').onclick = () => void preview.openPreviewExternally(getGroup()?.cwd);
  $('groupPermission').onchange = () => void mutate('set-permission', { permissionMode: $('groupPermission').value }).catch(error).finally(render);
  function renderTools(item, delivery) {
    if (!delivery) return;
    let process = item.querySelector('.discussion-tools');
    if (!process) { process = node('div', 'discussion-tools'); item.querySelector('.message-header').after(process); }
    process.replaceChildren();
    for (const tool of delivery.tools || []) {
      const key = delivery.id + ':' + tool.id;
      let card = cards.get(key);
      if (!card) { card = controls.makeToolCard(tool.name, tool.input, path => void openToolFile(path).catch(error)); cards.set(key, card); }
      card.setInput(tool.input);
      if (['completed', 'failed', 'interrupted'].includes(tool.status)) card.setOutput(tool.output, tool.status !== 'completed');
      else card.outputEl.textContent = tool.output || t('Waiting for result…');
      card.stateEl.title = t(tool.status === 'completed' ? 'Finished' : tool.status === 'failed' ? 'Failed' : tool.status === 'interrupted' ? 'Interrupted' : 'Running');
      card.stateEl.setAttribute('aria-label', card.stateEl.title);
      process.append(card.el);
      if (tool.permissionBlocked) process.append(node('p', 'discussion-tool-notice', t('Antigravity subscription cannot ask for approval in this connection. Review the group permission setting, then retry.')));
    }
    for (const permission of getGroup()?.permissions || []) if (permission.deliveryId === delivery.id) {
      process.append(action(permission.questions?.length ? 'Answer questions' : 'Review permission', () => { deferred = null; showPermission(permission); }));
    }
    if (delivery.status !== 'completed') return;
    const group = getGroup(), artifactKey = group.id + ':' + delivery.id;
    let state = artifacts.get(artifactKey);
    if (state) { state.item = item; artifactRow(state); return; }
    // Plain replies have no generated files to resolve. In particular, opening
    // text history must not make a new rich-interaction request to an older app.
    const text = group.messages.find(message => message.deliveryId === delivery.id)?.text || '';
    if (!window.CamelliaArtifacts.textPaths(text).length
      && !(delivery.tools || []).some(tool => tool.status === 'completed' && /write|edit|create|save|output|export|patch/i.test(tool.name))) return;
    state = { item, groupId: group.id, deliveryId: delivery.id, files: [], error: null, loading: false };
    artifacts.set(artifactKey, state);
    void loadArtifacts(state);
  }
  async function loadArtifacts(state) {
    if (state.loading || getGroup()?.id !== state.groupId) return;
    state.loading = true; artifactRow(state);
    try {
      const result = await call('artifacts', { id: state.groupId, deliveryId: state.deliveryId });
      state.files = result.files || []; state.error = null;
    } catch (err) { state.error = err; }
    finally { state.loading = false; artifactRow(state); }
  }
  function artifactRow(state) {
    let row = state.item.querySelector('.discussion-artifacts');
    if (!row) { row = node('div'); state.item.append(row); }
    row.className = 'discussion-artifacts ' + (state.error ? 'discussion-artifact-error' : 'attach-row');
    if (state.error) {
      row.hidden = false; row.setAttribute('role', 'alert');
      const retry = action('Reload files', () => loadArtifacts(state)); retry.disabled = state.loading;
      row.replaceChildren(node('p', '', t('Could not load generated files.') + ' ' + t(state.error.message)), retry);
    } else { row.removeAttribute('role'); attachments(row, state.files); }
  }
  const key = request => request && [request.deliveryId, request.runId, request.requestId].join(':');
  function showPermission(request) {
    pending = request;
    const group = getGroup(), member = group.participants.find(p => p.id === request.participantId);
    $('permissionMember').textContent = (member?.name || '') + ' · ' + (request.toolName || '');
    $('permissionReason').textContent = request.reason || '';
    $('permissionDetail').textContent = request.input ? typeof request.input.command === 'string' ? request.input.command : JSON.stringify(request.input, null, 2) : '';
    fields = controls.questionFields($('permissionQuestions'), request.questions || [], {
      saved: questionDrafts.get(key(request)) || {},
      changed: fields => questionDrafts.set(key(request), Object.fromEntries(fields.filter(f => !f.question.isSecret).map(f =>
        [f.question.id, { selected: f.choices.filter(c => c.checked).map(c => c.value), custom: f.custom.value }]))),
    });
    $('permissionError').textContent = ''; $('permissionActions').replaceChildren();
    $('permissionActions').append(action('Answer later', () => { deferred = key(request); $('discussionPermission').close(); }));
    if (request.questions?.length) {
      $('permissionActions').append(action('Skip questions', () => answer(false), 'perm-deny'), action('Submit answers', () => answer(true), 'perm-allow'));
    } else if (request.options?.length) for (const option of request.options) {
      $('permissionActions').append(action(option.name, () => answer(option.kind.startsWith('allow'), option.optionId), option.kind.startsWith('allow') ? 'perm-allow' : 'perm-deny'));
    } else $('permissionActions').append(action('Deny', () => answer(false), 'perm-deny'), action('Allow', () => answer(true), 'perm-allow'));
    if (!$('discussionPermission').open) $('discussionPermission').showModal();
  }
  async function answer(allow, optionId) {
    if (!pending || answering) return;
    let input;
    if (allow && fields.length) {
      input = Object.fromEntries(fields.map(({ question, choices, custom }) => {
        const values = [...choices.filter(c => c.checked).map(c => c.value), ...(custom.value.trim() ? [custom.value.trim()] : [])];
        return [question.id, question.multiSelect ? values : values[0] || ''];
      }));
      if (Object.values(input).some(v => !v.length)) { $('permissionError').textContent = t('Answer each question before submitting'); return; }
    }
    const request = pending, group = getGroup(); answering = true;
    $('permissionActions').querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      await mutate('permission-response', { deliveryId: request.deliveryId, requestId: request.requestId, runId: request.runId, allow, input, optionId });
      questionDrafts.delete(key(request));
      if (getGroup()?.id === group.id && key(pending) === key(request)) { pending = null; $('discussionPermission').close(); }
    } catch (err) { $('permissionError').textContent = t(err.message); }
    finally { answering = false; $('permissionActions').querySelectorAll('button').forEach(b => b.disabled = false); render(); }
  }
  $('discussionPermissionForm').onsubmit = event => { event.preventDefault(); void answer(true); };
  $('discussionPermission').addEventListener('cancel', event => { if (answering) event.preventDefault(); else deferred = key(pending); });
  function render() {
    const group = getGroup();
    if (!group) { $('discussionPermission').close(); pending = null; return; }
    attachments($('attachRow'), getAttachments(), true);
    $('attachFiles').disabled = uploading;
    $('groupWorkspace').title = group.cwd || ''; $('groupPermission').value = group.permissionMode || 'ask';
    $('groupPermission').disabled = group.verifying || group.deliveries.some(d => ['queued', 'preparing', 'running', 'stopping'].includes(d.status));
    if (pending && !group.permissions?.some(p => key(p) === key(pending))) { $('discussionPermission').close(); pending = null; }
    const next = group.permissions?.[0];
    if (isVisible() && next && key(next) !== key(pending) && key(next) !== deferred && !answering) showPermission(next);
  }
  $('messages').addEventListener('click', event => {
    const link = event.target.closest('a'); if (!link) return;
    const href = link.getAttribute('href') || ''; if (/^https?:/i.test(href) || href.startsWith('#')) return;
    event.preventDefault();
    void desktop.resolveArtifacts({ paths: [href], cwd: getGroup()?.cwd }).then(result => {
      if (result.files?.length) return preview.openFilePreview(result.files[0].path);
    }).catch(error);
  });
  // Keep the normal resizable preview layout; the preference is shared.
  let drag = null;
  $('fileViewerResize').onpointerdown = event => { if (event.button !== 0) return; drag = { x: event.clientX, width: $('fileViewer').getBoundingClientRect().width }; $('fileViewerResize').setPointerCapture(event.pointerId); };
  $('fileViewerResize').onpointermove = event => { if (drag) $('fileViewer').style.setProperty('--file-viewer-width', Math.max(260, Math.min(innerWidth - 40, drag.width + drag.x - event.clientX)) + 'px'); };
  $('fileViewerResize').onpointerup = $('fileViewerResize').onpointercancel = () => { drag = null; };
  return { render, renderTools, attachments, suspend() { pending = null; $('discussionPermission').close(); preview.closeFilePreview(); }, get uploading() { return uploading; } };
} };
