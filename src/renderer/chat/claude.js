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
  let currentRunId = null;
  let acceptSessionEvents = false;
  let restoringRun = harnessId === 'kimi';
  const eventsDuringRestore = [];
  let resumeNext = false;
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
  let permRequestId = null;   // pending can_use_tool control request id
  const permissionQueue = [];

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
  if (harnessId === 'kimi') LEVELS.splice(1);
  let currentModel = '';
  let currentLevel = '';

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
    return m ? m.label : id || "Default model";
  }
  function levelLabel(id) {
    const l = LEVELS.find((x) => x.id === id);
    return l ? l.label : 'Default';
  }
  function renderModelPill() {
    $('modelPillName').textContent = modelLabel(currentModel);
    $('modelPillLevel').textContent = currentLevel ? levelLabel(currentLevel) : '';
  }

  async function persistModel(model) {
    currentModel = model;
    if (harnessId === 'kimi') { currentLevel = ''; LEVELS.splice(1); }
    renderModelPill();
    await chatApi.saveSettings({ model, ...(harnessId === 'kimi' ? { thinkingBudget: '' } : {}) });
    setStatus("Model changed: " + modelLabel(model) + " (applies to the next message)");
  }
  async function persistLevel(level) {
    currentLevel = level;
    renderModelPill();
    await chatApi.saveSettings({ thinkingBudget: level });
    setStatus("Reasoning level changed: " + levelLabel(level) + " (applies to the next message)");
  }

  function chevRight() {
    return '<svg class="pop-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
  }
  function checkMark() {
    return '<svg class="pop-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
  }

  function openSubMenu(rowEl, title, options, currentId, onPick) {
    // Remove existing sibling submenus first (keep the root menu).
    const root = openPops[0];
    for (const p of openPops.slice(1)) p.remove();
    openPops = openPops.slice(0, 1);
    const rowRect = rowEl.getBoundingClientRect();
    const sub = document.createElement('div');
    sub.className = 'dsh-pop';
    sub.style.minWidth = '220px';
    if (title) {
      const g = document.createElement('div');
      g.className = 'pop-group';
      g.textContent = title;
      sub.appendChild(g);
    }
    for (const o of options) {
      const el = document.createElement('div');
      el.className = 'pop-opt' + (o.id === currentId ? ' current' : '');
      el.innerHTML = '<span></span>' + checkMark();
      el.querySelector('span').textContent = o.label;
      el.addEventListener('click', () => { void onPick(o.id); closePops(); });
      sub.appendChild(el);
    }
    document.body.appendChild(sub);
    sub.style.visibility = 'hidden';
    const rootRect = root.getBoundingClientRect();
    sub.style.left = Math.max(8, rootRect.left - sub.offsetWidth - 8) + 'px';
    clampPopPosition(sub, rowRect.top - 6, null);
    sub.style.visibility = '';
    openPops.push(sub);
  }

  function openModelMenu() {
    if (openPops.length) { closePops(); return; }
    $('modelPill').classList.add('open');
    const rect = $('modelPill').getBoundingClientRect();
    showPop(rect, (pop) => {
      const rowModel = document.createElement('div');
      rowModel.className = 'pop-row';
      rowModel.innerHTML = "<span>Model</span><span class=\"pop-row-value\"></span>" + chevRight();
      rowModel.querySelector('.pop-row-value').textContent = modelLabel(currentModel);
      rowModel.addEventListener('click', () => {
        openSubMenu(rowModel, "Model · Same-model failover", MODELS, currentModel, persistModel);
      });
      const rowLevel = document.createElement('div');
      rowLevel.className = 'pop-row';
      rowLevel.innerHTML = "<span>Reasoning level</span><span class=\"pop-row-value\"></span>" + chevRight();
      rowLevel.querySelector('.pop-row-value').textContent = levelLabel(currentLevel);
      rowLevel.addEventListener('click', () => {
        openSubMenu(rowLevel, '', LEVELS, currentLevel, persistLevel);
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
        d.className = 'pop-group';
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
      g.className = 'pop-group';
      g.textContent = "Last turn";
      pop.appendChild(g);
      for (const [k, v] of rows) {
        const el = document.createElement('div');
        el.className = 'pop-row';
        el.innerHTML = '<span></span><span class="pop-row-value"></span>';
        el.querySelector('span').textContent = k;
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
    for (const p of paths || []) {
      if (!p) continue;
      if (attachments.some((a) => a.path === p)) continue;
      attachments.push({ path: p, name: String(p).split(/[\\/]/).pop(), isImage: isImagePath(p) });
    }
    renderAttachments();
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
  }

  $('attachBtn').addEventListener('click', async () => {
    const res = await window.dshDesktop.pickAttachments();
    if (res && !res.canceled && res.paths && res.paths.length) addAttachments(res.paths);
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
  function addUser(text, atts) {
    const was = nearBottom();
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg-user';
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
    chat.appendChild(div);
    maybeScroll(was);
  }

  function ensureTurn() {
    if (turnEl) return turnEl;
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'turn';
    div.innerHTML =
      '<div class="turn-meta"><div class="turn-avatar">' + chatProfile.initial + '</div><span>' + chatProfile.shortName + '</span></div>' +
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
      el.innerHTML = '<span class="pulse"></span><span class="run-text"></span><span class="run-clock"></span>';
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
    if (!parts.length && c.completed) parts.push(c.completed + " Completed");
    else if (c.completed) parts.push(c.completed + " Completed");
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
      "  <span>Task</span><span class=\"todo-counts\"></span>" +
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
      "<div class=\"think-head\"><span class=\"arrow\">▶</span><span>💭 Reasoning</span><span class=\"think-status\">In progress…</span></div>" +
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
      "  <div class=\"tool-section-label\">Input</div>" +
      '  <div class="tool-code tool-input"></div>' +
      "  <div class=\"tool-section-label\">Output</div>" +
      "  <div class=\"tool-output\">Waiting for result…</div>" +
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
      const cur = b.el && b.el.querySelector && b.el.querySelector('.cursor');
      if (cur) cur.remove();
    }
    blocks = {};
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

  function resultStats(ev) {
    const parts = [];
    if (ev.num_turns != null) parts.push(ev.num_turns + " ");
    parts.push("Elapsed " + (ev.duration_ms != null ? fmtDuration(ev.duration_ms) : fmtDuration(Date.now() - runStartedAt)));
    if (ev.total_cost_usd != null) parts.push('$' + Number(ev.total_cost_usd).toFixed(4));
    const u = ev.usage;
    if (u) {
      lastUsage = u;
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      parts.push("Input " + fmtTokens(input) + ' tok');
      parts.push("Output " + fmtTokens(u.output_tokens) + ' tok');
      if (u.cache_read_input_tokens) parts.push("Cache hit " + fmtTokens(u.cache_read_input_tokens) + ' tok');
    }
    return parts;
  }

  function setRunning(v) {
    running = v;
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
    if (restoringRun) { eventsDuringRestore.push(ev); return; }
    if (!acceptSessionEvents) return;
    if (currentRunId != null && ev.runId != null && currentRunId !== ev.runId) return;
    const was = nearBottom();

    if (ev.type === 'system' && ev.subtype === 'init') {
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
    if (ev.type === 'gui:config' && harnessId === 'kimi') {
      const thinking = (ev.options || []).find(option => option.id === 'thinking');
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
      permRequestId = null;
      permissionQueue.length = 0;
      $('permMask').classList.remove('visible');
      finalizeStreamBlocks();
      clearRunStatus();
      const stopped = ev.subtype === 'stopped';
      const ok = !ev.is_error && ev.subtype !== 'error_max_turns' && !stopped;
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
    sendBtn.disabled = loadingSession || (!running && !input.value.trim() && !attachments.length);
  }

  async function send() {
    if (running) {
      if (currentRunId) {
        await chatApi.cancel(currentRunId);
        setStatus("Stopping…");
      }
      return;
    }
    if (!canChangeContext()) return;
    const text = input.value.trim();
    const atts = attachments.slice();
    if (!text && !atts.length) return;
    input.value = '';
    attachments = [];
    renderAttachments();
    autoResize();
    addUser(text || "[Attachments]", atts);
    if (!context.sessionId && !$('headerTitle').dataset.titled && text) {
      $('headerTitle').textContent = text.length > 24 ? text.slice(0, 24) + '…' : text;
      $('headerTitle').dataset.titled = '1';
    }
    setRunning(true);
    acceptSessionEvents = true;
    sidebar.render();
    let res;
    try {
      const settings = await chatApi.getSettings();
      res = await chatApi.send({
        prompt: buildPrompt(text, atts),
        attachments: atts,
        sessionId: context.sessionId || null,
        workspaceId: context.workspaceId,
        resumeLast: resumeNext,
        fork: Boolean(pendingForkId),
        settings: settings || {},
      });
    } catch (err) { res = { ok: false, error: err.message }; }
    resumeNext = false;
    if (!res || !res.ok) {
      finalizeStreamBlocks();
      const chip = document.createElement('div');
      chip.className = 'run-result err';
      chip.textContent = "Failed to start: " + ((res && res.error) || "Unknown error");
      chat.appendChild(chip);
      setStatus("Failed to start");
      setRunning(false);
      acceptSessionEvents = false;
      return;
    }
    if (pendingForkId) {
      pendingForkId = null;
      if (running) setStatus("Forking session…");
    }
    if (running) currentRunId = res.runId;
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(Math.max(input.scrollHeight, 52), 180) + 'px';
  }
  input.addEventListener('input', () => {
    autoResize();
    if (!running) updateSendEnabled();
  });
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  async function newSession(workspaceId = null) {
    if (!canChangeContext()) return;
    ++sessionOpenSeq;
    closePops();
    acceptSessionEvents = false;
    currentRunId = null;
    context.sessionId = null;
    context.workspaceId = workspaceId;
    pendingForkId = null;
    turnEl = null;
    blocks = {};
    pendingTools = {};
    todoItems = null;
    if (todoPanelEl) { todoPanelEl.remove(); todoPanelEl = null; }
    resumeNext = false;
    $('headerTitle').textContent = "New session";
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
    setStatus(workspaceId ? "New workspace session created" : "Standalone session · No workspace");
    input.focus();
  }
  $('newSessionBtn').addEventListener('click', () => void newSession(null));

  $('resumeLastBtn').addEventListener('click', async () => {
    if (!canChangeContext()) return;
    if (!await sidebar.load()) return;
    if (sidebar.latestSessionId) await openHistorySession(sidebar.latestSessionId);
    else setStatus("No sessions yet. Send a message to start.");
  });

  $('backToDsh').addEventListener('click', () => window.dshDesktop.switchMode('dsh'));
  $('backToHome').addEventListener('click', () => window.dshDesktop.switchMode('home'));

  // Permission select auto-persists (applies to the next run).
  $('selPermission').addEventListener('change', async () => {
    await chatApi.saveSettings({ permissionMode: $('selPermission').value });
    setStatus("Permission mode saved. Applies to the next message.");
  });

  // ---------- P3: permission dialog ----------
  function showPermissionDialog(ev) {
    permRequestId = ev.requestId;
    $('permTool').textContent = "Tool: " + (ev.toolName || "(Unknown)");
    const data = ev.input || {};
    $('permInput').textContent = typeof data.command === 'string' ? data.command : JSON.stringify(data, null, 2);
    $('permOptions').replaceChildren();
    $('permDefaultActions').hidden = Boolean(ev.options);
    if (ev.options) {
      for (const option of ev.options) {
        const button = document.createElement('button');
        button.className = option.kind.startsWith('allow') ? 'perm-allow' : 'perm-deny';
        button.textContent = ({ 'Approve once': "Allow once", 'Approve for this session': "Allow for this session", 'Reject': "Deny" })[option.name] || option.name;
        button.addEventListener('click', () => void answerPermission(false, option.optionId));
        $('permOptions').appendChild(button);
      }
      const cancel = document.createElement('button');
      cancel.className = 'perm-deny';
      cancel.textContent = "Cancel";
      cancel.addEventListener('click', () => void answerPermission(false));
      if (!ev.options.some(option => option.kind.startsWith('reject'))) $('permOptions').appendChild(cancel);
    }
    $('permMask').classList.add('visible');
  }
  async function answerPermission(allow, optionId) {
    if (!permRequestId) return;
    const answered = permRequestId;
    await chatApi.controlRespond({ requestId: answered, allow, optionId });
    if (permRequestId !== answered) return;
    permRequestId = null;
    permissionQueue.shift();
    $('permMask').classList.remove('visible');
    if (permissionQueue.length) showPermissionDialog(permissionQueue[0]);
  }
  $('permAllow').addEventListener('click', () => void answerPermission(true));
  $('permDeny').addEventListener('click', () => void answerPermission(false));

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
  function contextBusy() {
    return running || loadingSession || goalUI.isActive();
  }
  function canChangeContext() {
    if (!contextBusy()) return true;
    setStatus("Stop the current response or pause the goal before switching sessions or workspaces");
    return false;
  }
  const sidebar = createClaudeSidebar({ $, context, contextBusy, canChangeContext, setStatus,
    newSession, openHistorySession, forkSession, openActionMenu, closePops });
  const goalUI = createClaudeGoalUI({ $, context, canChangeContext, openHistorySession, setStatus,
    acceptEvents: () => { acceptSessionEvents = true; }, onChange: () => sidebar.updateLabel() });

  let pendingForkId = null;
  async function forkSession(s) {
    if (!await openHistorySession(s.id)) return;
    pendingForkId = s.id;
    setStatus("The next message will fork this session and keep its workspace");
    input.focus();
  }
  async function openHistorySession(id) {
    if (!canChangeContext()) return false;
    const seq = ++sessionOpenSeq;
    loadingSession = true;
    updateSendEnabled();
    sidebar.updateLabel();
    setStatus("Loading history…");
    try {
      const res = await chatApi.loadSession(id);
      if (seq !== sessionOpenSeq) return false;
      if (!res || !res.ok) throw new Error((res && res.error) || "Could not read session");
      const s = sidebar.sessions.find((entry) => entry.id === id);
      context.sessionId = id;
      context.workspaceId = res.workspaceId || null;
      acceptSessionEvents = false;
      currentRunId = null;
      pendingForkId = null;
      resumeNext = false;
      turnEl = null;
      blocks = {};
      pendingTools = {};
      todoItems = null;
      todoPanelEl = null;
      hideSuggestion();
      chat.innerHTML = '';
      $('headerTitle').textContent = s ? s.title : "Session " + id.slice(0, 8);
      $('headerTitle').dataset.titled = '1';
      renderHistoryMessages(res.messages || []);
      if (!chat.childElementCount) chat.innerHTML = "<div class=\"empty-state\"><div class=\"empty-state-desc\">No messages to display. Send a message to continue this session.</div></div>";
      sidebar.render();
      chatScroll.scrollTop = chatScroll.scrollHeight;
      setStatus(res.truncated ? "Showing the latest 200 messages. Continuation uses the full history." : "History loaded. Your next message continues this session.");
      return true;
    } catch (err) { setStatus("Could not load: " + err.message); return false; }
    finally {
      if (seq === sessionOpenSeq) { loadingSession = false; updateSendEnabled(); sidebar.updateLabel(); }
    }
  }

  function renderHistoryMessages(messages) {
      for (const m of messages) {
        if (m.role === 'user') addUser(m.text);
        else {
          const div = document.createElement('div');
          div.className = 'turn';
          div.innerHTML = '<div class="turn-meta"><div class="turn-avatar">' + chatProfile.initial + '</div><span>' + chatProfile.shortName + '</span></div><div class="turn-body"><div class="md"></div></div>';
          div.querySelector('.md').innerHTML = mdRender(m.text);
          chat.appendChild(div);
        }
      }
  }

  async function restoreLiveRun() {
    let lastSeq = 0;
    try {
      const { live } = await chatApi.getLive();
      restoringRun = false;
      if (!live) return;
      context.sessionId = live.sessionId;
      context.workspaceId = live.workspaceId;
      currentRunId = live.runId;
      acceptSessionEvents = true;
      chat.innerHTML = '';
      renderHistoryMessages(live.messages);
      addUser(live.prompt);
      $('headerTitle').textContent = live.prompt.slice(0, 24) || "Active session";
      $('headerTitle').dataset.titled = '1';
      setRunning(true);
      sidebar.render();
      for (const event of live.events) handleEvent(event);
      lastSeq = live.eventSeq;
    } catch (error) { setStatus("Could not restore the active run: " + error.message); }
    finally {
      restoringRun = false;
      for (const event of eventsDuringRestore.splice(0)) if (event.eventSeq > lastSeq) handleEvent(event);
    }
  }

  // ---------- settings panel ----------
  $('settingsBtn').addEventListener('click', () => { closePops(); void window.dshDesktop.openSettingsWindow({ page: 'engines', engine: harnessId }); });
  function applyRouterModels(state) {
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

  async function loadSettings() {
    const s = await chatApi.getSettings();
    if (!s) return;
    $('selPermission').value = s.permissionMode || chatProfile.permission;
    currentLevel = s.thinkingBudget || '';
    currentModel = s.model || '';
    // Keep previously saved custom model selectable even if not in the list.
    if (currentModel && !MODELS.some((m) => m.id === currentModel)) {
      MODELS.push({ id: currentModel, label: currentModel });
    }
    renderModelPill();
    if (window.dshDesktop.apiRouterGetState) applyRouterModels(await window.dshDesktop.apiRouterGetState());
  }

  window.dshDesktop.onEngineSettingsChanged(({ engine }) => { if (engine === harnessId) void loadSettings(); });

  sidebar.render();
  void loadSettings();
  void sidebar.load();
  void goalUI.refresh();
  chatApi.onEvent((ev) => handleEvent(ev));
  if (harnessId === 'kimi') void restoreLiveRun();
  if (window.dshDesktop.onApiRouterState) window.dshDesktop.onApiRouterState(applyRouterModels);
