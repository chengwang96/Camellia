'use strict';

const $ = (id) => document.getElementById(id);
const context = { sessionId: null, workspaceId: null };
  const chat = $('chat');
  const emptyStateTemplate = $('emptyState').cloneNode(true);
  const chatScroll = $('chatScroll');
  const inputCard = $('inputCard');
  const input = $('input');
  const sendBtn = $('send');
  const statusLine = $('statusLine');


  let running = false;
  let conversationActivity = null;
  let currentRunId = null;
  let acceptSessionEvents = false;
  let restoringRun = sharedChat || harnessId !== 'claude';
  let switchingEngine = false;
  let conversationPrefs = { mode: 'direct', warnOnSwitch: false, showOrigin: false };
  let loadedEngine = harnessId;
  const eventsDuringRestore = [];
  let turnEl = null;          // current assistant turn container
  let blocks = {};            // stream block index -> { type, raw, el, ... }
  let pendingTools = {};      // tool_use_id -> card handle
  let runStartedAt = 0;
  let runTimer = null;
  let lastUsage = null;       // usage object from the last result event
  let attachments = [];       // [{ path, name, isImage }]
  let openPops = [];          // currently open popover elements
  let runAnchorMs = 0;        // timestamp of message_start (drives the 15s clock)
  let statusClockTimer = null;
  let todoItems = null;       // latest task snapshot: [{ content, status, activeForm }]
  let todoPanelEl = null;

  let sessionOpenSeq = 0;
  let loadingSession = false;
  let editingMessage = null;
  let permRequestId = null;   // pending can_use_tool control request id
  const permissionQueue = [];
  let pendingQuestion = null, permissionSubmission = null;
  const questionDrafts = new Map();

  // Offline defaults; a configured pool supplies its explicit model groups.
  const MODELS = [{ id: '', label: "Select model" }];
  const LEVELS = [
    { id: '', label: 'Default' },
    { id: 'off', label: 'Off' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' },
  ];
  if (harnessId !== 'claude') LEVELS.splice(1);
  let currentModel = '';
  let currentLevel = '';
  // Three universal automation levels; stored native values fold into them.
  function permissionLevel(engine, value) {
    if (['ask', 'auto', 'full'].includes(value)) return value;
    if (value === 'default') return engine === 'dsh' ? 'auto' : 'ask';
    return { plan: 'ask', acceptEdits: 'auto', auto: 'auto', 'workspace-write': 'auto',
      bypassPermissions: 'full', yolo: 'full', 'danger-full-access': 'full' }[value] || 'ask';
  }
  let currentPermission = chatProfile.permission;
  let currentConnection = 'api';
  const accountSubscription = () => ['codex', 'kimi', 'antigravity'].includes(harnessId) && currentConnection === 'subscription';
  const accountName = { codex: 'ChatGPT', kimi: 'Kimi', antigravity: 'Google' }[harnessId];
  let accountModels = [];
  let routeModels = [];
  const googleSubscription = () => harnessId === 'antigravity' && currentConnection === 'subscription';
  let uiReady = false, sending = false, settingsLoadSeq = 0;
  const uiPrefix = 'camellia-chat-';
  const draftKey = (id = context.sessionId, workspace = context.workspaceId) => id || 'new:' + (workspace || 'standalone');
  function readUi(key) {
    try { return JSON.parse(localStorage.getItem(uiPrefix + key)); } catch { return null; }
  }
  function writeUi(key, value) {
    try { localStorage.setItem(uiPrefix + key, JSON.stringify(value)); }
    catch { setStatus('Could not save the draft on this computer. Keep this page open until you copy or send it.'); }
  }
  function saveDraft() {
    if (!sharedChat || !uiReady || loadingSession || sending) return;
    writeUi('draft:' + draftKey(), { text: input.value, attachments, pendingForkId,
      scrollTop: chatScroll.scrollTop, bottom: nearBottom() });
    writeUi('location', { sessionId: context.sessionId, workspaceId: context.workspaceId });
  }
  function restoreDraft() {
    if (!sharedChat) return;
    const saved = readUi('draft:' + draftKey());
    input.value = typeof saved?.text === 'string' ? saved.text : '';
    attachments = Array.isArray(saved?.attachments) ? saved.attachments : [];
    pendingForkId = saved?.pendingForkId || null;
    renderAttachments(); autoResize(); updateSendEnabled();
    chatScroll.scrollTop = saved && !saved.bottom ? Number(saved.scrollTop) || 0 : chatScroll.scrollHeight;
  }
  window.addEventListener('beforeunload', saveDraft);
  let scrollSaveTimer;
  chatScroll.addEventListener('scroll', () => {
    clearTimeout(scrollSaveTimer); scrollSaveTimer = setTimeout(saveDraft, 120);
  });

  const SENT = '\x01'; // escaped SOH sentinel — never appears in prose

  // ---------- helpers ----------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Minimal markdown: fenced code, inline code, bold, headings.
  function mdRender(src) {
    const tokens = [];
    let text = String(src);
    text = text.replace(/```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
      tokens.push({ t: 'code', lang, code });
      return SENT + (tokens.length - 1) + SENT;
    });
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      tokens.push({ t: 'inline', code });
      return SENT + (tokens.length - 1) + SENT;
    });
    text = esc(text);
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/^(#{1,4})\s*(.+)$/gm, '<strong>$2</strong>');
    const sentRe = new RegExp(SENT + '(\\d+)' + SENT, 'g');
    text = text.replace(sentRe, (_m, idx) => {
      const tk = tokens[+idx];
      if (!tk) return _m;
      if (tk.t === 'code') {
        const langAttr = tk.lang ? ' data-lang="' + esc(tk.lang) + '"' : '';
        return '<pre class="md-code"' + langAttr + '><code>' + esc(tk.code.replace(/\n+$/, '')) + '</code></pre>';
      }
      return '<code class="md-inline">' + esc(tk.code) + '</code>';
    });
    return text;
  }

  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }

  function nearBottom() {
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
  }
  function maybeScroll(was) {
    if (was) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function clearEmpty() {
    const e = chat.querySelector('.empty-state');
    if (e) e.remove();
  }

  // ---------- popovers ----------
  function closePops() {
    for (const p of openPops) p.remove();
    openPops = [];
    $('modelPill').classList.remove('open');
  }
  document.addEventListener('mousedown', (e) => {
    if (!openPops.length) return;
    if (openPops.some((p) => p.contains(e.target)) || $('modelPill').contains(e.target) || $('usageDot').contains(e.target)) return;
    closePops();
  });

  function clampPopPosition(pop, preferTop, alignRightOf) {
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = preferTop;
    // Keep the whole popover on screen: prefer the requested anchor, then clamp.
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    if (top < 8) top = 8;
    pop.style.top = top + 'px';
    if (alignRightOf != null) {
      pop.style.left = Math.max(8, Math.min(alignRightOf - w, vw - w - 8)) + 'px';
    }
  }

  function showPop(anchorRect, build, width) {
    const pop = document.createElement('div');
    pop.className = 'dsh-pop';
    pop.style.visibility = 'hidden';
    if (width) pop.style.width = width + 'px';
    build(pop);
    document.body.appendChild(pop);
    const h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(anchorRect.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    clampPopPosition(pop, anchorRect.top - h - 8, null);
    pop.style.visibility = '';
    openPops.push(pop);
    return pop;
  }

  function modelLabel(id) {
    const m = MODELS.find((x) => x.id === id);
    return id ? (m ? m.label : id) : window.CamelliaI18n.t(m?.label || "Default model");
  }
  function levelLabel(id) {
    const l = LEVELS.find((x) => x.id === id);
    return l ? l.label : 'Default';
  }
  window.addEventListener('camellia:language', () => {
    renderModelPill();
    if (!context.sessionId) $('headerTitle').textContent = window.CamelliaI18n.t('New session');
  });
  function renderModelPill() {
    $('modelPillName').textContent = modelLabel(currentModel);
    $('modelPillLevel').textContent = currentLevel ? levelLabel(currentLevel) : '';
  }

  async function persistSettings(patch, message) {
    if (sharedChat && conversationBusy()) return;
    const sessionId = context.sessionId;
    try {
      const result = await chatApi.saveSettings({ ...patch, ...(sharedChat || ['codex', 'antigravity'].includes(harnessId) ? { sessionId: context.sessionId } : {}) });
      if (!result.ok) throw new Error(result.error);
      if (sessionId !== context.sessionId) return;
      if (harnessId !== 'claude' && patch.model !== undefined) LEVELS.splice(1);
      applySessionSettings(result.settings);
      updateCtxRing();
      if (harnessId === 'codex') applyCodexLevels();
      setStatus(message);
    } catch (error) {
      $('selPermission').value = currentPermission;
      setStatus("Could not save settings: " + error.message);
    }
  }
  function persistModel(model) {
    // Picking across groups in a subscription composer selects the other
    // connection for this conversation (or globally on a fresh start page).
    let connection;
    if (accountSubscription() && model && (sharedChat || !context.sessionId)) {
      if (routeModels.includes(model)) connection = 'api';
      else if (accountModels.some(m => m.id === model)) connection = 'subscription';
    }
    return persistSettings({ model, ...(connection ? { connection } : {}), ...(harnessId !== 'claude' ? { thinkingBudget: '' } : {}) },
      "Model changed: " + modelLabel(model) + " (applies to the next message)")
      .then(() => { if (connection) void loadSettings(); });
  }
  function persistLevel(level) {
    return persistSettings({ thinkingBudget: level }, "Reasoning level changed: " + levelLabel(level) + " (applies to the next message)");
  }

  function chevRight() {
    return '<svg class="pop-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
  }
  function checkMark() {
    return '<svg class="pop-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
  }

  function openSubMenu(rowEl, sections, currentId, onPick) {
    // Remove existing sibling submenus first (keep the root menu).
    const root = openPops[0];
    for (const p of openPops.slice(1)) p.remove();
    openPops = openPops.slice(0, 1);
    const rowRect = rowEl.getBoundingClientRect();
    const sub = document.createElement('div');
    sub.className = 'dsh-pop';
    sub.style.minWidth = '220px';
    for (const section of sections) {
      if (section.title) {
        const g = document.createElement('div');
        g.className = 'pop-group'; g.dataset.i18n = '';
        g.textContent = section.title;
        sub.appendChild(g);
      }
      for (const o of section.options) {
        const el = document.createElement('div');
        el.className = 'pop-opt' + (o.id === currentId ? ' current' : '');
        el.innerHTML = '<span></span>' + checkMark();
        el.querySelector('span').textContent = o.label;
        if (section.options === LEVELS || !o.id) el.querySelector('span').dataset.i18n = '';
        el.addEventListener('click', () => { void onPick(o.id); closePops(); });
        sub.appendChild(el);
      }
    }
    document.body.appendChild(sub);
    sub.style.visibility = 'hidden';
    const rootRect = root.getBoundingClientRect();
    sub.style.left = Math.max(8, rootRect.left - sub.offsetWidth - 8) + 'px';
    clampPopPosition(sub, rowRect.top - 6, null);
    sub.style.visibility = '';
    openPops.push(sub);
  }

  function modelSections() {
    // A signed-in account lists its models first; shared API routes stay
    // selectable as a second group when switching applies cleanly (shared
    // conversations or a fresh start page).
    if (!accountSubscription()) return [{ title: 'Model · Same-model failover', options: MODELS }];
    const sections = [{ title: 'Model · ' + accountName + ' account', options: MODELS }];
    if (routeModels.length && (sharedChat || !context.sessionId)) sections.push({ title: 'Model · Shared API routes', options: routeModels.map(id => ({ id, label: id })) });
    return sections;
  }

  function openModelMenu() {
    if (openPops.length) { closePops(); return; }
    $('modelPill').classList.add('open');
    const rect = $('modelPill').getBoundingClientRect();
    showPop(rect, (pop) => {
      const rowModel = document.createElement('div');
      rowModel.className = 'pop-row';
      rowModel.innerHTML = "<span data-i18n>Model</span><span class=\"pop-row-value\"></span>" + chevRight();
      rowModel.querySelector('.pop-row-value').textContent = modelLabel(currentModel);
      rowModel.addEventListener('click', () => {
        openSubMenu(rowModel, modelSections(), currentModel, persistModel);
      });
      const rowLevel = document.createElement('div');
      rowLevel.className = 'pop-row';
      rowLevel.innerHTML = "<span data-i18n>Reasoning level</span><span class=\"pop-row-value\"></span>" + chevRight();
      rowLevel.querySelector('.pop-row-value').dataset.i18n = '';
      rowLevel.querySelector('.pop-row-value').textContent = levelLabel(currentLevel);
      rowLevel.addEventListener('click', () => {
        openSubMenu(rowLevel, [{ title: '', options: LEVELS }], currentLevel, persistLevel);
      });
      pop.appendChild(rowModel);
      if (LEVELS.length > 1) pop.appendChild(rowLevel);
    }, 260);
  }

  function openUsageMenu() {
    if (openPops.length) { closePops(); return; }
    const rect = $('usageDot').getBoundingClientRect();
    showPop(rect, (pop) => {
      if (!lastUsage) {
        const d = document.createElement('div');
        d.className = 'pop-group'; d.dataset.i18n = '';
        d.textContent = "Usage appears here after a completed turn";
        pop.appendChild(d);
        return;
      }
      const rows = [
        ["System prompt (cache read)", fmtTokens(lastUsage.cache_read_input_tokens)],
        ["Cache write", fmtTokens(lastUsage.cache_creation_input_tokens)],
        ["Input tokens", fmtTokens(lastUsage.input_tokens)],
        ["Output tokens", fmtTokens(lastUsage.output_tokens)],
      ];
      const g = document.createElement('div');
      g.className = 'pop-group'; g.dataset.i18n = '';
      g.textContent = "Last turn";
      pop.appendChild(g);
      for (const [k, v] of rows) {
        const el = document.createElement('div');
        el.className = 'pop-row';
        el.innerHTML = '<span></span><span class="pop-row-value"></span>';
        el.querySelector('span').dataset.i18n = ''; el.querySelector('span').textContent = k;
        el.querySelector('.pop-row-value').textContent = '~' + v;
        pop.appendChild(el);
      }
    }, 230);
  }

  $('modelPill').addEventListener('click', openModelMenu);
  $('usageDot').addEventListener('click', openUsageMenu);

  // ---------- attachments ----------
  function isImagePath(p) { return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p); }
  function fileUrl(p) {
    const normalized = String(p).replace(/\\/g, '/');
    const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return normalized.startsWith('//') ? 'file:' + encoded : 'file:///' + encoded.replace(/^\//, '');
  }

  function addAttachments(paths) {
    let unsupportedImage = false;
    for (const p of paths || []) {
      if (!p) continue;
      if (chatProfile.supportsImages === false && isImagePath(p)) { unsupportedImage = true; continue; }
      if (attachments.some((a) => a.path === p)) continue;
      attachments.push({ path: p, name: String(p).split(/[\\/]/).pop(), isImage: isImagePath(p) });
    }
    renderAttachments();
    if (unsupportedImage) setStatus('Antigravity currently supports text and code attachments. Use Claude or Kimi for images.');
  }

  function renderAttachments() {
    const row = $('attachRow');
    row.classList.toggle('has', attachments.length > 0);
    row.innerHTML = '';
    attachments.forEach((a, i) => {
      const chip = document.createElement('div');
      chip.className = 'attchip';
      chip.title = a.path;
      const visual = a.isImage
        ? '<img src="' + esc(fileUrl(a.path)) + '" alt="">'
        : '<span class="attchip-fileicon">📎</span>';
      chip.innerHTML = visual + "<span class=\"attchip-name\"></span><button class=\"attchip-x\" title=\"Remove\">✕</button>";
      chip.querySelector('.attchip-name').textContent = a.name;
      chip.querySelector('.attchip-x').addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachments();
      });
      row.appendChild(chip);
    });
    saveDraft();
  }

  $('attachBtn').addEventListener('click', async () => {
    const res = await window.dshDesktop.pickAttachments();
    if (!res.canceled) addAttachments(res.paths);
  });

  // Drag & drop onto the input card
  inputCard.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputCard.classList.add('dragging');
  });
  inputCard.addEventListener('dragleave', (e) => {
    if (!inputCard.contains(e.relatedTarget)) inputCard.classList.remove('dragging');
  });
  inputCard.addEventListener('drop', (e) => {
    e.preventDefault();
    inputCard.classList.remove('dragging');
    const paths = [];
    for (const f of e.dataTransfer.files) {
      try {
        const p = window.dshDesktop.attachmentPath(f) || f.path;
        if (p) paths.push(p);
      } catch (_err) { /* ignore unresolvable drops */ }
    }
    addAttachments(paths);
  });

  // Paste images from clipboard
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    const paths = [];
    for (const f of files) {
      try {
        const p = window.dshDesktop.attachmentPath(f) || f.path;
        if (p) paths.push(p);
      } catch (_err) { /* clipboard temp files without a path are ignored */ }
    }
    if (paths.length) { e.preventDefault(); addAttachments(paths); }
  });

  // ---------- messages ----------
  function addUser(text, atts, meta = {}) {
    const was = nearBottom();
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg-user';
    div.messageData = { text, attachments: atts || [], seq: meta.seq, at: meta.at };
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    div.appendChild(b);
    if (atts && atts.length) {
      const chips = document.createElement('div');
      chips.className = 'attchips';
      for (const a of atts) {
        const c = document.createElement('span');
        c.className = 'attchip-inline';
        c.textContent = (a.isImage ? '🖼 ' : '📎 ') + a.name;
        chips.appendChild(c);
      }
      div.appendChild(chips);
    }
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const time = document.createElement('time');
    if (meta.at) { time.dateTime = new Date(meta.at).toISOString(); time.textContent = new Date(meta.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    actions.appendChild(time);
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'message-copy'; copy.title = 'Copy message'; copy.setAttribute('aria-label', 'Copy message');
    copy.dataset.i18nAttrs = 'title aria-label';
    copy.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(div.messageData.text); setStatus('Message copied'); } catch { setStatus('Could not copy the message'); } };
    actions.appendChild(copy);
    if (sharedChat) {
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'message-edit'; edit.title = 'Edit message'; edit.setAttribute('aria-label', 'Edit message'); edit.hidden = true;
      edit.dataset.i18nAttrs = 'title aria-label';
      edit.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z"/></svg>';
      edit.onclick = () => beginMessageEdit(div);
      actions.appendChild(edit);
    }
    div.appendChild(actions);
    chat.appendChild(div);
    updateMessageActions();
    maybeScroll(was);
    return div;
  }

  function updateMessageActions() {
    const users = [...chat.querySelectorAll('.msg-user')];
    const editable = sharedChat && context.sessionId && !conversationBusy() && !loadingSession && !sending && !switchingEngine;
    for (const div of users) {
      const button = div.querySelector('.message-edit');
      if (button) button.hidden = !editable || div !== users.at(-1) || !div.messageData.seq || Boolean(editingMessage);
    }
  }

  function cancelMessageEdit() {
    const state = editingMessage;
    if (!state) return;
    editingMessage = null;
    state.div.classList.remove('editing'); state.form.remove();
    updateConversationControls();
    state.div.querySelector('.message-edit')?.focus();
  }

  function beginMessageEdit(div) {
    if (!sharedChat || conversationBusy() || contextBusy() || !div.messageData.seq || div !== [...chat.querySelectorAll('.msg-user')].at(-1)) return;
    cancelMessageEdit();
    const form = document.createElement('form'); form.className = 'message-editor';
    const textarea = document.createElement('textarea'); textarea.setAttribute('aria-label', 'Edit message'); textarea.value = div.messageData.text;
    const hint = document.createElement('div'); hint.className = 'message-edit-hint'; hint.textContent = 'The previous reply and tool history are cleared. File changes are kept.';
    hint.dataset.i18n = ''; textarea.dataset.i18nAttrs = 'aria-label';
    const controls = document.createElement('div'); controls.className = 'message-edit-buttons';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = cancelMessageEdit;
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary'; submit.textContent = 'Send';
    cancel.dataset.i18n = ''; submit.dataset.i18n = '';
    const status = document.createElement('div'); status.className = 'message-edit-status'; status.dataset.i18n = ''; status.hidden = true; status.setAttribute('role', 'status');
    controls.append(cancel, submit); form.append(textarea, hint, status, controls); div.appendChild(form); div.classList.add('editing');
    const state = { div, form, textarea, submit, cancel, status, sessionId: context.sessionId }; editingMessage = state;
    const resize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(320, Math.max(100, textarea.scrollHeight)) + 'px'; submit.disabled = !textarea.value.trim() && !div.messageData.attachments.length; };
    textarea.oninput = resize;
    textarea.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); cancelMessageEdit(); }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void resendEditedMessage(state); }
    };
    form.onsubmit = event => { event.preventDefault(); void resendEditedMessage(state); };
    updateConversationControls(); resize(); textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function showMessageEditStatus(state, text, error = false) {
    state.status.textContent = text; state.status.hidden = false;
    state.status.classList.toggle('error', error); state.status.setAttribute('role', error ? 'alert' : 'status');
    state.status.scrollIntoView({ block: 'nearest' });
  }

  async function resendEditedMessage(state) {
    if (editingMessage !== state || state.sessionId !== context.sessionId) return;
    if (sending) return;
    if (conversationBusy() || contextBusy()) { showMessageEditStatus(state, 'Wait for this conversation to finish or stop it first.', true); return; }
    const text = state.textarea.value.trim(), atts = state.div.messageData.attachments;
    if (!text && !atts.length) { showMessageEditStatus(state, 'Message cannot be empty', true); return; }
    sending = true; restoringRun = true; state.submit.disabled = true; state.cancel.disabled = true; state.textarea.disabled = true;
    state.submit.textContent = 'Sending…'; state.form.setAttribute('aria-busy', 'true');
    // Clear the old reply immediately. Keep its nodes until the backend accepts
    // the revision so a rejected request can restore the unchanged transcript.
    const previousReply = [];
    while (state.div.nextSibling) { previousReply.push(state.div.nextSibling); state.div.nextSibling.remove(); }
    showMessageEditStatus(state, 'Restarting this turn…');
    updateConversationControls();
    let res;
    try {
      res = await chatApi.send({ sessionId: state.sessionId, workspaceId: context.workspaceId, editSeq: state.div.messageData.seq,
        prompt: buildPrompt(text, atts), displayText: text, attachments: atts });
    } catch (error) { res = { ok: false, error: error.message }; }
    sending = false;
    if (!res?.ok) {
      state.div.after(...previousReply);
      restoringRun = false;
      for (const event of eventsDuringRestore.splice(0)) handleEvent(event);
      state.submit.disabled = false; state.cancel.disabled = false; state.textarea.disabled = false;
      state.submit.textContent = 'Send'; state.form.removeAttribute('aria-busy');
      const error = 'Could not resend: ' + (res?.error || 'No response from the app');
      showMessageEditStatus(state, error, true); setStatus(error); updateConversationControls(); state.textarea.focus({ preventScroll: true }); return;
    }
    editingMessage = null;
    while (state.div.nextSibling) state.div.nextSibling.remove();
    state.div.remove(); turnEl = null; blocks = {}; pendingTools = {}; todoItems = null; todoPanelEl = null;
    addUser(text, atts, { seq: res.userSeq, at: Date.now() });
    currentRunId = res.runId; acceptSessionEvents = true; loadedEngine = harnessId;
    setRunning(true); restoringRun = false;
    for (const event of eventsDuringRestore.splice(0)) handleEvent(event);
    updateConversationControls(); void sidebar.load();
  }

  function ensureTurn() {
    if (turnEl) return turnEl;
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'turn';
    div.innerHTML =
      '<div class="turn-meta">' + chatAvatar + '<span>' + chatProfile.shortName + '</span></div>' +
      '<div class="turn-body"></div>';
    chat.appendChild(div);
    turnEl = div;
    return div;
  }
  function turnBody() { return ensureTurn().querySelector('.turn-body'); }

  // ---------- P0: run status row ----------
  function statusRow() {
    const t = ensureTurn();
    let el = t.querySelector('.run-status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'run-status';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span class="pulse"></span><span class="run-text" data-i18n></span><span class="run-clock"></span>';
      t.insertBefore(el, t.querySelector('.turn-body'));
    }
    return el;
  }
  function setRunStatus(text) {
    if (!running && !text) return;
    const el = statusRow();
    el.querySelector('.run-text').textContent = text || "Working…";
  }
  function clearRunStatus() {
    const el = turnEl && turnEl.querySelector('.run-status');
    if (el) el.remove();
    clearInterval(statusClockTimer);
    statusClockTimer = null;
  }
  function startStatusClock() {
    clearInterval(statusClockTimer);
    statusClockTimer = setInterval(() => {
      const el = turnEl && turnEl.querySelector('.run-status .run-clock');
      if (!el || !runAnchorMs) return;
      const elapsed = Date.now() - runAnchorMs;
      // Same threshold as the DSH frontend: the clock shows only after 15s.
      el.textContent = elapsed >= 15000 ? fmtDuration(elapsed) : '';
    }, 1000);
  }

  // ---------- P0: todo / task panel ----------
  function todoCounts(items) {
    const c = { pending: 0, in_progress: 0, completed: 0 };
    for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
    return c;
  }
  function todoSummaryText(items) {
    const c = todoCounts(items);
    const parts = [];
    if (c.in_progress) parts.push(c.in_progress + " In progress");
    if (c.pending) parts.push(c.pending + " Pending");
    if (c.completed) parts.push(c.completed + " Completed");
    return parts.join(' · ');
  }
  function todoIconSvg(status) {
    if (status === 'completed') {
      return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#22c55e" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/></svg>';
    }
    if (status === 'in_progress') {
      return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#4176e6" stroke-width="2"><circle cx="12" cy="12" r="9" stroke-dasharray="14 42" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1.2s" repeatCount="indefinite"/></circle></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#adb2b8" stroke-width="2" stroke-dasharray="3 3"><circle cx="12" cy="12" r="9"/></svg>';
  }
  function ensureTodoPanel() {
    if (todoPanelEl && todoPanelEl.isConnected) return todoPanelEl;
    clearEmpty();
    const el = document.createElement('div');
    el.className = 'todo-panel';
    el.innerHTML =
      '<div class="todo-head">' +
      '  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>' +
      "  <span data-i18n>Task</span><span class=\"todo-counts\"></span>" +
      '  <span class="chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>' +
      '</div>' +
      '<div class="todo-list"></div>';
    el.querySelector('.todo-head').addEventListener('click', () => el.classList.toggle('open'));
    chat.appendChild(el); // panel rides at the bottom of the flow, near the live turn
    todoPanelEl = el;
    return el;
  }
  function renderTodoPanel() {
    if (!todoItems || !todoItems.length) {
      if (todoPanelEl) { todoPanelEl.remove(); todoPanelEl = null; }
      return;
    }
    const el = ensureTodoPanel();
    el.querySelector('.todo-counts').textContent = '　' + todoSummaryText(todoItems);
    const list = el.querySelector('.todo-list');
    list.innerHTML = '';
    for (const it of todoItems) {
      const row = document.createElement('div');
      row.className = 'todo-item ' + it.status;
      const active = it.status === 'in_progress' && it.activeForm
        ? '<span class="todo-activeform">' + esc(it.activeForm) + '</span>' : '';
      row.innerHTML = '<span class="todo-icon">' + todoIconSvg(it.status) + '</span><span>' + esc(it.content) + '</span>' + active;
      list.appendChild(row);
    }
  }
  // Whole-list capture from tool inputs (last-wins, same rule as DSH todo projection).
  function captureTodos(name, inputData) {
    const n = String(name || '');
    if (n === 'TodoWrite' && inputData && Array.isArray(inputData.todos)) {
      todoItems = inputData.todos.map((t) => ({
        content: t.content || '', status: t.status || 'pending', activeForm: t.activeForm || '',
      }));
      renderTodoPanel();
      return;
    }
    if (n === 'TaskCreate' && inputData && inputData.subject) {
      if (!todoItems) todoItems = [];
      todoItems.push({
        id: 'tmp-' + Date.now() + '-' + todoItems.length,
        content: inputData.subject,
        activeForm: inputData.activeForm || '',
        status: 'pending',
      });
      renderTodoPanel();
      return;
    }
    if (n === 'TaskUpdate' && inputData && inputData.taskId && todoItems) {
      const it = todoItems.find((x) => x.id === inputData.taskId);
      if (!it) return;
      if (inputData.status === 'deleted') todoItems = todoItems.filter((x) => x !== it);
      else {
        if (inputData.status) it.status = inputData.status;
        if (inputData.subject) it.content = inputData.subject;
        if (inputData.activeForm) it.activeForm = inputData.activeForm;
      }
      renderTodoPanel();
    }
  }
  function captureTaskResultId(name, resultText) {
    // TaskCreate's result carries the real id ("Task #12 created…"); patch the last temp entry.
    if (String(name) !== 'TaskCreate' || !todoItems) return;
    const m = /task\s*#?(\d+)/i.exec(resultText || '');
    if (!m) return;
    const tmp = todoItems.filter((x) => String(x.id || '').startsWith('tmp-')).pop();
    if (tmp) tmp.id = m[1];
  }

  // ---------- blocks ----------
  function makeTextBlock() {
    const el = document.createElement('div');
    el.className = 'md';
    turnBody().appendChild(el);
    return el;
  }

  function makeThinkBlock() {
    const el = document.createElement('div');
    el.className = 'think open live';
    el.innerHTML =
      "<div class=\"think-head\"><span class=\"arrow\">▶</span><span>💭 Reasoning</span><span class=\"think-status\" data-i18n>In progress…</span></div>" +
      '<div class="think-body"></div>';
    el.querySelector('.think-head').addEventListener('click', () => el.classList.toggle('open'));
    turnBody().appendChild(el);
    return el;
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
    const c = inputData.command || inputData.file_path || inputData.pattern || inputData.path || inputData.description || '';
    if (!c) return '';
    const line = String(c).split('\n')[0];
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
  }

  function makeToolCard(name, inputData, id) {
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
    turnBody().appendChild(el);
    const card = {
      name, el,
      inputEl: el.querySelector('.tool-input'),
      outputEl: el.querySelector('.tool-output'),
      stateEl: el.querySelector('.tool-state'),
      summaryEl: el.querySelector('.tool-summary'),
      setInput(data) {
        this.inputData = data;
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
        this.outputEl.textContent = text || "(No output)";
        this.outputEl.classList.toggle('err', !!isErr);
        this.stateEl.className = 'tool-state ' + (isErr ? 'err' : 'done');
      },
    };
    card.setInput(inputData || null);
    if (id) pendingTools[id] = card;
    return card;
  }

  function finalizeStreamBlocks() {
    flushBlockRenders();
    for (const key of Object.keys(blocks)) {
      const b = blocks[key];
      if (b.type === 'thinking' && b.el.classList.contains('live')) {
        b.el.classList.remove('live');
        const st = b.el.querySelector('.think-status');
        if (st) st.textContent = "Completed";
        if (!b.userToggled) b.el.classList.remove('open');
      }
      b.el.querySelector('.cursor')?.remove();
    }
    blocks = {};
  }

  // Final layout of a finished turn: reasoning segments merge into one folded
  // record, tool calls tuck into a single folded group; the reply text stays.
  function consolidateFinishedTurn() {
    const body = turnEl ? turnEl.querySelector('.turn-body') : null;
    if (!body) return;
    const thinks = [...body.querySelectorAll(':scope > .think')];
    if (thinks.length > 1) {
      const first = thinks[0];
      first.querySelector('.think-body').textContent = thinks
        .map(el => el.querySelector('.think-body').textContent.trim()).filter(Boolean).join('\n\n');
      first.classList.remove('open', 'live');
      const st = first.querySelector('.think-status');
      if (st) st.textContent = "Completed";
      for (const el of thinks.slice(1)) el.remove();
    }
    const cards = [...body.querySelectorAll(':scope > .tool-card')];
    if (cards.length) {
      const group = document.createElement('div');
      group.className = 'tool-group';
      group.innerHTML = `<div class="tool-group-head"><span class="arrow">▶</span><span data-i18n>${cards.length} tool calls</span></div><div class="tool-group-body"></div>`;
      group.querySelector('.tool-group-head').addEventListener('click', () => group.classList.toggle('open'));
      body.insertBefore(group, cards[0]);
      const bucket = group.querySelector('.tool-group-body');
      for (const card of cards) bucket.appendChild(card);
    }
  }

  // ---------- streaming ----------
  const pendingBlockRenders = new Set();
  let blockRenderFrame = null;
  function renderBlock(b) {
    if (!b.el.isConnected) return;
    if (b.type === 'text') b.el.innerHTML = mdRender(b.raw) + (b.stopped ? '' : '<span class="cursor"></span>');
    else if (b.type === 'thinking') b.el.querySelector('.think-body').textContent = b.raw;
  }
  function flushBlockRenders() {
    if (blockRenderFrame !== null) cancelAnimationFrame(blockRenderFrame);
    blockRenderFrame = null;
    const was = nearBottom();
    for (const b of pendingBlockRenders) renderBlock(b);
    pendingBlockRenders.clear();
    maybeScroll(was);
  }
  function queueBlockRender(b) {
    pendingBlockRenders.add(b);
    if (blockRenderFrame === null) blockRenderFrame = requestAnimationFrame(flushBlockRenders);
  }

  function onBlockStart(b, index) {
    const was = nearBottom();
    if (b.type === 'text') {
      blocks[index] = { type: 'text', raw: b.text || '', el: makeTextBlock() };
      queueBlockRender(blocks[index]);
    } else if (b.type === 'thinking') {
      const el = makeThinkBlock();
      el.querySelector('.think-head').addEventListener('click', () => {
        if (blocks[index]) blocks[index].userToggled = true;
      });
      blocks[index] = { type: 'thinking', raw: b.thinking || '', el };
      queueBlockRender(blocks[index]);
    } else if (b.type === 'tool_use') {
      const card = makeToolCard(b.name, b.input, b.id);
      blocks[index] = { type: 'tool', el: card.el, card, inputJson: '' };
    }
    maybeScroll(was);
  }

  function onBlockDelta(delta, index) {
    const b = blocks[index];
    if (!b) return;
    if (delta.type === 'text_delta' && delta.text && b.type === 'text') {
      b.raw += delta.text;
      queueBlockRender(b);
    } else if (delta.type === 'thinking_delta' && delta.thinking && b.type === 'thinking') {
      b.raw += delta.thinking;
      queueBlockRender(b);
    } else if (delta.type === 'input_json_delta' && delta.partial_json && b.type === 'tool') {
      b.inputJson += delta.partial_json;
    }
  }

  function onBlockStop(index) {
    const b = blocks[index];
    if (!b) return;
    const was = nearBottom();
    // A finished thinking segment settles immediately instead of spinning
    // "In progress…" until the turn ends.
    if (b.type === 'thinking' && b.el.classList.contains('live')) {
      b.el.classList.remove('live');
      const st = b.el.querySelector('.think-status');
      if (st) st.textContent = "Completed";
      if (!b.userToggled) b.el.classList.remove('open');
    }
    if (b.type === 'tool' && b.inputJson) {
      let parsed = null;
      try { parsed = JSON.parse(b.inputJson); } catch (_e) { /* keep raw */ }
      b.card.setInput(parsed || b.inputJson);
      captureTodos(b.card.name, parsed);
    }
    if (b.type === 'text') {
      b.stopped = true;
      pendingBlockRenders.delete(b);
      renderBlock(b);
    }
    maybeScroll(was);
  }

  function rebuildTurn(content) {
    // Canonical assistant message: rebuild cleanly (dedupes streaming partials).
    finalizeStreamBlocks();
    const was = nearBottom();
    const body = turnBody();
    body.innerHTML = '';
    pendingTools = {};
    for (const blk of content || []) {
      if (blk.type === 'text' && blk.text) {
        const el = makeTextBlock();
        el.innerHTML = mdRender(blk.text);
      } else if (blk.type === 'thinking' && blk.thinking) {
        const el = makeThinkBlock();
        el.classList.remove('open', 'live');
        el.querySelector('.think-status').textContent = "Completed";
        el.querySelector('.think-body').textContent = blk.thinking;
      } else if (blk.type === 'tool_use') {
        captureTodos(blk.name, blk.input);
        makeToolCard(blk.name, blk.input, blk.id);
      }
    }
    maybeScroll(was);
  }

  function extractResultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c) => (c && c.text) || '').filter(Boolean).join('\n');
    }
    return content ? JSON.stringify(content, null, 2) : '';
  }

  // ---------- status ----------
  function setStatus(text) { statusLine.textContent = text; }
  function startRunTicker() {
    runStartedAt = Date.now();
    clearInterval(runTimer);
    runTimer = setInterval(() => {
      setStatus("Running… · Elapsed " + fmtDuration(Date.now() - runStartedAt));
    }, 1000);
    setStatus("Running…");
  }
  function stopRunTicker() { clearInterval(runTimer); runTimer = null; }

  // ---------- context usage ring ----------
  const ENGINE_CTX_DEFAULTS = { claude: 200000, codex: 272000, dsh: 131072, kimi: 131072, antigravity: 1048576 };
  let modelCtxCaps = new Map();
  let ctxTip = null;
  function updateCtxRing() {
    const ring = $('ctxRing');
    const cap = (currentModel && (modelCtxCaps.get(currentModel) || modelCtxCaps.get(currentModel.replace(/:cloud$/, '')))) || ENGINE_CTX_DEFAULTS[harnessId];
    const used = lastUsage ? (lastUsage.input_tokens || lastUsage.prompt_tokens || 0) + (lastUsage.cache_read_input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0) : 0;
    if (!cap || !used) { ring.hidden = true; return; }
    const pct = Math.min(100, Math.round(used / cap * 100));
    ring.hidden = false;
    $('ctxFill').style.strokeDasharray = (97.39 * pct / 100) + ' 97.39';
    $('ctxFill').classList.toggle('hot', pct >= 80);
    ring.dataset.tip = window.CamelliaI18n.t('Context used: {0} / {1} tokens ({2}%)').replace('{0}', fmtTokens(used)).replace('{1}', fmtTokens(cap)).replace('{2}', pct);
    ring.title = ring.dataset.tip;
  }
  $('ctxRing').addEventListener('mouseenter', () => {
    const text = $('ctxRing').dataset.tip;
    if (!text) return;
    ctxTip = document.createElement('div');
    ctxTip.className = 'ctx-tip';
    ctxTip.textContent = text;
    document.body.appendChild(ctxTip);
    const rect = $('ctxRing').getBoundingClientRect();
    ctxTip.style.left = Math.max(8, rect.left + rect.width / 2 - ctxTip.offsetWidth / 2) + 'px';
    ctxTip.style.bottom = (innerHeight - rect.top + 8) + 'px';
  });
  $('ctxRing').addEventListener('mouseleave', () => { ctxTip?.remove(); ctxTip = null; });

  function resultStats(ev) {
    const parts = [];
    if (ev.num_turns != null) parts.push(ev.num_turns + " ");
    parts.push("Elapsed " + (ev.duration_ms != null ? fmtDuration(ev.duration_ms) : fmtDuration(Date.now() - runStartedAt)));
    if (ev.total_cost_usd != null) parts.push('$' + Number(ev.total_cost_usd).toFixed(4));
    const u = ev.usage;
    if (u) {
      lastUsage = u;
      updateCtxRing();
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      parts.push("Input " + fmtTokens(input) + ' tok');
      parts.push("Output " + fmtTokens(u.output_tokens) + ' tok');
      if (u.cache_read_input_tokens) parts.push("Cache hit " + fmtTokens(u.cache_read_input_tokens) + ' tok');
    }
    return parts;
  }

  function setRunning(v) {
    running = v;
    updateConversationControls();
    sidebar.updateLabel();
    if (v) {
      sendBtn.classList.add('stop');
      sendBtn.disabled = false;
      sendBtn.title = "Stop";
      sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
      startRunTicker();
    } else {
      sendBtn.classList.remove('stop');
      updateSendEnabled();
      sendBtn.title = "Send";
      sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
      stopRunTicker();
    }
  }

  // ---------- event handling ----------
  function handleEvent(ev) {
    if (!ev) return;
    if (sharedChat && ev.type === 'conversation:activity') {
      void sidebar.load();
      if (restoringRun) { eventsDuringRestore.push(ev); return; }
      if (ev.session_id === context.sessionId) { conversationActivity = ev.activity; updateConversationControls(); }
      return;
    }
    if (restoringRun) { eventsDuringRestore.push(ev); return; }
    if (sharedChat && ev.session_id !== context.sessionId) return;
    if (ev.handoff && ev.type === 'gui:permission') {
      if (currentPermission === 'full') { void autoAllowPermission(ev); return; }
      permissionQueue.push(ev); if (!permRequestId) showPermissionDialog(ev); return;
    }
    if (!acceptSessionEvents) return;
    // Highest automation level: approvals never surface a dialog. Permission
    // checks are allowed; question prompts continue without a confirmed answer.
    if (ev.type === 'gui:permission' && currentPermission === 'full') { void autoAllowPermission(ev); return; }
    if (ev.type === 'conversation:started') {
      if (ev.runId !== currentRunId) {
        currentRunId = ev.runId;
        turnEl = null; blocks = {}; pendingTools = {};
        addUser(ev.displayText ?? ev.prompt, ev.attachments, { seq: ev.userSeq, at: Date.now() });
        setRunning(true);
      }
      return;
    }
    if (currentRunId != null && ev.runId != null && currentRunId !== ev.runId) return;
    const was = nearBottom();

    if (ev.type === 'system' && ev.subtype === 'init') {
      loadedEngine = harnessId;
      context.sessionId = ev.session_id || context.sessionId;
      context.workspaceId = ev.workspaceId || null;
      sidebar.render();
      void sidebar.load();
      return;
    }

    if (ev.type === 'stream_event' && ev.event) {
      const e = ev.event;
      if (e.type === 'message_start') {
        if (!running) setRunning(true);
        runAnchorMs = Date.now();
        startStatusClock();
        setRunStatus("Working…");
      } else if (e.type === 'content_block_start') {
        const b = e.content_block || {};
        if (b.type === 'thinking') setRunStatus("Thinking…");
        else if (b.type === 'text') setRunStatus("Writing a response…");
        else if (b.type === 'tool_use') setRunStatus("Preparing tool " + (b.name || '') + '…');
        onBlockStart(b, e.index);
      } else if (e.type === 'content_block_delta' && e.delta) {
        onBlockDelta(e.delta, e.index);
      } else if (e.type === 'content_block_stop') {
        const b = blocks[e.index];
        // After the tool call JSON is complete, the tool is executing → richer status.
        if (b && b.type === 'tool' && running) {
          let desc = '';
          try { const d = JSON.parse(b.inputJson || '{}'); desc = d.activeForm || d.description || ''; } catch (_x) { /* partial */ }
          setRunStatus("Running " + b.card.name + (desc ? " (" + desc + ")" : '') + '…');
        }
        onBlockStop(e.index);
      }
      return;
    }

    if (ev.type === 'assistant' && ev.message) {
      rebuildTurn(ev.message.content || []);
      return;
    }

    if (ev.type === 'user' && ev.message) {
      for (const blk of ev.message.content || []) {
        if (blk.type === 'tool_result') {
          const card = pendingTools[blk.tool_use_id];
          const text = extractResultText(blk.content).trim();
          if (card) {
            card.setOutput(text, blk.is_error);
            captureTaskResultId(card.name, text);
          }
          if (running) setRunStatus("Working…");
        }
      }
      maybeScroll(was);
      return;
    }

    if (ev.type === 'gui:permission') {
      permissionQueue.push(ev);
      if (!permRequestId) showPermissionDialog(permissionQueue[0]);
      return;
    }

    if (ev.type === 'gui:tool') {
      const card = pendingTools[ev.id] || makeToolCard(ev.name || "Tool", ev.input, ev.id);
      if (ev.input !== undefined) card.setInput(ev.input);
      if (ev.status === 'completed' || ev.status === 'failed') card.setOutput(ev.output || '', ev.is_error);
      if (running) setRunStatus(ev.status === 'in_progress' ? "Running " + (ev.name || card.name) + '…' : "Working…");
      maybeScroll(was);
      return;
    }
    if (ev.type === 'gui:plan') {
      todoItems = (ev.entries || []).map(entry => ({ content: entry.content, status: entry.status }));
      renderTodoPanel();
      return;
    }
    if (ev.type === 'gui:config' && harnessId !== 'claude') {
      const thinking = (ev.options || []).find(option => ['thinking', 'reasoning_effort'].includes(option.id));
      LEVELS.splice(0, LEVELS.length, { id: '', label: 'Default' },
        ...(thinking?.options || []).map(option => ({ id: option.value, label: option.name })));
      currentLevel = thinking?.currentValue || '';
      renderModelPill();
      return;
    }

    if (ev.type === 'prompt_suggestion' || (ev.type === 'system' && ev.subtype === 'prompt_suggestion')) {
      const text = ev.suggestion || ev.message || '';
      if (text && !running) showSuggestion(text);
      return;
    }

    if (ev.type === 'result') {
      finishQuestion(ev.subtype === 'stopped' ? 'Stopped' : 'This request is no longer active');
      permissionSubmission = null;
      permRequestId = null;
      permissionQueue.length = 0;
      $('permMask').classList.remove('visible');
      finalizeStreamBlocks();
      clearRunStatus();
      consolidateFinishedTurn();
      const stopped = ev.subtype === 'stopped';
      const ok = !ev.is_error && ev.subtype !== 'error_max_turns' && !stopped;
      for (const card of Object.values(pendingTools)) if (!card.finished) card.setOutput(stopped ? 'Stopped before a tool result was received.' : 'No tool result was received before the response ended.', true);
      const stats = resultStats(ev);
      const chip = document.createElement('div');
      chip.className = 'run-result ' + (ok ? 'ok' : 'err');
      const errLabel = ev.subtype && ev.subtype !== 'success' ? ev.subtype : "Error";
      chip.textContent = (stopped ? "■ Stopped" : ok ? "✓ Done" : '✗ ' + (ev.result || errLabel)) + ' · ' + stats.slice(0, 3).join(' · ');
      (turnEl || chat).appendChild(chip);
      if (ev.session_id) {
        context.sessionId = ev.session_id;
        context.workspaceId = ev.workspaceId || null;
      }
      setStatus((stopped ? "Stopped · " : ok ? '' : "Error · ") + stats.join(' · '));
      turnEl = null;
      pendingTools = {};
      setRunning(false);
      currentRunId = null;
      void sidebar.load();
      maybeScroll(true);
      return;
    }
  }

  // ---------- send ----------
  function buildPrompt(text, atts) {
    if (!atts.length) return text;
    const lines = atts.map((a) => "[Attachment" + (a.isImage ? " (image; inspect its contents directly)" : '') + '] ' + a.path);
    const base = text || "Please review and process these attachments.";
    return base + '\n\n' + lines.join('\n');
  }

  function updateSendEnabled() {
    sendBtn.disabled = loadingSession || sending || Boolean(editingMessage) || (sharedChat && !running && goalUI.isActive()) || (!running && !input.value.trim() && !attachments.length);
  }

  async function send() {
    if (running) {
      if (currentRunId || sharedChat) {
        await chatApi.cancel(sharedChat ? { sessionId: context.sessionId, runId: currentRunId } : currentRunId);
        if (running) setStatus("Stopping…");
      }
      return;
    }
    if (editingMessage || !canChangeContext() || (sharedChat && conversationBusy())) return;
    if (sharedChat && context.sessionId && loadedEngine !== harnessId) {
      const settings = await window.dshDesktop.workbenchSettings();
      if (settings.conversations?.warnOnSwitch) { await switchOptions(harnessId); return; }
    }
    const text = input.value.trim();
    const atts = attachments.slice();
    if (!text && !atts.length) return;
    if (chatProfile.supportsImages === false && atts.some(a => a.isImage)) {
      setStatus('This engine cannot accept images. Your attachments are retained; switch engines or remove the images to continue.');
      return;
    }
    saveDraft();
    const sentDraftKey = draftKey();
    sending = true;
    if (sharedChat) restoringRun = true;
    input.value = '';
    attachments = [];
    renderAttachments();
    autoResize();
    chat.querySelector('.switch-hint')?.remove();
    const userMessage = addUser(text || "[Attachments]", atts, { at: Date.now() });
    if (!context.sessionId && !$('headerTitle').dataset.titled && text) {
      $('headerTitle').textContent = text.length > 24 ? text.slice(0, 24) + '…' : text;
      $('headerTitle').dataset.titled = '1';
    }
    setRunning(true);
    updateSendEnabled();
    acceptSessionEvents = true;
    sidebar.render();
    let res;
    try {
      const settings = await chatApi.getSettings({ sessionId: context.sessionId });
      res = await chatApi.send({
        prompt: buildPrompt(text, atts),
        displayText: text,
        attachments: atts,
        sessionId: context.sessionId || null,
        workspaceId: context.workspaceId,
        fork: Boolean(pendingForkId),
        settings,
      });
    } catch (err) { res = { ok: false, error: err.message }; }
    sending = false;
    if (!res.ok) {
      if (!input.value && !attachments.length) { input.value = text; attachments = atts; renderAttachments(); autoResize(); }
      saveDraft();
      finalizeStreamBlocks();
      const chip = document.createElement('div');
      chip.className = 'run-result err';
      chip.textContent = "Failed to start: " + res.error;
      chat.appendChild(chip);
      setStatus("Failed to start");
      updateSwitchHint();
      setRunning(false);
      acceptSessionEvents = false;
      restoringRun = false; eventsDuringRestore.length = 0;
      return;
    }
    if (pendingForkId) {
      pendingForkId = null;
      if (running) setStatus("Forking session…");
    }
    if (running) currentRunId = res.runId;
    if (res.sessionId) context.sessionId = res.sessionId;
    userMessage.messageData.seq = res.userSeq;
    loadedEngine = harnessId;
    if (sharedChat) {
      restoringRun = false;
      for (const event of eventsDuringRestore.splice(0)) handleEvent(event);
      updateSendEnabled(); void sidebar.load();
    }
    if (sharedChat) writeUi('draft:' + sentDraftKey, {});
    saveDraft();
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(Math.max(input.scrollHeight, 52), 180) + 'px';
  }
  input.addEventListener('input', () => {
    autoResize();
    if (!running) updateSendEnabled();
    saveDraft();
    renderSlash();
  });
  sendBtn.addEventListener('click', send);
  // ---------- slash commands ----------
  const SLASH_COMMANDS = [
    { id: 'goal', label: '/goal', desc: 'Set a goal; the engine keeps working until done or blocked',
      icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
      run: () => goalUI.reveal() },
    { id: 'usage', label: '/usage', desc: 'Show request and token usage through the local router',
      icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
      run: () => void showUsageCard() },
    { id: 'compact', label: '/compact', desc: 'Summarize and compact the conversation context',
      icon: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',
      run: () => void compactConversation() },
  ];
  let slashPop = null, slashIndex = 0;
  function slashMatches() {
    const m = /^\/([a-z]*)$/i.exec(input.value);
    return m ? SLASH_COMMANDS.filter(c => c.id.startsWith(m[1].toLowerCase())) : [];
  }
  function closeSlash() { slashPop?.remove(); slashPop = null; }
  function renderSlash() {
    const matches = slashMatches();
    if (!matches.length) { closeSlash(); return; }
    slashIndex = Math.min(slashIndex, matches.length - 1);
    if (!slashPop) {
      slashPop = document.createElement('div');
      slashPop.className = 'dsh-pop slash-pop';
      document.body.appendChild(slashPop);
    }
    slashPop.replaceChildren(...matches.map((command, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pop-row slash-row' + (i === slashIndex ? ' current' : '');
      row.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' + command.icon + '</svg><strong></strong><span></span>';
      row.querySelector('strong').textContent = command.label;
      const desc = row.querySelector('span'); desc.dataset.i18n = ''; desc.textContent = command.desc;
      row.addEventListener('click', () => { slashIndex = i; runSlashActive(); });
      return row;
    }));
    const rect = input.getBoundingClientRect();
    slashPop.style.left = Math.max(8, rect.left) + 'px';
    slashPop.style.bottom = (innerHeight - rect.top + 8) + 'px';
  }
  function runSlashActive() {
    const command = slashMatches()[slashIndex];
    input.value = ''; closeSlash(); autoResize(); updateSendEnabled();
    if (command) command.run();
  }
  async function showUsageCard() {
    const card = document.createElement('div');
    card.className = 'usage-card';
    const title = document.createElement('strong'); title.dataset.i18n = ''; title.textContent = 'Local API usage';
    const body = document.createElement('div'); body.className = 'usage-card-body'; body.textContent = '...';
    card.append(title, body);
    chat.appendChild(card); chatScroll.scrollTop = chatScroll.scrollHeight;
    try {
      const state = await window.dshDesktop.apiRouterGetState();
      const days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() - i * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
      const blank = () => ({ requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 });
      const today = blank(), week = blank();
      for (const entry of Object.values(state?.usage || {})) {
        for (const [day, models] of Object.entries(entry.daily || {})) {
          if (!days.includes(day)) continue;
          const target = day === days[0] ? today : week;
          for (const m of Object.values(models)) {
            target.requests += m.requests || 0; target.failures += m.failures || 0;
            target.inputTokens += m.inputTokens || 0; target.outputTokens += m.outputTokens || 0;
          }
        }
      }
      const t = window.CamelliaI18n.t;
      const line = (label, u) => label + ': ' + u.requests + ' requests, ' + fmtTokens(u.inputTokens) + ' in, ' + fmtTokens(u.outputTokens) + ' out' + (u.failures ? ', ' + u.failures + ' failed' : '');
      body.textContent = [line(t('Today'), today), line(t('Last 7 days'), week), t('Requests through the shared router on this computer')].join(String.fromCharCode(10));
      const open = document.createElement('button'); open.type = 'button'; open.dataset.i18n = ''; open.textContent = 'Open Usage settings';
      open.addEventListener('click', () => window.dshDesktop.openSettingsWindow({ page: 'usage' }));
      card.appendChild(open);
    } catch (error) { body.textContent = error.message; }
  }
  async function compactConversation() {
    if (!sharedChat || !context.sessionId) { setStatus('Start a conversation first, then compact it.'); return; }
    if (conversationBusy()) { setStatus('Available when this conversation stops working'); return; }
    try {
      const res = await window.dshDesktop.conversationCommand({ engine: harnessId, action: 'compact', payload: { sessionId: context.sessionId } });
      if (!res?.ok) setStatus(res?.error || 'Compaction failed');
      else setStatus('Context compacted. The conversation continues with the summary.');
    } catch (error) { setStatus(error.message); }
  }
  input.addEventListener('keydown', (e) => {
    if (slashPop) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = slashMatches().length; slashIndex = (((slashIndex + (e.key === 'ArrowDown' ? 1 : -1)) % n) + n) % n; renderSlash(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) { e.preventDefault(); runSlashActive(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  async function newSession(workspaceId = null) {
    if (!canChangeContext()) return;
    saveDraft();
    const wasReady = uiReady; uiReady = false;
    ++sessionOpenSeq;
    resetConversationView();
    loadingSession = true; input.disabled = true;
    updateConversationControls();
    closePops();
    acceptSessionEvents = false;
    currentRunId = null;
    context.sessionId = null;
    loadedEngine = harnessId;
    $('conversationOrigin').hidden = true;
    updateSwitchHint();
    context.workspaceId = workspaceId;
    writeUi('location', { sessionId: null, workspaceId });
    pendingForkId = null;
    turnEl = null;
    blocks = {};
    pendingTools = {};
    lastUsage = null; updateCtxRing();
    todoItems = null;
    if (todoPanelEl) { todoPanelEl.remove(); todoPanelEl = null; }
    $('headerTitle').textContent = window.CamelliaI18n.t("New session");
    delete $('headerTitle').dataset.titled;
    chat.replaceChildren(emptyStateTemplate.cloneNode(true));
    input.value = '';
    attachments = [];
    renderAttachments();
    autoResize();
    hideSuggestion();
    updateSendEnabled();
    const ws = sidebar.workspaces.find((w) => w.id === workspaceId);
    if (ws && ws.collapsed) await sidebar.metaOp({ op: 'toggle-collapse', workspaceId });
    sidebar.render();
    await sidebar.load();
    await loadSettings();
    await goalUI.refresh();
    restoreDraft(); uiReady = wasReady; loadingSession = false; input.disabled = false; updateSendEnabled(); updateConversationControls(); sidebar.updateLabel(); saveDraft();
    setStatus(workspaceId ? "New workspace session created" : "Standalone session · No workspace");
    input.focus();
  }
  $('newSessionBtn').addEventListener('click', () => void newSession(null));

  $('backToHome').addEventListener('click', () => window.dshDesktop.switchMode('home'));

  // Permission select auto-persists (applies to the next run).
  $('selPermission').addEventListener('change', () => void persistSettings(
    { permissionMode: $('selPermission').value }, "Permission mode saved. Applies to the next message."));

  // ---------- P3: permission dialog ----------
  function questionError(text) {
    if (!pendingQuestion) return;
    pendingQuestion.status.textContent = text;
    pendingQuestion.status.classList.add('error');
    pendingQuestion.status.setAttribute('role', 'alert');
  }
  function finishQuestion(text) {
    if (!pendingQuestion) return;
    const state = pendingQuestion;
    for (const control of state.card.querySelectorAll('input, textarea, button')) control.disabled = true;
    state.status.textContent = text; state.status.classList.remove('error'); state.status.setAttribute('role', 'status');
    // Collapse the answered form: a compact answer summary stays visible while
    // the full option lists fold behind a toggle.
    const answers = document.createElement('div'); answers.className = 'question-answers';
    for (const { question: q, choices, custom } of state.fields) {
      const picked = choices.filter(c => c.checked).map(c => c.value);
      const value = custom.value ? q.isSecret ? '••••••' : custom.value : picked.join(' · ');
      const line = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = q.question;
      const answer = document.createElement('span'); answer.textContent = value || '—';
      line.append(name, answer); answers.append(line);
    }
    const review = document.createElement('details'); review.className = 'question-review';
    const toggle = document.createElement('summary'); toggle.dataset.i18n = ''; toggle.textContent = 'Review options';
    review.append(toggle);
    for (const field of state.card.querySelectorAll('fieldset')) review.append(field);
    state.card.insertBefore(answers, state.status);
    state.card.insertBefore(review, state.status);
    state.card.classList.add('done');
    questionDrafts.delete(state.key); pendingQuestion = null;
  }
  function showQuestion(ev) {
    $('permMask').classList.remove('visible');
    const was = nearBottom(), key = JSON.stringify([context.sessionId, ev.runId, ev.requestId]);
    const saved = questionDrafts.get(key) || {};
    const card = document.createElement('form'); card.className = 'question-card';
    const title = document.createElement('h3'); title.dataset.i18n = ''; title.textContent = 'Your input is needed';
    const hint = document.createElement('p'); hint.className = 'question-hint'; hint.dataset.i18n = '';
    hint.textContent = 'Never ask covers tool permissions. This is a question about your task.';
    card.append(title, hint);
    const fields = [];
    for (const [index, question] of ev.questions.entries()) {
      const field = document.createElement('fieldset');
      const legend = document.createElement('legend'); legend.textContent = question.question; field.append(legend);
      if (question.multiSelect) { const note = document.createElement('p'); note.className = 'question-hint'; note.dataset.i18n = ''; note.textContent = 'Select one or more'; field.append(note); }
      const choices = [];
      for (const option of question.options || []) {
        const label = document.createElement('label'); label.className = 'question-choice';
        const choice = document.createElement('input'); choice.type = question.multiSelect ? 'checkbox' : 'radio';
        choice.name = 'question-' + index; choice.value = option.label; choice.checked = Boolean(saved[question.id]?.selected?.includes(option.label));
        const content = document.createElement('span'), name = document.createElement('strong'); name.textContent = option.label; content.append(name);
        if (option.description) { const description = document.createElement('span'); description.textContent = option.description; content.append(description); }
        label.append(choice, content); field.append(label); choices.push(choice);
      }
      const customLabel = document.createElement('label'); customLabel.className = 'question-custom';
      const customTitle = document.createElement('span'); customTitle.dataset.i18n = ''; customTitle.textContent = choices.length ? 'Or write your own answer' : 'Your answer';
      const custom = document.createElement('input'); custom.type = question.isSecret ? 'password' : 'text'; custom.autocomplete = 'off';
      custom.value = question.isSecret ? '' : saved[question.id]?.custom || '';
      customLabel.append(customTitle, custom); field.append(customLabel); card.append(field);
      const entry = { question, choices, custom }; fields.push(entry);
      const save = () => questionDrafts.set(key, Object.fromEntries(fields.filter(f => !f.question.isSecret).map(f => [f.question.id, { selected: f.choices.filter(c => c.checked).map(c => c.value), custom: f.custom.value }])));
      custom.oninput = () => { if (!question.multiSelect && custom.value) choices.forEach(choice => choice.checked = false); save(); };
      choices.forEach(choice => { choice.onchange = () => { if (!question.multiSelect) custom.value = ''; save(); }; });
    }
    const status = document.createElement('div'); status.className = 'question-status'; status.dataset.i18n = ''; status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'question-actions';
    const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'perm-deny'; skip.dataset.i18n = ''; skip.textContent = 'Skip questions';
    skip.onclick = () => void answerPermission(false);
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'perm-allow'; submit.dataset.i18n = ''; submit.textContent = 'Submit answers';
    actions.append(skip, submit); card.append(status, actions);
    card.onsubmit = event => { event.preventDefault(); void answerPermission(true); };
    pendingQuestion = { card, status, fields, key, requestId: ev.requestId };
    // Keep the card outside the streamed body so canonical assistant messages
    // cannot replace an unanswered form or erase the user's selections.
    ensureTurn().append(card); setRunStatus('Waiting for your answer'); setStatus('Waiting for your answer');
    if (was) card.scrollIntoView({ block: 'start' });
  }
  async function autoAllowPermission(ev) {
    const payload = ev.questions?.length
      ? { requestId: ev.requestId, allow: false, message: 'Fully automatic mode: no question is shown. Continue from the existing request; no option has been confirmed.' }
      : { requestId: ev.requestId, allow: true };
    if (sharedChat) Object.assign(payload, { sessionId: context.sessionId, runId: ev.runId });
    try { await chatApi.controlRespond(payload); } catch { /* the request may already be gone */ }
  }
  function showPermissionDialog(ev) {
    permRequestId = ev.requestId;
    if (ev.questions?.length) { showQuestion(ev); return; }
    $('permTool').textContent = "Tool: " + (ev.toolName || "Unnamed action");
    $('permReason').hidden = !ev.reason;
    $('permReason').textContent = ev.reason ? 'Native permission rule: ' + ev.reason : '';
    const data = ev.input || {};
    const detail = typeof data.command === 'string' ? data.command : Object.keys(data).length ? JSON.stringify(data, null, 2) : '';
    $('permInput').hidden = !detail;
    $('permInput').textContent = detail;
    $('permOptions').replaceChildren();
    $('permAllow').textContent = 'Allow';
    $('permDefaultActions').hidden = Boolean(ev.options);
    if (ev.options) {
      for (const option of ev.options) {
        const button = document.createElement('button');
        button.className = option.kind.startsWith('allow') ? 'perm-allow' : 'perm-deny';
        button.dataset.i18n = ''; button.textContent = ({ 'Approve once': "Allow once", 'Approve for this session': "Allow for this session", 'Reject': "Deny" })[option.name] || option.name;
        button.addEventListener('click', () => void answerPermission(false, option.optionId));
        $('permOptions').appendChild(button);
      }
      const cancel = document.createElement('button');
      cancel.className = 'perm-deny';
      cancel.dataset.i18n = ''; cancel.textContent = "Cancel";
      cancel.addEventListener('click', () => void answerPermission(false));
      if (!ev.options.some(option => option.kind.startsWith('reject'))) $('permOptions').appendChild(cancel);
    }
    $('permMask').classList.add('visible');
  }
  async function answerPermission(allow, optionId) {
    if (!permRequestId || permissionSubmission) return;
    const answered = permRequestId, sessionId = context.sessionId, runId = permissionQueue[0]?.runId;
    // A plain Allow click must keep the native tool's original input. Sending
    // an empty object here replaces Bash's command (or Write's file/content).
    let input;
    const question = pendingQuestion;
    if (question && allow) {
      const entries = question.fields.map(({ question: q, choices, custom }) => {
        const selected = choices.filter(choice => choice.checked).map(choice => choice.value), text = custom.value.trim();
        return [q.id, q.multiSelect ? [...selected, ...(text ? [text] : [])].join(', ') : text || selected[0] || ''];
      });
      if (entries.some(([, value]) => !value)) { questionError('Answer each question before submitting'); return; }
      input = Object.fromEntries(entries);
    }
    const submission = {}; permissionSubmission = submission;
    if (question) { question.status.textContent = 'Sending…'; question.status.classList.remove('error'); question.status.setAttribute('role', 'status'); question.card.querySelectorAll('input, button').forEach(el => el.disabled = true); }
    let result;
    try {
      result = await chatApi.controlRespond({ requestId: answered, allow, optionId, input,
        ...(question && !allow ? { message: 'The user skipped these questions without selecting an answer. Continue from the existing request; no option has been confirmed.' } : {}),
        ...(sharedChat ? { sessionId, runId } : {}) });
    } catch (error) { result = { ok: false, error: error.message }; }
    if (permissionSubmission === submission) permissionSubmission = null;
    if (sharedChat && (context.sessionId !== sessionId || permissionQueue[0]?.runId !== runId)) return;
    if (permRequestId !== answered) return;
    if (!result?.ok) {
      const error = result?.error || 'This request is no longer active';
      if (question && pendingQuestion === question) { question.card.querySelectorAll('input, button').forEach(el => el.disabled = false); questionError(error); }
      setStatus(error); return;
    }
    finishQuestion(allow ? 'Answers sent' : 'Questions skipped');
    setStatus(allow ? 'Answers sent' : 'Questions skipped');
    permRequestId = null;
    permissionQueue.shift();
    $('permMask').classList.remove('visible');
    if (permissionQueue.length) showPermissionDialog(permissionQueue[0]);
    else if (running) setRunStatus('Working…');
  }
  $('permAllow').addEventListener('click', () => void answerPermission(true));
  $('permDeny').addEventListener('click', () => void answerPermission(false));
  $('permLater').hidden = !sharedChat;
  $('permLater').onclick = () => $('permMask').classList.remove('visible');

  // ---------- P3: prompt suggestion ----------
  function hideSuggestion() {
    $('suggestion').classList.remove('visible');
    $('suggestion').textContent = '';
  }
  function showSuggestion(text) {
    const el = $('suggestion');
    el.textContent = '💡 ' + text;
    el.classList.add('visible');
  }
  $('suggestion').addEventListener('click', () => {
    input.value = $('suggestion').textContent.replace(/^💡\s*/, '');
    $('suggestion').classList.remove('visible');
    autoResize();
    updateSendEnabled();
    saveDraft();
    input.focus();
  });

  function openActionMenu(anchor, actions) {
    const rect = anchor.getBoundingClientRect();
    closePops();
    const pop = document.createElement('div');
    pop.className = 'dsh-pop';
    pop.setAttribute('role', 'menu');
    pop.style.maxWidth = '300px';
    actions.forEach((action) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pop-row' + (action.current ? ' current' : '');
      row.setAttribute('role', 'menuitem');
      row.disabled = Boolean(action.disabled);
      row.innerHTML = '<span></span>';
      row.querySelector('span').textContent = action.label;
      if (action.localize !== false) row.querySelector('span').dataset.i18n = '';
      if (!action.title && action.localize !== false) row.dataset.i18nAttrs = 'title';
      row.title = action.title || action.label;
      row.addEventListener('click', () => { closePops(); action.run(); });
      pop.appendChild(row);
    });
    pop.addEventListener('keydown', (e) => {
      const rows = [...pop.querySelectorAll('button:not(:disabled)')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = rows.indexOf(document.activeElement);
        rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
      }
      if (e.key === 'Escape') { closePops(); anchor.focus(); }
    });
    document.body.appendChild(pop);
    clampPopPosition(pop, rect.bottom + 4, Math.min(window.innerWidth - 8, rect.left + pop.offsetWidth));
    openPops.push(pop);
    pop.querySelector('button:not(:disabled)')?.focus();
  }
  function conversationBusy() { return running || Boolean(conversationActivity) || goalUI.isActive(); }
  function contextBusy() {
    return loadingSession || switchingEngine || sending || (!sharedChat && (running || goalUI.isActive()));
  }
  function canChangeContext() {
    if (!contextBusy()) return true;
    setStatus(sharedChat ? 'Please wait for the conversation to open.' : 'Stop the current response or pause the goal before switching sessions or workspaces');
    return false;
  }
  function updateConversationControls() {
    const locked = sharedChat && (conversationBusy() || loadingSession || switchingEngine || sending || Boolean(editingMessage));
    $('engineSwitch').disabled = !sharedChat || locked;
    $('engineSwitch').title = locked ? 'Available when this conversation stops working' : 'Switch harness';
    $('handoffBtn').disabled = locked;
    $('modelPill').disabled = locked;
    $('selPermission').disabled = locked;
    updateSendEnabled();
    updateMessageActions();
  }
  function resetConversationView() {
    closeSlash();
    cancelMessageEdit();
    pendingQuestion = null; permissionSubmission = null;
    acceptSessionEvents = false; currentRunId = null; conversationActivity = null;
    restoringRun = false; eventsDuringRestore.length = 0;
    permRequestId = null; permissionQueue.length = 0; $('permMask').classList.remove('visible');
    clearRunStatus(); setRunning(false);
  }
  const sidebar = createClaudeSidebar({ $, context, contextBusy, canChangeContext, setStatus,
    newSession, openHistorySession, forkSession, canFork: s => sharedChat || harnessId !== 'antigravity' || !s.id.startsWith('agy-'), openActionMenu, closePops });
  const goalUI = createClaudeGoalUI({ $, context, canChangeContext: () => !editingMessage && canChangeContext() && (!sharedChat || !running), openHistorySession, setStatus,
    acceptEvents: () => { acceptSessionEvents = true; }, onChange: () => { sidebar.updateLabel(); updateConversationControls(); } });

  let pendingForkId = null;
  async function forkSession(s) {
    if (!await openHistorySession(s.id)) return;
    if (sharedChat && conversationBusy()) { setStatus('Wait for this conversation to finish before forking it'); return; }
    pendingForkId = s.id;
    setStatus("The next message will fork this session and keep its workspace");
    input.focus();
  }
  async function openHistorySession(id) {
    if (!canChangeContext()) return false;
    saveDraft();
    const seq = ++sessionOpenSeq;
    resetConversationView();
    loadingSession = true; input.disabled = true;
    restoringRun = sharedChat;
    updateConversationControls();
    updateSendEnabled();
    sidebar.updateLabel();
    setStatus("Loading history…");
    try {
      const res = await chatApi.loadSession(id);
      if (seq !== sessionOpenSeq) return false;
      if (!res.ok) throw new Error(res.error);
      const s = sidebar.sessions.find((entry) => entry.id === id);
      if (sharedChat && res.activity && res.currentEngine !== harnessId) {
        writeUi('location', { sessionId: id, workspaceId: res.workspaceId });
        const opened = await window.dshDesktop.conversationSwitch({ engine: res.currentEngine, sessionId: id, navigate: true });
        if (!opened.ok) throw new Error(opened.error);
        return false;
      }
      context.sessionId = id;
      context.workspaceId = res.workspaceId || null;
      conversationPrefs = res.preferences || conversationPrefs;
      loadedEngine = res.currentEngine || harnessId;
      conversationActivity = res.activity || null;
      $('conversationOrigin').hidden = !conversationPrefs.showOrigin || !res.origin;
      $('conversationOrigin').textContent = res.origin === harnessId ? 'Created in this engine' : 'Created in ' + res.origin;
      if (res.settings) await loadSettings();
      acceptSessionEvents = false;
      currentRunId = null;
      pendingForkId = null;
      turnEl = null;
      blocks = {};
      pendingTools = {};
      todoItems = null;
      todoPanelEl = null;
      hideSuggestion();
      chat.innerHTML = '';
      $('headerTitle').textContent = s ? s.title : "Session " + id.slice(0, 8);
      $('headerTitle').dataset.titled = '1';
      renderHistoryMessages(res.messages);
      if (!chat.childElementCount) chat.innerHTML = "<div class=\"empty-state\"><div class=\"empty-state-desc\" data-i18n>No messages to display. Send a message to continue this session.</div></div>";
      sidebar.render();
      chatScroll.scrollTop = chatScroll.scrollHeight;
      restoreDraft();
      setStatus(res.interrupted ? 'The last turn was interrupted. Review its result before continuing.' : res.truncated ? "Showing the latest 200 messages. Continuation uses the full history." : "History loaded. Your next message continues this session.");
      if (sharedChat) {
        applyLiveRun(res.live);
        const lastSeq = res.live?.eventSeq || 0;
        const liveRun = res.live?.runId;
        restoringRun = false;
        for (const event of eventsDuringRestore.splice(0)) if (event.type === 'conversation:activity' || event.runId !== liveRun || event.eventSeq > lastSeq) handleEvent(event);
        await goalUI.refresh();
      }
      return true;
    } catch (err) { if (!/archived/i.test(err.message)) setStatus("Could not load: " + err.message); return false; }
    finally {
      if (seq === sessionOpenSeq) { loadingSession = false; input.disabled = false; restoringRun = false; updateSendEnabled(); updateConversationControls(); sidebar.updateLabel(); saveDraft(); }
    }
  }

  function renderHistoryMessages(messages) {
      // Label every reply once a conversation's history spans harnesses.
      const replyEngines = new Set(messages.filter(m => m.role === 'assistant' && m.engine).map(m => m.engine));
      const mixed = replyEngines.size > 1 || (replyEngines.size === 1 && !replyEngines.has(harnessId));
      for (const m of messages) {
        if (m.role === 'notice') {
          if (!conversationPrefs.showOrigin) continue;
          const note = document.createElement('div'); note.className = 'handoff-notice'; note.textContent = m.text;
          if (m.file) { const button = document.createElement('button'); button.textContent = 'Open Markdown'; button.onclick = () => window.dshDesktop.conversationOpenHandoff({ sessionId: context.sessionId, file: m.file }); note.appendChild(button); }
          chat.appendChild(note);
        }
        else if (m.role === 'user') addUser(m.displayText ?? m.text, m.attachments, m);
        else {
          const div = document.createElement('div');
          div.className = 'turn';
          const label = m.engine && (mixed || conversationPrefs.showOrigin) ? ENGINE_SHORT_NAMES[m.engine] || m.engine : 'Assistant';
          div.innerHTML = '<div class="turn-meta">' + (m.engine && m.engine !== harnessId ? engineAvatar(m.engine) : chatAvatar) + '<span>' + esc(label) + '</span></div><div class="turn-body"><div class="md"></div></div>';
          div.querySelector('.md').innerHTML = mdRender(m.text);
          chat.appendChild(div);
        }
      }
      updateSwitchHint();
  }

  function updateSwitchHint() {
    chat.querySelector('.switch-hint')?.remove();
    if (!sharedChat || !context.sessionId || !loadedEngine || loadedEngine === harnessId) return;
    const hint = document.createElement('div');
    hint.className = 'switch-hint';
    const mode = conversationPrefs.mode === 'markdown' ? 'Automatic Markdown handoff' : 'Continue directly';
    const t = window.CamelliaI18n.t;
    hint.textContent = t('Last reply from {0} · Continuing with {1}: {2}').replace('{0}', ENGINE_SHORT_NAMES[loadedEngine] || loadedEngine)
      .replace('{1}', chatProfile.name).replace('{2}', t(mode));
    chat.appendChild(hint);
  }

  function applyLiveRun(live) {
    if (!live) { acceptSessionEvents = true; return; }
    context.sessionId = live.sessionId; context.workspaceId = live.workspaceId;
    currentRunId = live.runId; acceptSessionEvents = true;
    turnEl = null; blocks = {}; pendingTools = {}; todoItems = null; todoPanelEl = null;
    chat.innerHTML = '';
    renderHistoryMessages(live.messages);
    addUser(live.displayText ?? live.prompt, live.attachments || [], { seq: live.userSeq, at: live.startedAt });
    setRunning(true);
    runStartedAt = live.startedAt || Date.now();
    sidebar.render();
    // Snapshot events are already ordered. New arrivals remain buffered until
    // this snapshot has been painted, then replay only events after its cursor.
    const buffering = restoringRun; restoringRun = false;
    for (const event of live.events) handleEvent(event);
    restoringRun = buffering;
  }
  async function restoreLiveRun() {
    let lastSeq = 0;
    try {
      const { live } = await chatApi.getLive();
      if (!live) return;
      context.sessionId = live.sessionId; context.workspaceId = live.workspaceId;
      await loadSettings();
      applyLiveRun(live); lastSeq = live.eventSeq;
    } catch (error) { setStatus('Could not restore the active run: ' + error.message); }
    finally {
      restoringRun = false;
      for (const event of eventsDuringRestore.splice(0)) if (event.eventSeq > lastSeq) handleEvent(event);
    }
  }

  // ---------- settings panel ----------
  $('settingsBtn').addEventListener('click', () => { closePops(); void window.dshDesktop.openSettingsWindow({ page: 'engines', engine: harnessId }); });
  $('connectionInfo').onclick = () => void window.dshDesktop.openSettingsWindow({ page: 'engines', engine: harnessId });
  function applyRouterModels(state) {
    for (const p of state?.providers || []) for (const m of p.models || []) {
      const cap = m.contextWindow || m.maxContext;
      if (cap) modelCtxCaps.set(m.id, cap);
    }
    if (Array.isArray(state?.models)) routeModels = state.enabled ? state.models : [];
    if (accountSubscription()) return;
    if (!Array.isArray(state?.models)) return;
    const models = state.enabled ? state.models : [];
    const canonical = currentModel.replace(/:cloud$/, '');
    // Keep the saved selection ID on its canonical row, including legacy :cloud IDs.
    MODELS.splice(0, MODELS.length, { id: '', label: models.length ? "Select model" : "Configure models in Camellia first" },
      ...models.map(id => ({ id: id === canonical ? currentModel : id, label: id })));
    if (currentModel && !models.includes(canonical)) {
      MODELS.push({ id: currentModel, label: canonical + " (no route configured)" });
    }
    renderModelPill();
    const route = state.lastRoute;
    if (route && route.model === canonical) {
      $('modelPill').title = route.providerName + ' · ' + route.reason;
    }
  }

  function applySessionSettings(s) {
    currentConnection = s.connection || 'api';
    if (harnessId === 'codex') {
      $('connectionInfo').hidden = false;
      $('connectionInfo').textContent = accountSubscription() ? 'ChatGPT account · Switch to API in settings' : 'API key / third-party API · Connection settings';
    }
    if (harnessId === 'kimi') {
      $('connectionInfo').hidden = false;
      $('connectionInfo').textContent = accountSubscription() ? 'Kimi subscription · Manage account' : 'Shared API routes · Connection settings';
    }
    if (harnessId === 'antigravity') {
      $('connectionInfo').hidden = false;
      $('connectionInfo').textContent = googleSubscription() ? 'Google subscription · Manage account' : 'Shared API routes · Connection settings';
      $('selPermission').querySelector('[value="ask"]').textContent = googleSubscription() ? 'CLI defaults' : 'Ask before acting';
      $('selPermission').title = googleSubscription() ? 'CLI permission rules apply. Tools requiring interactive review are declined in headless mode.' : '';
    }
    currentPermission = permissionLevel(harnessId, s.permissionMode || chatProfile.permission);
    $('selPermission').value = currentPermission;
    currentLevel = s.thinkingBudget || '';
    currentModel = s.model || '';
    // Keep previously saved custom model selectable even if not in the list.
    if (currentModel && !MODELS.some((m) => m.id === currentModel)) {
      MODELS.push({ id: currentModel, label: currentModel });
    }
    renderModelPill();
  }

  function applyCodexLevels() {
    const model = accountModels.find(m => m.id === currentModel);
    const efforts = accountSubscription() ? (model?.supportedReasoningEfforts || []).map(e => e.reasoningEffort) : ['low', 'medium', 'high'];
    LEVELS.splice(0, LEVELS.length, { id: '', label: 'Default' }, ...efforts.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })));
  }
  async function loadSettings() {
    const seq = ++settingsLoadSeq, sessionId = context.sessionId;
    try {
      const selected = await chatApi.getSettings({ sessionId });
      if (selected.ok === false) throw new Error(selected.error);
      const subscription = ['codex', 'kimi', 'antigravity'].includes(harnessId) && selected.connection === 'subscription';
      // Subscription composers also offer the shared API routes as a group.
      const [state, routerState] = await Promise.all([
        subscription ? window.dshDesktop[harnessId + 'AccountState']() : window.dshDesktop.apiRouterGetState(),
        subscription ? window.dshDesktop.apiRouterGetState() : Promise.resolve(null),
      ]);
      if (seq !== settingsLoadSeq || sessionId !== context.sessionId) return;
      if (subscription) routeModels = routerState?.enabled && Array.isArray(routerState.models) ? routerState.models : [];
      applySessionSettings(selected);
      if (subscription) {
        const account = state;
        accountModels = account.models || [];
        if (!account.ok) throw new Error(account.error);
        MODELS.splice(0, MODELS.length, { id: '', label: account.models.length ? 'Select model' : 'Connect ' + accountName + ' in settings' },
          ...account.models.map(model => ({ id: model.id, label: model.name })));
        if (currentModel && !account.models.some(model => model.id === currentModel)) MODELS.push({ id: currentModel, label: currentModel + ' (refresh account)' });
        $('modelPill').title = 'Models available to your ' + accountName + ' account';
        renderModelPill();
      } else applyRouterModels(state);
      if (harnessId === 'codex') applyCodexLevels();
    } catch (error) { setStatus("Could not load settings: " + error.message); }
  }

  window.dshDesktop.onEngineSettingsChanged(({ engine }) => { if (engine === harnessId) void loadSettings(); });
  window.dshDesktop.onArchivedChanged?.(({ id, action }) => {
    if (action === 'delete' && context.sessionId === id) void newSession(null);
    else void sidebar.load();
  });

  sidebar.render();
  void goalUI.refresh();
  chatApi.onEvent((ev) => handleEvent(ev));
  void (async () => {
    input.disabled = true;
    await sidebar.load();
    if (!sharedChat && harnessId !== 'claude') await restoreLiveRun();
    const previous = sharedChat ? readUi('location') : null;
    const id = new URLSearchParams(location.search).get('conversation') || previous?.sessionId;
    if (!running) {
      if (id) await openHistorySession(id);
      else if (previous?.workspaceId && sidebar.workspaces.some(w => w.id === previous.workspaceId)) context.workspaceId = previous.workspaceId;
    }
    restoringRun = false; eventsDuringRestore.length = 0;
    await loadSettings();
    await goalUI.refresh();
    restoreDraft(); uiReady = true; input.disabled = false; saveDraft(); sidebar.render();
  })().catch(error => { input.disabled = false; setStatus('Could not restore the conversation: ' + error.message); });
  window.dshDesktop.onApiRouterState(applyRouterModels);

  $('engineSwitch').value = harnessId;
  $('engineSwitch').disabled = !sharedChat;
  $('handoffBtn').hidden = !sharedChat;
  async function switchConversation(target, mode) {
    if (switchingEngine || conversationBusy() || sending || loadingSession) { setStatus('Available when this conversation stops working'); return; }
    switchingEngine = true; $('engineSwitch').disabled = true; $('handoffBtn').disabled = true; $('handoffStop').hidden = false; input.disabled = true;
    saveDraft();
    setStatus('Preparing conversation…');
    try {
      if (!context.sessionId && currentConnection !== 'subscription' && currentModel) {
        const saved = await chatApi.saveSettings({ model: currentModel });
        if (!saved.ok) throw new Error(saved.error);
      }
      const result = await window.dshDesktop.conversationSwitch({ engine: target, sessionId: context.sessionId, mode });
      if (!result.ok) throw new Error(result.error);
    } catch (error) { setStatus(error.message); }
    finally { switchingEngine = false; updateConversationControls(); $('engineSwitch').value = harnessId; $('handoffStop').hidden = true; input.disabled = false; }
  }
  async function switchOptions(target, force = false) {
    if (conversationBusy() || sending || loadingSession) { setStatus('Available when this conversation stops working'); return; }
    const settings = await window.dshDesktop.workbenchSettings(); conversationPrefs = settings.conversations || conversationPrefs;
    if (force || conversationPrefs.warnOnSwitch && context.sessionId) {
      $('switchTarget').value = target; $('switchMethod').value = force ? 'markdown' : conversationPrefs.mode; $('switchDialog').showModal();
    } else await switchConversation(target, conversationPrefs.mode);
  }
  $('engineSwitch').onchange = () => { const target = $('engineSwitch').value; $('engineSwitch').value = harnessId; void switchOptions(target); };
  window.dshDesktop.onHarnessNavigate?.(target => { if (target !== harnessId) void switchOptions(target); });
  $('handoffBtn').onclick = () => void switchOptions(harnessId, true);
  $('switchCancel').onclick = () => $('switchDialog').close();
  $('switchConfirm').onclick = () => { $('switchDialog').close(); void switchConversation($('switchTarget').value, $('switchMethod').value); };
  $('handoffStop').onclick = () => void chatApi.cancel(sharedChat ? { sessionId: context.sessionId } : currentRunId);
  if (sharedChat) window.dshDesktop.onConversationStatus(({ sessionId, text }) => { if (sessionId !== context.sessionId) return; $('handoffStop').hidden = !text; if (text) setStatus(text); });
