'use strict';

const $ = (id) => document.getElementById(id);
const context = { sessionId: null, workspaceId: null };
let discussionVisible = false, discussionOpening = false, discussionSurface, discussionNavigationSeq = 0;
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
  let restoringRun = true;
  let switchingEngine = false;
  let conversationPrefs = { mode: 'direct', warnOnSwitch: false, showOrigin: false };
  let loadedEngine = harnessId;
  const eventsDuringRestore = [];
  let turnEl = null;          // current assistant turn container
  let turnEngine = null;      // harness that owns the in-flight turn, which may differ from this page's
  let blocks = {};            // stream block index -> { type, raw, el, ... }
  let pendingTools = {};      // tool_use_id -> card handle
  let runStartedAt = 0;
  let runTimer = null;
  let lastUsage = null;       // usage object from the last result event
  let lastCallUsage = null;   // usage of the latest single API call in the turn
  let contextUsage = null;
  let attachments = [];       // [{ path, name, isImage }]
  let messageQueue = [];
  let messageQueuePaused = false;
  let remoteMessageQueue = [], remoteQueueVersion = -1;
  const conversationQueues = new Map();
  let drainingQueue = false;
  let openPops = [];          // currently open popover elements
  let runAnchorMs = 0;        // timestamp of message_start (drives the 15s clock)
  let statusClockTimer = null;
  let followRunOutput = false;
  let userScrollActive = false;
  let userScrollIntentUntil = 0;
  let followScrollFrame = null;
  let todoItems = null;       // latest task snapshot: [{ content, status, activeForm }]
  let todoPanelEl = null;

  let sessionOpenSeq = 0;
  let loadingSession = false;
  let historyOpening = false;
  let editingMessage = null;
  const failedMessageEdits = new Map();
  let permRequestId = null;   // pending can_use_tool control request id
  const permissionQueue = [];
  const seenPermissionBlocks = new Set();
  let pendingQuestion = null, permissionSubmission = null;
  let textChoice = null, textChoiceTimer = null;
  const questionDrafts = new Map();
  const selfDeletedIds = new Set();

  // Offline defaults; a configured pool supplies its explicit model groups.
  const MODELS = [];
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
  let currentFastMode = false, savingFastMode = false;
  // Three universal automation levels; stored native values fold into them.
  function permissionLevel(engine, value) {
    if (['ask', 'auto', 'full'].includes(value)) return value;
    if (value === 'default') return engine === 'dsh' ? 'auto' : 'ask';
    return { plan: 'ask', acceptEdits: 'auto', auto: 'auto', 'workspace-write': 'auto',
      bypassPermissions: 'full', yolo: 'full', 'danger-full-access': 'full' }[value] || 'ask';
  }
  let currentPermission = chatProfile.permission;
  let currentConnection = 'api';
  const supportsAccounts = () => ['codex', 'kimi', 'antigravity'].includes(harnessId);
  const accountSubscription = () => supportsAccounts() && currentConnection === 'subscription';
  const accountName = { codex: 'ChatGPT', kimi: 'Kimi', antigravity: 'Google' }[harnessId];
  let accountModels = [];
  let hiddenSubscriptionModels = {};
  const visibleAccountModels = () => window.CamelliaSubscriptionModels.visibleModels(accountModels, hiddenSubscriptionModels, harnessId);
  let routeModels = [];
  let routeModelCatalog = {};
  const googleSubscription = () => harnessId === 'antigravity' && currentConnection === 'subscription';
  // A session saved before the Google catalog was grouped still names a single
  // effort row; show it as its base model, which now owns the effort timeline.
  const accountFamily = id => accountModels.find(model => model.id === id
    || model.modelIds && Object.values(model.modelIds).includes(id)) || null;
  let uiReady = false, sending = false, settingsLoadSeq = 0;
  const pendingConversationSends = new Map();
  function pendingConversationSend() { return pendingConversationSends.get(context.sessionId); }
  const uiPrefix = 'camellia-chat-';
  const cleanupReferenceIdentities = { draft: '', queue: '' };
  const draftKey = (id = context.sessionId, workspace = context.workspaceId) => id || 'new:' + (workspace || 'standalone');
  function readUi(key) {
    try { return JSON.parse(localStorage.getItem(uiPrefix + key)); } catch { return null; }
  }
  function writeUi(key, value) {
    const kind = key.startsWith('draft:') ? 'draft' : key.startsWith('queue:') ? 'queue' : null;
    if (kind) {
      const files = kind === 'draft' ? value.attachments || [] : value.flatMap(entry => entry.attachments || []);
      const identity = key + JSON.stringify(files.map(file => [file.path, file.fullPath]));
      if (cleanupReferenceIdentities[kind] !== identity) {
        cleanupReferenceIdentities[kind] = identity;
        void window.dshDesktop.storageReferencesChanged?.();
      }
    }
    try { localStorage.setItem(uiPrefix + key, JSON.stringify(value)); }
    catch { setStatus('Could not save the draft on this computer. Keep this page open until you copy or send it.'); }
  }
  function saveDraft() {
    if (discussionVisible) return;
    if (!uiReady || loadingSession || (sending && !pendingConversationSend())) return;
    writeUi('draft:' + draftKey(), { text: input.value, attachments, pendingForkId,
      codexFastMode: harnessId === 'codex' ? currentFastMode : readUi('draft:' + draftKey())?.codexFastMode === true });
    writeUi('location', { sessionId: context.sessionId, workspaceId: context.workspaceId });
  }
  function restoreDraft() {
    const saved = readUi('draft:' + draftKey());
    input.value = typeof saved?.text === 'string' ? saved.text : '';
    attachments = Array.isArray(saved?.attachments) ? saved.attachments : [];
    pendingForkId = saved?.pendingForkId || null;
    if (harnessId === 'codex' && !context.sessionId) { currentFastMode = saved?.codexFastMode === true; renderFastMode(); }
    restoreMessageQueue();
    renderAttachments(); autoResize(); updateSendEnabled();
  }
  function saveMessageQueue(key = draftKey(), queue = messageQueue) {
    conversationQueues.set(key, queue);
    writeUi('queue:' + key, queue);
    if (!queue.length && key === draftKey() && queue === messageQueue) setMessageQueuePaused(false);
  }
  function setMessageQueuePaused(paused) {
    messageQueuePaused = Boolean(paused);
    writeUi('queue-paused:' + draftKey(), messageQueuePaused);
    renderMessageQueue();
  }
  function restoreMessageQueue() {
    const key = draftKey();
    const saved = conversationQueues.get(key) || readUi('queue:' + key);
    messageQueue = Array.isArray(saved) ? saved : [];
    messageQueuePaused = messageQueue.length > 0 && readUi('queue-paused:' + key) === true;
    if (context.sessionId) conversationQueues.set(key, messageQueue);
    renderMessageQueue();
  }
  window.addEventListener('beforeunload', saveDraft);
  let scrollSaveTimer;
  chatScroll.addEventListener('scroll', () => {
    if (running && (userScrollActive || performance.now() < userScrollIntentUntil)) followRunOutput = nearBottom();
    clearTimeout(scrollSaveTimer); scrollSaveTimer = setTimeout(saveDraft, 120);
  });
  chatScroll.addEventListener('wheel', event => {
    userScrollIntentUntil = performance.now() + 250;
    if (running && event.deltaY < 0) followRunOutput = false;
  }, { passive: true });
  chatScroll.addEventListener('touchstart', () => { userScrollActive = true; }, { passive: true });
  chatScroll.addEventListener('touchend', () => { userScrollActive = false; userScrollIntentUntil = performance.now() + 250; }, { passive: true });
  chatScroll.addEventListener('pointerdown', () => { userScrollActive = true; });
  window.addEventListener('pointerup', () => { userScrollActive = false; userScrollIntentUntil = performance.now() + 250; });

  const SENT = '\x01'; // escaped SOH sentinel — never appears in prose

  // ---------- helpers ----------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // A replayed turn can hand reasoning back as `<thinking>…</thinking>` text,
  // which the next model then mimics. Split it out so the answer stays clean
  // and the reasoning folds into a Reasoning block instead of showing markup.
  function splitThinking(text) {
    const api = window.CamelliaThinkingTags;
    return api ? api.split(text, { latestOnly: true }) : { body: String(text == null ? '' : text), thinking: '' };
  }
  // The answer as the reader sees it, without any folded reasoning delimiters.
  function answerText(text) { return splitThinking(text).body; }

  function splitTableRow(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = [];
    let cell = '';
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '\\' && value[i + 1] === '|') {
        cell += '|';
        i++;
      } else if (value[i] === '|') {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += value[i];
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function tableDelimiter(line) {
    if (!line.includes('|')) return null;
    const cells = splitTableRow(line);
    if (!cells.length || cells.some(cell => !/^:?-{3,}:?$/.test(cell))) return null;
    return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
  }

  function isRule(line) {
    return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
  }

  function isQuote(line) {
    return /^\s{0,3}>\s?/.test(line);
  }

  function listMatch(line) {
    return /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.*)$/.exec(line);
  }

  // Four leading spaces (or a tab) start an indented code block. The blank-line
  // separator this chat layout keeps between blocks is tolerated, so a code
  // block can be pasted with or without surrounding blank lines.
  function indentCodeWidth(line) {
    if (!line.trim()) return null;
    return /^ {4}/.test(line) ? 4 : /^\t/.test(line) ? 1 : null;
  }

  // A line with no marker of its own continues the item above it, so bilingual
  // text such as a translation stays attached to its title. A blank line or a
  // line that opens another block ends the list instead. A fenced code block,
  // display formula or table is already a placeholder here, and an unindented
  // block cannot belong to the item above it.
  function listContinuation(line) {
    if (!line.trim()) return false;
    if (new RegExp('^' + SENT + '\\d+' + SENT + '$').test(line.trim())) return false;
    if (isQuote(line) || isRule(line)) return false;
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return false;
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) return false;
    if (/^\s*\$\$/.test(line)) return false;
    return true;
  }

  // One list block, including nested indentation and GitHub task checkboxes.
  function parseList(lines, start) {
    const base = listMatch(lines[start]);
    const baseIndent = base[1].length;
    const ordered = Boolean(base[3]);
    const items = [];
    let index = start;
    while (index < lines.length) {
      const match = listMatch(lines[index]);
      if (!match) {
        if (items.length && listContinuation(lines[index])) {
          items[items.length - 1].text += '\n' + lines[index].trim();
          index++;
          continue;
        }
        break;
      }
      const indent = match[1].length;
      if (indent < baseIndent || (indent === baseIndent && Boolean(match[3]) !== ordered)) break;
      if (indent > baseIndent && items.length) {
        const nested = parseList(lines, index);
        items[items.length - 1].children.push(nested.list);
        index = nested.next;
        continue;
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(match[4]);
      items.push({
        task: task ? task[1].toLowerCase() === 'x' : null,
        text: task ? task[2] : match[4],
        children: [],
      });
      index++;
    }
    return { next: index, list: { ordered, start: ordered ? Number(base[3]) : 1, items } };
  }

  // Chat block layout with Markdown inline formatting and file links.
  let codeWrap = readUi('code-wrap') === true;
  function codeWrapLabel() { return window.CamelliaI18n.t('Word wrap'); }
  function codeWrapIcon() {
    const path = codeWrap ? 'M12 3v5m0 8v5M3 12h18m-4-4 4 4-4 4' : 'M21 3v18M3 7h8a4 4 0 0 1 0 8H3m4-4-4 4 4 4';
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' + path + '"/></svg>';
  }
  function refreshCodeWrap() {
    document.querySelectorAll('.md-code-block').forEach(panel => {
      panel.classList.toggle('is-wrapped', codeWrap);
      const button = panel.querySelector('.md-code-wrap');
      button.setAttribute('aria-pressed', String(codeWrap));
      button.setAttribute('aria-label', codeWrapLabel());
      button.title = codeWrapLabel();
      button.innerHTML = codeWrapIcon();
    });
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.md-code-wrap')) return;
    codeWrap = !codeWrap;
    writeUi('code-wrap', codeWrap);
    refreshCodeWrap();
  });
  window.addEventListener('camellia:language', refreshCodeWrap);
  function refreshCodeCopy(button) {
    const copied = button.dataset.copied === 'true';
    const label = window.CamelliaI18n.t(copied ? 'Code copied' : 'Copy code');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (copied ? '<path d="m5 12 4 4L19 6"/>' : '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>') + '</svg>';
  }
  function codeCopyButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-code-copy';
    refreshCodeCopy(button);
    return button.outerHTML;
  }
  // The LaTeX preview is rendered locally with the bundled KaTeX build, so a
  // LaTeX distribution is never required. The button and its panel only appear
  // for blocks whose language is LaTeX/TeX.
  function isLatexLanguage(language) {
    return /^(?:latex|tex|ltx)$/i.test(String(language || '').trim());
  }
  function latexPreviewLabel() { return window.CamelliaI18n.t('Preview formula'); }
  function latexPreviewIcon() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 5h18M3 12h4.5M10 5 7 19M14.5 5v14M17 9.5c.6-1.8 1.8-2.7 3.6-2.7"/></svg>';
  }
  function latexPreviewButton() {
    const label = esc(latexPreviewLabel());
    return '<button type="button" class="md-code-latex" aria-expanded="false" aria-label="' + label + '" title="' + label + '">' +
      latexPreviewIcon() + '</button>';
  }
  function latexPreviewMarkup() {
    const close = esc(window.CamelliaI18n.t('Close'));
    return '<div class="md-latex-panel" translate="no" hidden><div class="md-latex-head"><strong>' +
      esc(window.CamelliaI18n.t('Formula preview')) + '</strong><button type="button" class="md-latex-close" aria-label="' + close + '" title="' + close + '">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      '<p class="md-latex-notice" hidden></p><div class="md-latex-body"></div></div>';
  }
  function latexBlockText(block) {
    return block?.querySelector('.md-code > code')?.textContent || '';
  }
  function renderLatexPanel(block) {
    const panel = block.querySelector('.md-latex-panel');
    const body = panel.querySelector('.md-latex-body');
    const notice = panel.querySelector('.md-latex-notice');
    const source = latexBlockText(block).slice(0, 20001);
    const language = window.CamelliaI18n.language;
    if (panel.previewSource === source && panel.previewLanguage === language) return;
    const result = window.CamelliaLatexPreview.render(source);
    if (result.katex) { panel.previewSource = source; panel.previewLanguage = language; }
    notice.hidden = true; notice.textContent = '';
    if (!result.katex) {
      panel.dataset.state = 'error';
      notice.hidden = false;
      notice.textContent = window.CamelliaI18n.t('KaTeX is still loading; retrying when the preview opens.');
      body.replaceChildren();
      return;
    }
    if (result.empty) {
      panel.dataset.state = 'ready';
      notice.hidden = false;
      notice.textContent = window.CamelliaI18n.t('This LaTeX block has no formula to preview.');
      body.replaceChildren();
      return;
    }
    notice.hidden = false;
    notice.textContent = window.CamelliaI18n.t('Rendered without a LaTeX compiler.') + ' · KaTeX ' + result.version;
    if (result.truncated) notice.textContent += ' ' + window.CamelliaI18n.t('Only the first 20000 characters are previewed.');
    const nodes = result.blocks.map(entry => {
      const node = document.createElement('div');
      node.className = 'md-latex-block';
      if (entry.error) {
        node.classList.add('is-error');
        const title = document.createElement('p'); title.className = 'md-latex-error'; title.textContent = entry.error;
        const source = document.createElement('pre'); source.className = 'md-latex-source'; source.textContent = entry.source;
        node.append(title, source);
      } else {
        node.innerHTML = entry.html;
      }
      return node;
    });
    panel.dataset.state = result.ok ? 'ready' : 'error';
    body.replaceChildren(...nodes);
  }
  function updateStreamingLatex(block) {
    if (block.querySelector('.md-latex-panel:not([hidden])')) renderLatexPanel(block);
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('.md-code-latex');
    if (!button) return;
    const block = button.closest('.md-code-block');
    const panel = block?.querySelector('.md-latex-panel');
    if (!panel) return;
    const open = panel.hidden;
    if (open) renderLatexPanel(block);
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', event => {
    const close = event.target.closest('.md-latex-close');
    if (!close) return;
    const panel = close.closest('.md-latex-panel');
    if (!panel) return;
    panel.hidden = true;
    const button = panel.closest('.md-code-block')?.querySelector('.md-code-latex');
    if (button) { button.setAttribute('aria-expanded', 'false'); button.focus(); }
  });
  window.addEventListener('camellia:language', () => {
    document.querySelectorAll('.md-code-latex').forEach(button => {
      button.setAttribute('aria-label', latexPreviewLabel());
      button.title = latexPreviewLabel();
    });
    document.querySelectorAll('.md-code-block').forEach(block => {
      const panel = block.querySelector('.md-latex-panel');
      if (!panel) return;
      panel.querySelector('.md-latex-head strong').textContent = window.CamelliaI18n.t('Formula preview');
      const close = panel.querySelector('.md-latex-close');
      close.setAttribute('aria-label', window.CamelliaI18n.t('Close'));
      close.title = window.CamelliaI18n.t('Close');
      if (!panel.hidden) renderLatexPanel(block);
    });
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('.md-code-copy');
    if (!button || button.disabled) return;
    const code = button.closest('.md-code-block')?.querySelector('.md-code > code');
    if (!code) return;
    button.disabled = true;
    clearTimeout(button.copyResetTimer);
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.dataset.copied = 'true';
      setStatus(window.CamelliaI18n.t('Code copied'));
    } catch {
      delete button.dataset.copied;
      setStatus(window.CamelliaI18n.t('Could not copy the code'));
    } finally {
      button.disabled = false;
      refreshCodeCopy(button);
      button.copyResetTimer = setTimeout(() => {
        delete button.dataset.copied;
        refreshCodeCopy(button);
      }, 2000);
    }
  });
  window.addEventListener('camellia:language', () => {
    document.querySelectorAll('.md-code-copy').forEach(refreshCodeCopy);
  });
  function renderCodeBlock(language, code, highlight = false) {
    const content = code.replace(/\n+$/, '');
    const latex = isLatexLanguage(language);
    return '<div class="md-code-block' + (codeWrap ? ' is-wrapped' : '') + '"><div class="md-code-header"><span>' + esc(language) +
      '</span><div class="md-code-actions">' + (latex ? latexPreviewButton() : '') +
      '<button type="button" class="md-code-wrap" aria-pressed="' + codeWrap + '" aria-label="' + esc(codeWrapLabel()) + '" title="' + esc(codeWrapLabel()) + '">' + codeWrapIcon() +
      '</button>' + codeCopyButton() + '</div></div><pre class="md-code"><code>' + (latex || !highlight ? esc(content) : window.CamelliaMarkdownPreview.highlight(language, content)) + '</code></pre>' +
      (latex ? latexPreviewMarkup() : '') + '</div>';
  }
  function mdRender(src, documentMode = false, baseUrl = '') {
    if (documentMode) return window.CamelliaMarkdownPreview.render(src, { baseUrl, sourceLines: true, codeBlock: (language, code) => renderCodeBlock(language, code, true) });
    const cwd = sidebar.sessions.find(session => session.id === context.sessionId)?.cwd
      || sidebar.workspaces.find(workspace => workspace.id === context.workspaceId)?.path || '';
    const inline = value => window.CamelliaMarkdownLinks.renderInline(value, cwd);
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
    // Protect whole display-math blocks before block rules run, so a formula
    // line that starts with "-", ">" or "---" is not read as a list or quote.
    text = text.replace(/\$\$([\s\S]*?)\$\$|(?<!\\)\\\[([\s\S]*?)\\\]/g, (raw, dollars, brackets, offset) => {
      // Indented code is collected below; keep bracket examples there literal.
      if (brackets !== undefined && indentCodeWidth(text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset + 1))) return raw;
      // The inline parser recognizes $$ display math; \[ is a block-only rule.
      tokens.push({ t: 'math', raw: '$$' + (dollars ?? brackets) + '$$' });
      return SENT + (tokens.length - 1) + SENT;
    });
    const lines = text.split('\n');
    const rendered = [];
    for (let i = 0; i < lines.length; i++) {
      const indentWidth = indentCodeWidth(lines[i]);
      if (indentWidth) {
        const code = [];
        let blank = false;
        while (i < lines.length) {
          const width = indentCodeWidth(lines[i]);
          if (width) {
            const line = lines[i];
            code.push(line.slice(/^\t/.test(line) ? 1 : 4));
            blank = false;
            i++;
            continue;
          }
          // One blank line separates two indented runs; a second one ends the
          // block, and a list, quote, rule or heading ends it immediately.
          if (!blank && !lines[i].trim() && indentCodeWidth(lines[i + 1] || '')) {
            code.push('');
            blank = true;
            i++;
            continue;
          }
          break;
        }
        tokens.push({ t: 'code', lang: '', code: code.join('\n') });
        rendered.push(SENT + (tokens.length - 1) + SENT);
        continue;
      }
      if (listMatch(lines[i])) {
        const parsed = parseList(lines, i);
        tokens.push({ t: 'list', ...parsed.list });
        rendered.push(SENT + (tokens.length - 1) + SENT);
        i = parsed.next - 1;
        continue;
      }
      if (isQuote(lines[i])) {
        const quoted = [];
        while (i < lines.length && isQuote(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
        i--;
        tokens.push({ t: 'quote', text: quoted.join('\n') });
        rendered.push(SENT + (tokens.length - 1) + SENT);
        continue;
      }
      if (isRule(lines[i])) {
        tokens.push({ t: 'rule' });
        rendered.push(SENT + (tokens.length - 1) + SENT);
        continue;
      }
      const align = i + 1 < lines.length ? tableDelimiter(lines[i + 1]) : null;
      if (!align || !lines[i].includes('|')) {
        rendered.push(lines[i]);
        continue;
      }
      const header = splitTableRow(lines[i]);
      if (header.length !== align.length) {
        rendered.push(lines[i]);
        continue;
      }
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = splitTableRow(lines[i]);
        rows.push(Array.from({ length: header.length }, (_unused, index) => row[index] || ''));
        i++;
      }
      i--;
      tokens.push({ t: 'table', header, align, rows });
      rendered.push(SENT + (tokens.length - 1) + SENT);
    }
    text = rendered.join('\n');
    text = inline(text);
    text = documentMode
      ? text.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes, heading) => '<h' + hashes.length + '>' + heading + '</h' + hashes.length + '>')
      : text.replace(/^(#{1,6})\s*(.+)$/gm, '<strong>$2</strong>');
    const sentRe = new RegExp(SENT + '(\\d+)' + SENT, 'g');
    const renderToken = (_m, idx) => {
      const tk = tokens[+idx];
      if (!tk) return _m;
      if (tk.t === 'code') {
        return renderCodeBlock(tk.lang, tk.code);
      }
      if (tk.t === 'inline') return '<code class="md-inline">' + esc(tk.code) + '</code>';
      if (tk.t === 'math') return inline(tk.raw);
      if (tk.t === 'rule') return '<hr class="md-rule">';
      if (tk.t === 'quote') {
        const body = inline(tk.text).replace(sentRe, renderToken).replace(/\n/g, '<br>');
        return '<blockquote class="md-quote">' + body + '</blockquote>';
      }
      if (tk.t === 'list') {
        const renderItems = list => list.items.map(item => {
          let body = inline(item.text).replace(sentRe, renderToken);
          if (item.task !== null) {
            body = '<input type="checkbox" disabled' + (item.task ? ' checked' : '') +
              ' aria-label="' + (item.task ? 'Completed' : 'Not completed') + '"> ' + body;
          }
          const nested = item.children.length
            ? '<ul class="md-list">' + item.children.flatMap(renderItems).join('') + '</ul>'
            : '';
          return '<li' + (item.task !== null ? ' class="md-task"' : '') + '>' + body + nested + '</li>';
        }).join('');
        const tag = tk.ordered ? 'ol' : 'ul';
        const startAttr = tk.ordered && tk.start !== 1 ? ' start="' + tk.start + '"' : '';
        return '<' + tag + ' class="md-list"' + startAttr + '>' + renderItems(tk) + '</' + tag + '>';
      }
      const renderCell = value => inline(value).replace(sentRe, renderToken);
      const cells = (tag, values) => values.map((value, index) => {
        const alignAttr = tk.align[index] ? ' style="text-align:' + tk.align[index] + '"' : '';
        return '<' + tag + alignAttr + '>' + renderCell(value) + '</' + tag + '>';
      }).join('');
      return '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + cells('th', tk.header) +
        '</tr></thead><tbody>' + tk.rows.map(row => '<tr>' + cells('td', row) + '</tr>').join('') + '</tbody></table></div>';
    };
    text = text.replace(sentRe, renderToken);
    return text;
  }

  chat.addEventListener('click', event => {
    const link = event.target.closest('.md [data-chat-file]');
    if (!link) return;
    event.preventDefault();
    void openFilePreview(link.dataset.chatFile, { line: Number(link.dataset.chatLine) || 0, anchor: link.dataset.chatAnchor || '' });
  });
  chat.addEventListener('keydown', event => {
    if (!event.target.matches('.chat-inline-image') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    void openFilePreview(event.target.dataset.chatFile);
  });
  // Resource errors do not bubble. Keep a useful preview link when an image
  // was moved, removed, or is unsupported, rather than a broken image icon.
  chat.addEventListener('error', event => {
    const img = event.target;
    if (!img.matches?.('img.chat-inline-image')) return;
    const link = document.createElement('a');
    link.href = img.src; link.dataset.chatFile = img.dataset.chatFile;
    link.className = 'chat-image-fallback'; link.textContent = img.alt || img.dataset.chatFile;
    link.title = img.dataset.chatFile;
    img.replaceWith(link);
  }, true);

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
  function scrollToLatest() {
    const seq = sessionOpenSeq;
    const scrollIntent = userScrollIntentUntil;
    chatScroll.scrollTop = chatScroll.scrollHeight;
    if (followScrollFrame !== null) cancelAnimationFrame(followScrollFrame);
    followScrollFrame = requestAnimationFrame(() => {
      followScrollFrame = null;
      if (seq !== sessionOpenSeq || userScrollActive || scrollIntent !== userScrollIntentUntil) return;
      if (!running || followRunOutput) chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }
  function maybeScroll(was) {
    if (was || running && followRunOutput) scrollToLatest();
  }
  new ResizeObserver(() => {
    if (running && followRunOutput) scrollToLatest();
  }).observe(chat);

  function clearEmpty() {
    const e = chat.querySelector('.empty-state');
    if (e) e.remove();
  }

  // ---------- popovers ----------
  function closePops() {
    for (const p of openPops) p.remove();
    openPops = [];
    $('modelPill').classList.remove('open');
    $('attachBtn').setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('mousedown', (e) => {
    if (!openPops.length) return;
    if (openPops.some((p) => p.contains(e.target)) || $('modelPill').contains(e.target) || $('attachBtn').contains(e.target)) return;
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

  function modelLabel(id, connection = currentConnection) {
    const subscription = supportsAccounts() && connection === 'subscription';
    const m = (subscription && accountModels.find((x) => x.id === id))
      || (!subscription && routeModels.includes(id) && { label: id })
      || MODELS.find((x) => x.id === id) || accountModels.find((x) => x.id === id);
    return id ? (m?.label || m?.name || m?.displayName || id) : window.CamelliaI18n.t(m?.label || "Default model");
  }
  function levelLabel(id) {
    const l = LEVELS.find((x) => x.id === id);
    return l ? l.label : 'Default';
  }
  window.addEventListener('camellia:language', () => {
    renderModelPill();
    updateCtxRing();
    if (!context.sessionId) $('headerTitle').textContent = window.CamelliaI18n.t('New session');
  });
  function renderModelPill() {
    $('modelPillName').textContent = modelLabel(currentModel);
    $('modelPillLevel').textContent = currentLevel ? levelLabel(currentLevel) : '';
    renderFastMode();
  }
  function currentFastTier() {
    return harnessId === 'codex' && accountSubscription()
      ? window.CamelliaCodexSpeed.fastTier(accountModels.find(model => model.id === currentModel)) : null;
  }
  function renderFastMode() {
    const button = $('fastModeToggle'), tier = currentFastTier();
    button.hidden = !tier;
    button.setAttribute('aria-pressed', String(Boolean(tier && currentFastMode)));
    button.disabled = savingFastMode || loadingSession || switchingEngine || sending;
    const label = currentFastMode ? 'Fast mode on · Uses more subscription allowance' : 'Enable Fast mode · Uses more subscription allowance';
    button.title = window.CamelliaI18n.t(label) + (tier?.description ? '\n' + window.CamelliaI18n.t(tier.description) : '');
  }
  $('fastModeToggle').addEventListener('click', async () => {
    if (!currentFastTier() || savingFastMode) return;
    const fastMode = !currentFastMode;
    const message = fastMode ? 'Fast mode enabled (applies to the next message)' : 'Fast mode disabled (applies to the next message)';
    closePops();
    if (!context.sessionId) {
      currentFastMode = fastMode;
      writeUi('draft:' + draftKey(), { ...readUi('draft:' + draftKey()), codexFastMode: fastMode });
      renderFastMode(); setStatus(message); return;
    }
    savingFastMode = true; renderFastMode();
    try { await persistSettings({ fastMode }, message); }
    finally { savingFastMode = false; renderFastMode(); }
  });
  async function switchToDefaultModel() {
    const sessionId = context.sessionId, engine = harnessId, openSeq = sessionOpenSeq;
    const current = () => sessionId === context.sessionId && engine === harnessId && openSeq === sessionOpenSeq;
    try {
      const settings = await window.dshDesktop.workbenchSettings();
      if (!current()) return;
      if (!settings.ok) throw new Error(settings.error);
      hiddenSubscriptionModels = settings.hiddenSubscriptionModels || {};
      const configured = settings.quickSwitchModels?.[harnessId];
      if (!configured) {
        setStatus('Choose a quick-switch default model in Settings → Model Settings.');
        return;
      }
      // A default saved before the Google catalog was grouped names a concrete
      // effort row; the family that now owns it is the selectable target.
      const target = googleSubscription() && accountFamily(configured)?.id || configured;
      if (target !== currentModel) {
        const available = modelSections().some(section => section.options.some(model => model.id === target));
        if (!available) {
          setStatus('The quick-switch default model is unavailable. Update it in Settings → Model Settings.');
          return;
        }
        // Save the configured pair together. A connection refresh after the
        // model save must not race a separate reasoning-level save.
        await persistModel(target, settings.quickSwitchLevels?.[harnessId] || '');
        return;
      }
      if (current()) await applyQuickSwitchLevel(settings);
    } catch (error) { setStatus('Could not load settings: ' + error.message); }
  }

  // The quick-switch default pairs a model with a reasoning level. The level is
  // applied only when this model actually offers it, so a stale preference
  // never sends an unsupported effort to the engine.
  async function applyQuickSwitchLevel(settings) {
    const level = settings.quickSwitchLevels?.[harnessId] || '';
    if (!level || level === currentLevel) return;
    if (!LEVELS.some(option => option.id === level)) return;
    await persistLevel(level);
  }

  async function persistSettings(patch, message) {
    // Model, reasoning and speed changes are deferred to the next message, so
    // they may be saved while the current turn runs. Everything else needs the
    // conversation to be idle.
    const deferred = patch.model !== undefined || patch.thinkingBudget !== undefined || patch.fastMode !== undefined;
    if (conversationBusy() && !deferred) return;
    const sessionId = context.sessionId, engine = harnessId, openSeq = sessionOpenSeq;
    try {
      const result = await chatApi.saveSettings({ ...patch, sessionId: context.sessionId });
      if (!result.ok) throw new Error(result.error);
      if (sessionId !== context.sessionId || engine !== harnessId || openSeq !== sessionOpenSeq) return;
      if (patch.model !== undefined) LEVELS.splice(1);
      applySessionSettings(result.settings);
      updateCtxRing();
      applyApiLevels();
      setStatus(message);
    } catch (error) {
      $('selPermission').value = currentPermission;
      setStatus("Could not save settings: " + error.message);
    }
  }
  function persistModel(model, quickLevel = '', selectedConnection) {
    // Menu choices carry their connection, including IDs offered by both
    // sources. ID-only quick-switch defaults retain the active connection
    // unless only the other source offers the model.
    let connection;
    const canSwitch = supportsAccounts() && model;
    if (canSwitch) {
      const accountOffersModel = visibleAccountModels().some(item => item.id === model);
      const inCurrent = accountSubscription() ? accountOffersModel : routeModels.includes(model);
      const inOther = accountSubscription() ? routeModels.includes(model) : accountOffersModel;
      const selectedAvailable = selectedConnection === 'subscription' ? accountOffersModel
        : selectedConnection === 'api' && routeModels.includes(model);
      if (selectedAvailable && selectedConnection !== currentConnection) connection = selectedConnection;
      else if (!inCurrent && inOther) connection = accountSubscription() ? 'api' : 'subscription';
    }
    const targetConnection = connection || currentConnection;
    const supportedLevels = !quickLevel ? [] : targetConnection === 'subscription' && supportsAccounts()
      ? (accountModels.find(item => item.id === model)?.supportedReasoningEfforts || [])
        .map(item => item.reasoningEffort || item).filter(id => typeof id === 'string')
      : window.CamelliaModelLevels.levelsFor(model, routeModelCatalog);
    const selectedLevel = quickLevel && supportedLevels.includes(quickLevel) ? quickLevel : '';
    // Google base models own their reasoning timeline, so a model change keeps
    // the saved effort (the engine falls back to the family default if unset).
    return persistSettings({ model, ...(connection ? { connection } : {}),
      ...(selectedLevel ? { thinkingBudget: selectedLevel }
        : !googleSubscription() ? { thinkingBudget: '' } : {}) },
      (selectedLevel ? "Model and reasoning level changed: " : "Model changed: ") + modelLabel(model, targetConnection) + " (applies to the next message)")
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

  function openSubMenu(rowEl, sections, currentId, onPick, manageModels = false) {
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
        const selected = o.id === currentId && (!section.connection || section.connection === currentConnection);
        el.className = 'pop-opt' + (selected ? ' current' : '');
        el.innerHTML = '<span class="pop-label"></span><span class="pop-marks">' + checkMark() + '</span>';
        el.querySelector('.pop-label').textContent = o.label;
        if (section.options === LEVELS || !o.id) el.querySelector('.pop-label').dataset.i18n = '';
        el.addEventListener('click', () => { void onPick(o.id, section.connection); closePops(); });
        if (o.id) el.dataset.modelId = o.id;
        if (section.connection) el.dataset.connection = section.connection;
        sub.appendChild(el);
      }
    }
    if (!sections.some(section => section.options.length)) {
      const empty = document.createElement('div'); empty.className = 'pop-group'; empty.dataset.i18n = '';
      empty.textContent = 'No visible models'; sub.appendChild(empty);
    }
    if (manageModels) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pop-manage';
      button.textContent = window.CamelliaI18n.t('Manage subscription models');
      button.addEventListener('click', () => {
        closePops(); void window.dshDesktop.openSettingsWindow({ page: 'models', focus: 'subscriptionModels' });
      });
      sub.appendChild(button);
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
    // Engines with subscriptions list account and API models together, so the
    // composer itself chooses the connection; a session cannot switch engines.
    if (!supportsAccounts()) return [{ title: 'Model · Same-model failover', options: MODELS }];
    // API routes remain selectable even when the saved connection is a
    // subscription with no usable account catalog (including a fresh install).
    if (!accountModels.length && !googleSubscription() && routeModels.length) return [{
      title: 'Model · Same-model failover', connection: 'api',
      options: accountSubscription() ? routeModels.map(id => ({ id, label: id })) : MODELS,
    }];
    // With no account or API routes there is only the setup/saved-model list.
    if (!accountModels.length) return [{ title: 'Model · Same-model failover', options: MODELS }];
    const account = { title: 'Model · ' + accountName + ' account', connection: 'subscription', options: visibleAccountModels().map(model => ({ id: model.id, label: model.name || model.displayName || model.id })) };
    const api = { title: 'Model · Shared API routes', connection: 'api', options: routeModels.map(id => ({ id, label: id })) };
    if (googleSubscription()) return account.options.length ? [account] : [];
    const sections = accountSubscription() ? [account, api] : [api, account];
    // Connection is part of a choice's identity: an API route must not hide
    // the same model offered by the signed-in account.
    return sections.filter(section => section.options.length);
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
        openSubMenu(rowModel, modelSections(), currentModel,
          (model, connection) => persistModel(model, '', connection), supportsAccounts());
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

  // A single click opens the model/reasoning menu; a double-click selects
  // the default configured in General settings. Waiting briefly before
  // opening the menu is what tells the two gestures apart, so the menu still
  // owns the plain click (listing models and reasoning levels).
  let modelClickTimer = null;
  $('modelPill').addEventListener('click', () => {
    // An open menu closes on the next click straight away. Deferring the close
    // behind the double-click window leaves a pending timer that swallows the
    // following click, so the menu closes instead of reopening.
    if (openPops.length) { clearTimeout(modelClickTimer); modelClickTimer = null; closePops(); return; }
    if (modelClickTimer) return; // second click of a double-click
    modelClickTimer = setTimeout(() => { modelClickTimer = null; openModelMenu(); }, 220);
  });
  $('modelPill').addEventListener('dblclick', () => {
    clearTimeout(modelClickTimer); modelClickTimer = null;
    if (openPops.length) closePops();
    void switchToDefaultModel();
  });

  // ---------- attachments ----------
  const { isImagePath, attachmentGlyph, fileUrl } = window.CamelliaChatControls;

  const fileViewer = $('fileViewer');
  const fileViewerResize = $('fileViewerResize');
  let preferredPreviewWidth = readUi('preview-width');
  if (!Number.isFinite(preferredPreviewWidth) || preferredPreviewWidth <= 0) preferredPreviewWidth = null;
  let previewDrag = null;
  function previewWidthBounds() {
    const available = window.innerWidth - document.querySelector('.sidebar').getBoundingClientRect().width;
    const max = window.innerWidth <= 800 ? Math.max(1, window.innerWidth - 32) : Math.max(300, available - 320);
    return { min: Math.min(300, max), max };
  }
  function updatePreviewWidth(width = preferredPreviewWidth) {
    const { min, max } = previewWidthBounds();
    if (width === null) {
      width = window.innerWidth <= 800 ? Math.min(window.innerWidth * .88, 520)
        : window.innerWidth <= 1050 ? Math.min(window.innerWidth * .46, 500)
        : Math.max(340, Math.min(window.innerWidth * .34, 560));
    }
    const clamped = Math.round(Math.max(min, Math.min(max, width)));
    fileViewer.style.setProperty('--file-viewer-width', clamped + 'px');
    fileViewerResize.setAttribute('aria-valuemin', min);
    fileViewerResize.setAttribute('aria-valuemax', max);
    fileViewerResize.setAttribute('aria-valuenow', clamped);
    return clamped;
  }
  function savePreviewWidth() {
    try { localStorage.setItem(uiPrefix + 'preview-width', JSON.stringify(preferredPreviewWidth)); } catch {}
  }
  function finishPreviewResize() {
    if (!previewDrag) return;
    const pointerId = previewDrag.pointerId;
    previewDrag = null;
    document.body.classList.remove('resizing-file-viewer');
    if (fileViewerResize.hasPointerCapture(pointerId)) fileViewerResize.releasePointerCapture(pointerId);
    savePreviewWidth();
  }
  fileViewerResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || previewDrag) return;
    event.preventDefault();
    previewDrag = { pointerId: event.pointerId, x: event.clientX, width: fileViewer.getBoundingClientRect().width };
    fileViewerResize.setPointerCapture(event.pointerId);
    fileViewerResize.focus();
    document.body.classList.add('resizing-file-viewer');
  });
  fileViewerResize.addEventListener('pointermove', event => {
    if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
    preferredPreviewWidth = updatePreviewWidth(previewDrag.width + previewDrag.x - event.clientX);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    fileViewerResize.addEventListener(name, finishPreviewResize);
  }
  fileViewerResize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = previewWidthBounds();
    const step = event.shiftKey ? 50 : 10;
    const width = event.key === 'Home' ? min : event.key === 'End' ? max
      : fileViewer.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? step : -step);
    preferredPreviewWidth = updatePreviewWidth(width);
    savePreviewWidth();
  });
  window.addEventListener('blur', finishPreviewResize);
  const sidebarElement = $('sidebar');
  const sidebarResize = $('sidebarResize');
  let preferredSidebarWidth = readUi('sidebar-width');
  if (!Number.isFinite(preferredSidebarWidth) || preferredSidebarWidth <= 0) preferredSidebarWidth = null;
  let sidebarDrag = null;
  function sidebarWidthBounds() {
    const reserved = window.innerWidth > 800 ? 540 : 320;
    return { min: 210, max: Math.max(210, Math.min(520, window.innerWidth - reserved)) };
  }
  function updateSidebarWidth(width = preferredSidebarWidth) {
    const { min, max } = sidebarWidthBounds();
    if (width === null) width = window.innerWidth <= 800 ? 210 : 260;
    const clamped = Math.round(Math.max(min, Math.min(max, width)));
    sidebarElement.style.setProperty('--sidebar-width', clamped + 'px');
    sidebarResize.setAttribute('aria-valuemin', min);
    sidebarResize.setAttribute('aria-valuemax', max);
    sidebarResize.setAttribute('aria-valuenow', clamped);
    updatePreviewWidth();
    return clamped;
  }
  function saveSidebarWidth() {
    try { localStorage.setItem(uiPrefix + 'sidebar-width', JSON.stringify(preferredSidebarWidth)); } catch {}
  }
  function finishSidebarResize() {
    if (!sidebarDrag) return;
    const pointerId = sidebarDrag.pointerId;
    sidebarDrag = null;
    document.body.classList.remove('resizing-sidebar');
    if (sidebarResize.hasPointerCapture(pointerId)) sidebarResize.releasePointerCapture(pointerId);
    saveSidebarWidth();
  }
  sidebarResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || sidebarDrag || previewDrag) return;
    event.preventDefault();
    sidebarDrag = { pointerId: event.pointerId, x: event.clientX, width: sidebarElement.getBoundingClientRect().width };
    sidebarResize.setPointerCapture(event.pointerId);
    sidebarResize.focus();
    document.body.classList.add('resizing-sidebar');
  });
  sidebarResize.addEventListener('pointermove', event => {
    if (!sidebarDrag || event.pointerId !== sidebarDrag.pointerId) return;
    preferredSidebarWidth = updateSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    sidebarResize.addEventListener(name, finishSidebarResize);
  }
  sidebarResize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = sidebarWidthBounds();
    const step = event.shiftKey ? 50 : 10;
    const width = event.key === 'Home' ? min : event.key === 'End' ? max
      : sidebarElement.getBoundingClientRect().width + (event.key === 'ArrowRight' ? step : -step);
    preferredSidebarWidth = updateSidebarWidth(width);
    saveSidebarWidth();
  });
  window.addEventListener('blur', finishSidebarResize);
  window.addEventListener('resize', () => { finishSidebarResize(); finishPreviewResize(); updateSidebarWidth(); });
  updateSidebarWidth();

  // The middle conversation column width is a saved preference
  // (Settings → General). "Full" removes the cap instead of naming a pixel
  // value so it keeps tracking the window on every screen size.
  const CHAT_CONTENT_WIDTHS = { standard: '768px', wide: '1080px', full: 'none' };
  function applyChatContentWidth(value) {
    const width = CHAT_CONTENT_WIDTHS[value] || CHAT_CONTENT_WIDTHS.standard;
    document.documentElement.style.setProperty('--content-width', width);
    writeUi('content-width', value);
  }
  window.dshDesktop.onChatContentWidthChanged?.(applyChatContentWidth);
  // Paint the cached width first so the column never flashes at the default
  // when this window opens; the saved preference confirms or corrects it.
  const cachedContentWidth = readUi('content-width');
  if (CHAT_CONTENT_WIDTHS[cachedContentWidth]) applyChatContentWidth(cachedContentWidth);
  void window.dshDesktop.workbenchSettings().then(settings => {
    if (settings?.ok) applyChatContentWidth(settings.chatContentWidth);
  }).catch(() => {});
  const { openFilePreview, closeFilePreview, openPreviewExternally, revealFile, revealLabel, formatFileSize, attachmentDragType } = window.CamelliaFilePreview.create({ fileViewer, inputCard, mdRender, setStatus, finishPreviewResize });

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
    window.CamelliaChatControls.renderAttachments($('attachRow'), attachments, {
      preview: openFilePreview,
      remove: index => {
        const [removed] = attachments.splice(index, 1);
        renderAttachments();
        if (removed?.kind === 'conversation') void window.dshDesktop.conversationCommand({ engine: harnessId,
          action: 'discard-conversation-attachment', payload: { path: removed.path } }).catch(error => setStatus(error.message));
      },
    });
    saveDraft(); updateSendEnabled();
  }

  function renderMessageQueue() {
    const list = $('messageQueue');
    list.hidden = messageQueue.length === 0 && remoteMessageQueue.length === 0;
    list.replaceChildren(...messageQueue.map((message, index) => {
      const row = document.createElement('div');
      row.className = 'queue-item';
      const label = document.createElement('span');
      label.className = 'queue-index';
      label.textContent = window.CamelliaI18n.t('Queued') + ' ' + (index + 1);
      const text = document.createElement('span');
      text.className = 'queue-text';
      text.textContent = message.text || message.attachments.map(item => item.name).join(', ');
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'queue-edit';
      edit.title = window.CamelliaI18n.t('Return to editor');
      edit.setAttribute('aria-label', edit.title);
      edit.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z"/></svg>';
      edit.disabled = sending || drainingQueue || loadingSession || switchingEngine || Boolean(editingMessage) || Boolean(pendingConversationSend()) || goalUI.isDraft();
      edit.addEventListener('click', () => editQueuedMessage(message));
      const steer = document.createElement('button');
      steer.type = 'button'; steer.className = 'queue-steer';
      steer.title = window.CamelliaI18n.t('Send instruction now');
      steer.setAttribute('aria-label', steer.title);
      steer.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 4h16M12 20V9m-5 5 5-5 5 5"/></svg>';
      steer.disabled = !running || !currentRunId || sending || loadingSession || switchingEngine || Boolean(editingMessage) || Boolean(pendingConversationSend()) || drainingQueue;
      steer.addEventListener('click', () => void steerQueuedMessage(message));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'queue-remove'; remove.title = 'Remove from queue';
      remove.setAttribute('aria-label', 'Remove from queue'); remove.textContent = '✕';
      remove.disabled = sending || drainingQueue;
      remove.addEventListener('click', () => { messageQueue.splice(index, 1); saveMessageQueue(); renderMessageQueue(); });
      row.append(label, text, edit, steer, remove);
      return row;
    }));
    if (messageQueuePaused && messageQueue.length) {
      const resume = document.createElement('button');
      resume.type = 'button'; resume.className = 'queue-resume';
      resume.textContent = window.CamelliaI18n.t('Resume queued messages');
      resume.addEventListener('click', () => { setMessageQueuePaused(false); drainMessageQueue(); });
      list.appendChild(resume);
    }
    renderRemoteQueue(list);
  }

  function applyRemoteQueue(value) {
    if (!value || !Array.isArray(value.queue) || value.queueVersion < remoteQueueVersion) return;
    remoteMessageQueue = value.queue; remoteQueueVersion = value.queueVersion;
    renderMessageQueue();
  }

  async function remoteQueueAction(action, queueId) {
    const sessionId = context.sessionId;
    try {
      const result = await window.dshDesktop.conversationCommand({ engine: harnessId, action, payload: { sessionId, queueId } });
      if (!result.ok) throw new Error(result.error);
      if (context.sessionId === sessionId) applyRemoteQueue(result);
    } catch (error) { if (context.sessionId === sessionId) setStatus(error.message); }
  }

  function renderRemoteQueue(list) {
    const t = window.CamelliaI18n.t;
    for (const [index, message] of remoteMessageQueue.entries()) {
      const row = document.createElement('div'); row.className = 'queue-item';
      const label = document.createElement('span'); label.className = 'queue-index';
      label.textContent = t('Mobile queued') + ' ' + (index + 1);
      const text = document.createElement('span'); text.className = 'queue-text';
      text.textContent = message.text;
      text.title = message.error || (message.attachments || []).map(file => file.name).join(', ');
      const state = document.createElement('span'); state.className = 'queue-index';
      state.textContent = t(message.state === 'starting' ? 'Sending…' : message.state === 'queued' ? 'Queued' : 'Paused');
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'queue-remove';
      remove.title = t('Remove from queue'); remove.setAttribute('aria-label', remove.title); remove.textContent = '✕';
      remove.disabled = message.state === 'starting';
      remove.onclick = () => void remoteQueueAction('remote-queue-remove', message.id);
      row.append(label, text, state, remove); list.appendChild(row);
    }
    if (remoteMessageQueue.some(message => ['paused', 'failed'].includes(message.state))) {
      const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'queue-resume';
      resume.textContent = t('Resume mobile queue');
      resume.onclick = () => void remoteQueueAction('remote-queue-resume'); list.appendChild(resume);
    }
  }

  function editQueuedMessage(message) {
    if (sending || drainingQueue || loadingSession || switchingEngine || editingMessage || pendingConversationSend() || goalUI.isDraft()) return false;
    const index = messageQueue.indexOf(message);
    if (index === -1) return false;
    input.value += (input.value && message.text ? '\n\n' : '') + message.text;
    attachments = attachments.concat(message.attachments);
    saveDraft();
    messageQueue.splice(index, 1);
    saveMessageQueue();
    renderAttachments(); autoResize(); renderMessageQueue(); updateSendEnabled();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    setStatus('Queued message and attachments returned to the editor.');
    return true;
  }

  function queueComposerMessage() {
    if (sending || loadingSession || switchingEngine || editingMessage || pendingConversationSend()) return false;
    const text = input.value.trim();
    const queuedAttachments = attachments.slice();
    if (!text && !queuedAttachments.length) return false;
    if (goalUI.isDraft() || typeof findUI !== 'undefined' && findUI.isDraft()) { setStatus('Finish this command before queueing messages.'); return false; }
    messageQueue.push({ text, attachments: queuedAttachments });
    saveMessageQueue();
    input.value = ''; attachments = [];
    renderAttachments(); autoResize(); renderMessageQueue(); saveDraft();
    followRunOutput = true;
    maybeScroll(true);
    setStatus('Message queued · ' + messageQueue.length + ' waiting');
    return true;
  }

  function drainMessageQueue() {
    if (messageQueuePaused || drainingQueue || !messageQueue.length || running || sending || loadingSession || conversationActivity || pendingConversationSend() || switchingEngine || editingMessage || goalUI.isActive()) return;
    const next = messageQueue[0];
    const queue = messageQueue, key = draftKey();
    const openSeq = sessionOpenSeq;
    drainingQueue = true;
    void send(next).then(sent => {
      if (sent && queue[0] === next) {
        queue.shift();
        saveMessageQueue(key, queue);
      }
      if (queue !== messageQueue) return;
      drainingQueue = false;
      renderMessageQueue();
      if (sent && !running && openSeq === sessionOpenSeq) drainMessageQueue();
    }).catch(error => {
      if (openSeq !== sessionOpenSeq) return;
      drainingQueue = false;
      renderMessageQueue();
      setStatus(error.message || 'Could not send the queued message');
    });
  }

  const attachBtn = $('attachBtn');
  function positionAttachPop(pop) {
    const rect = attachBtn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    clampPopPosition(pop, rect.top - pop.offsetHeight - 8, null);
  }
  function attachmentMenu() {
    if (openPops.some(pop => pop.classList.contains('attach-pop'))) { closePops(); return; }
    closePops();
    const pop = document.createElement('div');
    pop.className = 'dsh-pop attach-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', window.CamelliaI18n.t('Add attachments'));
    pop.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closePops(); attachBtn.focus(); }
    };
    document.body.appendChild(pop);
    openPops.push(pop);
    attachBtn.setAttribute('aria-expanded', 'true');
    const t = value => window.CamelliaI18n.t(value);
    const icon = kind => kind === 'file'
      ? '<path d="M21 11.5V17a5 5 0 0 1-10 0V6a3 3 0 0 1 6 0v10a1 1 0 0 1-2 0V7"/>'
      : '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
    function row(label, kind, action) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pop-row attach-option';
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon(kind) + '</svg><span></span>';
      button.querySelector('span').textContent = t(label);
      button.onclick = action;
      return button;
    }
    function mainMenu() {
      pop.replaceChildren();
      pop.classList.add('attach-menu');
      const heading = document.createElement('div'); heading.className = 'pop-group'; heading.textContent = t('Add');
      const files = row('Files', 'file', async () => {
        closePops();
        try { const result = await window.dshDesktop.pickAttachments(); if (!result.canceled) addAttachments(result.paths); }
        catch (error) { setStatus(error.message || t('Could not add attachments')); }
      });
      const conversation = row('Conversation', 'conversation', showConversations);
      pop.append(heading, files, conversation);
      positionAttachPop(pop);
      files.focus();
    }
    let searchSeq = 0;
    function showConversations() {
      pop.replaceChildren();
      pop.classList.remove('attach-menu');
      const header = document.createElement('div'); header.className = 'attach-picker-header';
      const back = document.createElement('button'); back.type = 'button'; back.className = 'attach-picker-back'; back.setAttribute('aria-label', t('Back')); back.textContent = '‹'; back.onclick = mainMenu;
      const title = document.createElement('strong'); title.textContent = t('Attach a conversation');
      header.append(back, title);
      const search = document.createElement('input'); search.type = 'search'; search.className = 'attach-picker-search';
      search.placeholder = t('Search conversations'); search.setAttribute('aria-label', t('Search conversations'));
      const list = document.createElement('div'); list.className = 'attach-picker-list'; list.setAttribute('role', 'listbox');
      pop.append(header, search, list);
      positionAttachPop(pop);
      search.focus();
      async function load() {
        const seq = ++searchSeq;
        list.textContent = t('Loading conversations…');
        try {
          const result = await window.dshDesktop.conversationCommand({ engine: harnessId, action: 'list-attachable-conversations',
            payload: { query: search.value, excludeId: context.sessionId } });
          if (seq !== searchSeq || !pop.isConnected) return;
          if (!result.ok) throw new Error(result.error);
          list.replaceChildren();
          if (!result.sessions.length) { list.textContent = t('No conversations found'); positionAttachPop(pop); return; }
          for (const session of result.sessions) {
            const option = document.createElement('button'); option.type = 'button'; option.className = 'attach-conversation-option';
            option.setAttribute('role', 'option');
            const name = document.createElement('span'); name.className = 'attach-conversation-title'; name.textContent = session.title;
            const detail = document.createElement('span'); detail.className = 'attach-conversation-detail';
            detail.textContent = (ENGINE_SHORT_NAMES[session.engine] || session.engine) + ' · ' + session.cwd;
            option.append(name, detail);
            option.onclick = async () => {
              const alreadyAttached = () => attachments.some(file => file.kind === 'conversation' && file.sourceSessionId === session.id);
              if (alreadyAttached()) { closePops(); input.focus(); return; }
              option.disabled = true;
              try {
                const attached = await window.dshDesktop.conversationCommand({ engine: harnessId, action: 'attach-conversation', payload: { sessionId: session.id } });
                if (!attached.ok) throw new Error(attached.error);
                if (alreadyAttached()) await window.dshDesktop.conversationCommand({ engine: harnessId,
                  action: 'discard-conversation-attachment', payload: { path: attached.attachment.path } });
                else attachments.push(attached.attachment);
                renderAttachments(); closePops(); input.focus();
              } catch (error) { option.disabled = false; setStatus(error.message || t('Could not attach conversation')); }
            };
            list.append(option);
          }
          positionAttachPop(pop);
        } catch (error) { if (seq === searchSeq && pop.isConnected) list.textContent = error.message; }
      }
      search.oninput = () => void load();
      void load();
    }
    mainMenu();
  }
  attachBtn.addEventListener('click', attachmentMenu);

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
    if (!e.dataTransfer) return;
    const paths = [];
    const previewPath = e.dataTransfer.getData(attachmentDragType);
    if (previewPath) paths.push(previewPath);
    for (const f of e.dataTransfer.files) {
      try {
        const p = window.dshDesktop.attachmentPath(f) || f.path;
        if (p) paths.push(p);
      } catch (_err) { /* ignore unresolvable drops */ }
    }
    addAttachments(paths);
  });

  // Paste path-backed files directly; persist in-memory screenshots first.
  // Very long pasted text becomes a .txt attachment instead of a huge prompt.
  input.addEventListener('paste', async (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
    if (!files.length) {
      await attachLongPastedText(e);
      return;
    }
    e.preventDefault();
    if (chatProfile.supportsImages === false) {
      setStatus('Antigravity currently supports text and code attachments. Use Claude or Kimi for images.');
      return;
    }
    const paths = [];
    for (const f of files) {
      try {
        let p = f.path || '';
        try { p = window.dshDesktop.attachmentPath(f) || p; }
        catch (_error) { /* in-memory clipboard images do not have filesystem paths */ }
        if (p) { paths.push(p); continue; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        const result = await window.dshDesktop.saveClipboardImage({ type: f.type, bytes });
        if (!result.ok) throw new Error(result.error);
        paths.push(result.attachment.path);
      } catch (error) {
        setStatus(error?.message || 'Could not attach the pasted image.');
      }
    }
    if (paths.length) addAttachments(paths);
  });

  async function attachLongPastedText(event) {
    const data = event.clipboardData;
    if (!data || Array.from(data.types || []).includes('Files')) return;
    // The goal starter accepts text only; keep its draft inline.
    if (goalUI.isDraft()) return;
    if (typeof findUI !== 'undefined' && findUI.isDraft()) return;
    const text = data.getData('text/plain');
    if (!window.CamelliaLongPaste.shouldAttach(text)) return;
    event.preventDefault();
    let result;
    try {
      result = await window.dshDesktop.savePastedText({ text });
    } catch (error) {
      result = { ok: false, error: error?.message };
    }
    if (!result?.ok) { insertPlainText(text); setStatus(result?.error || 'Could not save the pasted text.'); return; }
    addAttachments([result.attachment.path]);
    setStatus('Pasted text is now a .txt attachment · ' + text.length + ' characters');
  }

  // Fall back to a normal insertion when the pasted block cannot be saved.
  function insertPlainText(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(text, start, end, 'end');
    autoResize();
    updateSendEnabled();
    renderSlash();
    saveDraft();
  }

  // ---------- messages ----------
  // One footer builder for both sides of the transcript: a message timestamp
  // plus a copy button, so an agent reply offers the same affordances as a user
  // message. The caller supplies the current text because streams keep growing.
  function messageActions(at, readText) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const time = document.createElement('time');
    if (at) { time.dateTime = new Date(at).toISOString(); time.textContent = new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    actions.appendChild(time);
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'message-copy'; copy.title = 'Copy message'; copy.setAttribute('aria-label', 'Copy message');
    copy.dataset.i18nAttrs = 'title aria-label';
    copy.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
    copy.onclick = async () => {
      const text = readText();
      if (!text) return;
      try { await navigator.clipboard.writeText(text); setStatus('Message copied'); }
      catch { setStatus('Could not copy the message'); }
    };
    actions.appendChild(copy);
    return actions;
  }

  function addUser(text, atts, meta = {}) {
    const was = !meta.history && nearBottom();
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg-user';
    div.messageData = { text, attachments: atts || [], seq: meta.seq, at: meta.at };
    const b = document.createElement('div');
    b.className = 'bubble md';
    // A prompt is rendered with the same rules as a reply so a pasted snippet
    // keeps its formatting; `textContent` stays the copy/edit source of truth.
    b.innerHTML = mdRender(text);
    div.appendChild(b);
    if (atts && atts.length) {
      const chips = document.createElement('div');
      chips.className = 'attchips';
      for (const a of atts) {
        const c = document.createElement('span');
        c.className = 'attchip-inline';
        c.innerHTML = attachmentGlyph(a.name, a.isImage, 'attchip-inline-icon') + '<span class="attchip-inline-name"></span>';
        c.querySelector('.attchip-inline-name').textContent = a.name;
        c.tabIndex = 0; c.role = 'button'; c.title = window.CamelliaI18n.t('Preview');
        c.addEventListener('click', () => void openFilePreview(a.path));
        c.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openFilePreview(a.path); } });
        chips.appendChild(c);
      }
      div.appendChild(chips);
    }
    const actions = messageActions(meta.at, () => div.messageData.text);
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'message-edit'; edit.title = 'Edit message'; edit.setAttribute('aria-label', 'Edit message'); edit.hidden = true;
    edit.dataset.i18nAttrs = 'title aria-label';
    edit.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z"/></svg>';
    edit.onclick = () => beginMessageEdit(div);
    actions.appendChild(edit);
    div.appendChild(actions);
    chat.appendChild(div);
    if (!meta.history) updateMessageActions();
    if (meta.scrollToBottom) scrollToLatest();
    else if (!meta.history) maybeScroll(was);
    return div;
  }

  function showFailedSend(attempt, existing) {
    if (!attempt || !context.sessionId) return;
    const persisted = !existing && Number.isFinite(attempt.at)
      ? [...chat.querySelectorAll('.msg-user')].reverse().find(row => row.messageData?.seq
        && row.messageData.at >= attempt.at && row.messageData.text === (attempt.text || '[Attachments]')) : null;
    const div = existing || persisted || addUser(attempt.text || '[Attachments]', attempt.attachments, { at: attempt.at || Date.now() });
    if (div.querySelector('.failed-send')) return;
    const controls = document.createElement('div'); controls.className = 'failed-send';
    const error = document.createElement('span'); error.textContent = window.CamelliaI18n.t('Failed to start') + ': ' + attempt.error;
    const edit = document.createElement('button'); edit.type = 'button';
    edit.title = window.CamelliaI18n.t('Edit message'); edit.setAttribute('aria-label', edit.title);
    edit.dataset.i18nAttrs = 'title aria-label';
    edit.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z"/></svg>';
    edit.onclick = () => {
      if (div.messageData.seq) {
        beginMessageEdit(div);
        if (editingMessage?.div === div) { writeUi('failed-send:' + context.sessionId, null); controls.remove(); }
        return;
      }
      input.value = attempt.text;
      attachments = attempt.attachments || [];
      renderAttachments(); autoResize(); updateSendEnabled(); saveDraft();
      writeUi('failed-send:' + context.sessionId, null);
      div.remove(); input.focus();
    };
    controls.append(error, edit); div.appendChild(controls);
  }

  function updateMessageActions() {
    const users = [...chat.querySelectorAll('.msg-user')];
    const editable = context.sessionId && !conversationBusy() && !loadingSession && !sending && !switchingEngine;
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

  document.addEventListener('pointerdown', event => {
    if (editingMessage && !editingMessage.form.contains(event.target)) cancelMessageEdit();
  }, true);

  function beginMessageEdit(div) {
    if (conversationBusy() || contextBusy() || !div.messageData.seq || div !== [...chat.querySelectorAll('.msg-user')].at(-1)) return;
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
    const resize = () => {
      const previousHeight = textarea.offsetHeight;
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(320, Math.max(100, textarea.scrollHeight)) + 'px';
      submit.disabled = !textarea.value.trim() && !div.messageData.attachments.length;
      if (textarea.offsetHeight > previousHeight) requestAnimationFrame(() => {
        if (editingMessage === state) controls.scrollIntoView({ block: 'nearest' });
      });
    };
    textarea.oninput = resize;
    textarea.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); cancelMessageEdit(); }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void resendEditedMessage(state); }
    };
    form.onsubmit = event => { event.preventDefault(); void resendEditedMessage(state); };
    updateConversationControls(); resize(); textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    controls.scrollIntoView({ block: 'nearest' });
  }

  function showMessageEditStatus(state, text, error = false) {
    state.status.textContent = text; state.status.hidden = false;
    state.status.classList.toggle('error', error); state.status.setAttribute('role', error ? 'alert' : 'status');
    state.status.scrollIntoView({ block: 'nearest' });
    state.submit.scrollIntoView({ block: 'nearest' });
  }

  async function resendEditedMessage(state) {
    if (editingMessage !== state || state.sessionId !== context.sessionId) return;
    if (sending) return;
    if (conversationBusy() || contextBusy()) { showMessageEditStatus(state, 'Wait for this conversation to finish or stop it first.', true); return; }
    const text = state.textarea.value.trim(), atts = state.div.messageData.attachments;
    if (!text && !atts.length) { showMessageEditStatus(state, 'Message cannot be empty', true); return; }
    const sendContext = { sessionId: state.sessionId, openSeq: sessionOpenSeq, dispatched: true, cancelled: false };
    pendingConversationSends.set(state.sessionId, sendContext);
    sending = true; restoringRun = true; state.submit.disabled = true; state.textarea.disabled = true;
    state.cancel.textContent = 'Stop';
    state.cancel.onclick = async () => {
      state.cancel.disabled = true;
      try {
        const result = await chatApi.cancel({ sessionId: state.sessionId });
        if (result?.ok === false) throw new Error(result.error || 'Could not stop the response');
      } catch (error) {
        if (editingMessage === state) { showMessageEditStatus(state, error.message, true); state.cancel.disabled = false; }
      }
    };
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
    if (pendingConversationSends.get(state.sessionId) === sendContext) pendingConversationSends.delete(state.sessionId);
    if (sendContext.openSeq !== sessionOpenSeq) {
      void sidebar.load();
      if (!res?.ok) failedMessageEdits.set(state.sessionId, { seq: state.div.messageData.seq, text,
        error: 'Could not resend: ' + (res?.error || 'No response from the app') });
      if (context.sessionId === state.sessionId && !loadingSession && !sending) {
        await openHistorySession(state.sessionId);
      }
      updateConversationControls();
      return;
    }
    sending = false;
    if (!res?.ok) {
      state.div.after(...previousReply);
      restoringRun = false;
      for (const event of eventsDuringRestore.splice(0)) handleEvent(event);
      state.submit.disabled = false; state.cancel.disabled = false; state.textarea.disabled = false;
      state.cancel.textContent = 'Cancel'; state.cancel.onclick = cancelMessageEdit;
      state.submit.textContent = 'Send'; state.form.removeAttribute('aria-busy');
      const error = 'Could not resend: ' + (res?.error || 'No response from the app');
      showMessageEditStatus(state, error, true); setStatus(error); updateConversationControls(); state.textarea.focus({ preventScroll: true }); return;
    }
    editingMessage = null;
    while (state.div.nextSibling) state.div.nextSibling.remove();
    state.div.remove(); turnEl = null; blocks = {}; pendingTools = {}; todoItems = null; todoPanelEl = null;
    addUser(text, atts, { seq: res.userSeq, at: Date.now(), scrollToBottom: true });
    currentRunId = res.runId; acceptSessionEvents = true; loadedEngine = harnessId;
    followRunOutput = true;
    setRunning(true); restoringRun = false;
    for (const event of eventsDuringRestore.splice(0)) handleEvent(event);
    updateConversationControls(); void sidebar.load();
  }

  function restoreFailedMessageEdit() {
    const failed = failedMessageEdits.get(context.sessionId);
    if (!failed || conversationBusy() || contextBusy()) return;
    const user = [...chat.querySelectorAll('.msg-user')].find(div => div.messageData.seq === failed.seq);
    if (!user) return;
    beginMessageEdit(user);
    if (!editingMessage) return;
    failedMessageEdits.delete(context.sessionId);
    editingMessage.textarea.value = failed.text;
    showMessageEditStatus(editingMessage, failed.error, true);
  }

  function turnMetaHtml() {
    return turnEngine
      ? engineAvatar(turnEngine) + '<span>' + esc(ENGINE_SHORT_NAMES[turnEngine] || turnEngine) + '</span>'
      : chatAvatar + '<span>Assistant</span>';
  }
  function applyTurnMeta() { const meta = turnEl?.querySelector('.turn-meta'); if (meta) meta.innerHTML = turnMetaHtml(); }
  // What a finished reply should put on the clipboard: its own visible text, so
  // a folded execution process is not copied together with the answer.
  function turnCopyText(turn) {
    const body = turn?.querySelector('.turn-body');
    if (!body) return '';
    const visible = [...body.children].filter(el => el.classList.contains('md') && !el.closest('.execution-process'));
    const blocks = visible.length ? visible : [...body.querySelectorAll('.md')];
    return blocks.map(el => el.artifactText ?? el.textContent).filter(text => text?.trim()).join('\n\n').trim()
      || turn?.querySelector('.run-result')?.textContent || '';
  }
  function turnFooter(turn, at, readText) {
    if (!turn) return null;
    const existing = turn.querySelector('.turn-actions');
    if (existing) return existing;
    const footer = messageActions(at, readText);
    footer.classList.add('turn-actions');
    turn.appendChild(footer);
    return footer;
  }
  // Keep the footer below the result chip and artifact cards, which are appended
  // after a turn's text during and at the end of a run.
  function moveTurnFooter(turn) { const footer = turn?.querySelector('.turn-actions'); if (footer) turn.appendChild(footer); }
  function turnIsEmpty(turn) {
    if (turn?.querySelector('.turn-body')?.childElementCount) return false;
    return !turn.querySelector('.run-result, .turn-artifacts, .question-pending, .question-card');
  }
  function ensureTurn() {
    if (turnEl) return turnEl;
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'turn';
    div.innerHTML =
      '<div class="turn-meta">' + turnMetaHtml() + '</div>' +
      '<div class="turn-body"></div>';
    turnFooter(div, Date.now(), () => turnCopyText(div));
    chat.appendChild(div);
    turnEl = div;
    return div;
  }
  function turnBody() { return ensureTurn().querySelector('.turn-body'); }

  async function showTurnArtifacts(turn, text, files, paths = [], roots = []) {
    if (!turn || !window.dshDesktop.resolveArtifacts) return;
    const sessionId = context.sessionId;
    const cwd = sidebar.sessions.find(session => session.id === sessionId)?.cwd
      || sidebar.workspaces.find(workspace => workspace.id === context.workspaceId)?.path || '';
    try {
      const result = await window.dshDesktop.resolveArtifacts({ sessionId, cwd,
        paths: files ? files.map(file => file.path) : paths, text, roots });
      if (!turn.isConnected || !result.ok || !result.files.length) return;
      const was = nearBottom();
      turn.querySelector('.turn-artifacts')?.remove();
      const list = document.createElement('div');
      list.className = 'turn-artifacts'; list.setAttribute('role', 'group');
      list.dataset.i18nAttrs = 'aria-label'; list.setAttribute('aria-label', 'Files from this turn');
      const sortedFiles = window.CamelliaArtifacts.sortArtifacts(result.files);
      workPanel.artifacts(sortedFiles);
      const limit = window.CamelliaArtifacts.VISIBLE_ARTIFACT_LIMIT;
      const overflow = document.createElement('details'); overflow.className = 'artifact-overflow';
      const summary = document.createElement('summary');
      const more = document.createElement('span'); more.className = 'artifact-show-more'; more.dataset.i18n = '';
      more.textContent = 'Show ' + (sortedFiles.length - limit) + ' more files';
      const less = document.createElement('span'); less.className = 'artifact-show-less'; less.dataset.i18n = ''; less.textContent = 'Show fewer files';
      summary.append(more, less); overflow.appendChild(summary);
      const labels = { image: 'Image', video: 'Video', audio: 'Audio', text: 'Text', pdf: 'Document', word: 'Document',
        document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', package: 'Package' };
      for (const [index, file] of sortedFiles.entries()) {
        const row = document.createElement('div'); row.className = 'artifact-row';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'artifact-file'; open.title = file.path;
        const icon = document.createElement('span'); icon.className = 'artifact-icon artifact-' + file.kind;
        icon.textContent = file.extension || 'TXT'; icon.setAttribute('aria-hidden', 'true');
        const info = document.createElement('span'); info.className = 'artifact-info';
        const name = document.createElement('strong'); name.textContent = file.name;
        const meta = document.createElement('span');
        const category = document.createElement('span'); category.dataset.i18n = ''; category.textContent = labels[file.kind] || 'Document';
        meta.append(category, ' · ' + [file.extension, formatFileSize(file.size)].filter(Boolean).join(' · '));
        info.append(name, meta); open.append(icon, info);
        open.onclick = () => void openFilePreview(file.path);
        const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'artifact-open';
        menu.setAttribute('aria-haspopup', 'menu'); menu.dataset.i18n = ''; menu.textContent = 'Open with';
        menu.onclick = () => openActionMenu(menu, [
          { label: 'Open in Camellia', run: () => void openFilePreview(file.path) },
          { label: 'Open with system app', run: async () => {
            try { const result = await window.dshDesktop.openFileExternally(file.path); if (!result.ok) setStatus(result.error); }
            catch (error) { setStatus(error.message); }
          } },
          { label: revealLabel(), run: () => void revealFile(file.path) },
        ]);
        row.append(open, menu); (index < limit ? list : overflow).appendChild(row);
      }
      if (sortedFiles.length > limit) list.appendChild(overflow);
      const resultChip = turn.querySelector('.run-result');
      if (resultChip) resultChip.before(list); else turn.appendChild(list);
      moveTurnFooter(turn);
      maybeScroll(was);
    } catch (error) { if (turn.isConnected) setStatus(error.message); }
  }

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
    el.querySelector('.run-text').textContent = pendingQuestion ? 'Waiting for your answer' : text || "Working…";
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
  function appendTurnBlock(el) {
    const body = turnBody();
    (body.processBlocks ||= []).push(el);
    body.processRevision = (body.processRevision || 0) + 1;
    body.appendChild(el);
  }

  function layoutTurnProcess(finished = false, body = turnEl?.querySelector('.turn-body')) {
    const entries = body?.processBlocks;
    if (!entries?.length) return;
    const previous = body.processLayout;
    if (previous?.revision === (body.processRevision || 0) && previous.finished === finished) return;
    const latestThinking = entries.findLast(el => el.classList.contains('think'));
    for (const el of entries) {
      if (el.classList.contains('think') && el !== latestThinking) el.remove();
    }
    const texts = entries.filter(el => {
      if (!el.classList.contains('md')) return false;
      el.markdownHasContent ??= !!(el.textContent.trim() || el.querySelector('.chat-inline-image'));
      return el.markdownHasContent;
    });
    const settled = texts.filter(el => el.dataset.phase !== 'commentary');
    let visible = (finished ? settled : texts).slice(-1);
    if (finished) {
      const lastActivity = entries.findLastIndex(el => !el.classList.contains('md'));
      if (lastActivity >= 0) visible = settled.filter(el => el.dataset.phase === 'final_answer' || entries.indexOf(el) > lastActivity);
      else if (settled.some(el => el.dataset.phase === 'final_answer')) visible = settled.filter(el => el.dataset.phase === 'final_answer');
    }
    body.processLayout = { revision: body.processRevision || 0, finished, visible };
    const archived = entries.filter(el => !visible.includes(el) && (!el.classList.contains('think') || el === latestThinking));
    let process = body.querySelector(':scope > .execution-process');
    if (archived.length && !process) {
      process = document.createElement('details');
      process.className = 'execution-process';
      process.innerHTML = '<summary><span data-i18n>Execution process</span><span class="execution-process-count" data-i18n></span></summary><div class="execution-process-body"></div>';
      body.prepend(process);
    }
    if (process) {
      const bucket = process.querySelector('.execution-process-body');
      let next = bucket.firstElementChild;
      for (const el of archived) {
        if (el === next) next = next.nextElementSibling;
        else bucket.insertBefore(el, next);
      }
      process.querySelector('.execution-process-count').textContent = entries.filter(el => el.classList.contains('tool-card')).length + ' tool calls';
      if (finished) process.open = false;
      process.hidden = !archived.length;
    }
    for (const el of visible) if (el !== body.lastElementChild) body.appendChild(el);
  }

  function makeTextBlock() {
    const el = document.createElement('div');
    el.className = 'md';
    appendTurnBlock(el);
    return el;
  }

  // A standalone Reasoning box. Streaming adds it to the turn; folded and
  // historical blocks place it themselves, so the builder stays detached.
  function buildThinkBlock(statusText, open, live) {
    const el = document.createElement('div');
    el.className = 'think' + (open ? ' open' : '') + (live ? ' live' : '');
    el.innerHTML =
      "<div class=\"think-head\"><span class=\"arrow\">▶</span><span>💭 Reasoning</span><span class=\"think-status\" data-i18n></span></div>" +
      '<div class="think-body"></div>';
    el.querySelector('.think-status').textContent = statusText;
    el.querySelector('.think-head').addEventListener('click', () => el.classList.toggle('open'));
    return el;
  }

  function makeThinkBlock() {
    const el = buildThinkBlock('In progress…', true, true);
    appendTurnBlock(el);
    return el;
  }

  // Fold reasoning that arrived as text into the chronological process before the answer.
  function foldThinkingBlock(block, thinking) {
    const body = String(thinking || '').trim();
    if (!body) {
      if (block.thinkEl) block.thinkEl.querySelector('.think-body').textContent = '';
      return;
    }
    if (!block.thinkEl) {
      const el = buildThinkBlock('Completed', false, false);
      const entries = turnBody().processBlocks;
      const index = entries.indexOf(block.el);
      entries.splice(index, 0, el);
      const turn = turnBody();
      turn.processRevision = (turn.processRevision || 0) + 1;
      block.el.parentNode?.insertBefore(el, block.el);
      block.thinkEl = el;
      block.el.foldedThinkEl = el;
    } else if (!turnBody().processBlocks.includes(block.thinkEl)) {
      const turn = turnBody(), entries = turn.processBlocks;
      entries.splice(entries.indexOf(block.el), 0, block.thinkEl);
      turn.processRevision = (turn.processRevision || 0) + 1;
    }
    const text = block.thinkEl.querySelector('.think-body');
    if (text.textContent !== body) text.textContent = body;
  }

  function makeToolCard(name, inputData, id) {
    const card = window.CamelliaChatControls.makeToolCard(name, inputData, openFilePreview);
    appendTurnBlock(card.el);
    if (!turnBody().rebuilding) layoutTurnProcess();
    if (id) pendingTools[id] = card;
    return card;
  }

  function finalizeStreamBlocks() {
    flushBlockRenders();
    for (const key of Object.keys(blocks)) {
      const b = blocks[key];
      if (b.type === 'text') { b.stopped = true; renderBlock(b); }
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

  function consolidateFinishedTurn() {
    layoutTurnProcess(true);
  }

  // ---------- streaming ----------
  const pendingBlockRenders = new Set();
  let blockRenderFrame = null;
  let blockRenderTimer = null;
  function appendStreamingText(b, delta) {
    if (!b.thinkingStream) {
      b.thinkingStream = window.CamelliaThinkingTags.createStream({ latestOnly: true });
      b.thinkingStream.append(b.raw.slice(0, b.raw.length - delta.length));
      b.resetMarkdown = true;
    }
    b.textState = b.thinkingStream.append(delta, b.raw);
    b.body = b.textState.body;
    if (b.textState.bodyDelta === null) { b.resetMarkdown = true; b.pendingBody = ''; }
    else b.pendingBody += b.textState.bodyDelta;
  }
  function renderBlock(b) {
    if (!b.el.isConnected) {
      b.markdown?.dispose(); b.markdown = null;
      b.thinkingStream?.dispose(); b.thinkingStream = null;
      return;
    }
    if (b.type === 'text') {
      if (b.stopped && b.thinkingStream) {
        b.textState = b.thinkingStream.finish();
        b.thinkingStream.dispose(); b.thinkingStream = null;
      }
      const { body, thinking } = b.textState;
      b.body = body;
      foldThinkingBlock(b, thinking);
      if (!(b.stopped && b.el.markdownFinal && b.el.artifactText === body)) {
        if (b.resetMarkdown) { b.markdown?.dispose(); b.markdown = null; }
        if (!b.markdown) {
          b.markdown = window.CamelliaStreamingMarkdown.create(b.el, {
            render: mdRender, codeBlock: renderCodeBlock, onCodeChange: updateStreamingLatex,
          });
          b.markdown.append(body, body);
        } else b.markdown.append(b.pendingBody, body);
        const previousContent = b.el.markdownHasContent;
        if (b.stopped) {
          b.markdown.finish(body); b.markdown = null;
          b.el.markdownHasContent = !!(b.el.textContent.trim() || b.el.querySelector('.chat-inline-image'));
        } else {
          b.markdown.flush(); b.el.markdownHasContent = b.markdown.hasContent;
        }
        if (previousContent !== b.el.markdownHasContent) {
          const turn = turnBody(); turn.processRevision = (turn.processRevision || 0) + 1;
        }
        b.el.artifactText = body;
        b.el.markdownFinal = !!b.stopped;
      }
      b.pendingBody = ''; b.resetMarkdown = false;
    }
    else if (b.type === 'thinking') {
      const body = b.el.querySelector('.think-body');
      if (!body.firstChild) body.appendChild(document.createTextNode(''));
      body.firstChild.appendData(b.raw.slice(b.thinkingRendered || 0));
      b.thinkingRendered = b.raw.length;
    }
    layoutTurnProcess();
  }
  function flushBlockRenders() {
    if (blockRenderFrame !== null) cancelAnimationFrame(blockRenderFrame);
    blockRenderFrame = null;
    clearTimeout(blockRenderTimer); blockRenderTimer = null;
    const was = nearBottom();
    for (const b of pendingBlockRenders) renderBlock(b);
    pendingBlockRenders.clear();
    maybeScroll(was);
  }
  function queueBlockRender(b) {
    pendingBlockRenders.add(b);
    if (blockRenderTimer === null && blockRenderFrame === null) {
      blockRenderTimer = setTimeout(() => {
        blockRenderTimer = null;
        blockRenderFrame = requestAnimationFrame(flushBlockRenders);
      }, 50);
    }
  }

  function onBlockStart(b, index) {
    if (textChoiceTimer || (textChoice?.runId === currentRunId && currentRunId != null)) clearTextChoice();
    const was = nearBottom();
    if (b.type === 'text') {
      blocks[index] = { type: 'text', raw: b.text || '', el: makeTextBlock(), pendingBody: '',
        thinkingStream: window.CamelliaThinkingTags.createStream({ latestOnly: true }) };
      appendStreamingText(blocks[index], b.text || '');
      if (b.phase) blocks[index].el.dataset.phase = b.phase;
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
      appendStreamingText(b, delta.text);
      queueBlockRender(b);
      scheduleTextChoice(b, index);
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
    pendingBlockRenders.delete(b);
    if (!pendingBlockRenders.size) {
      clearTimeout(blockRenderTimer); blockRenderTimer = null;
      if (blockRenderFrame !== null) cancelAnimationFrame(blockRenderFrame);
      blockRenderFrame = null;
    }
    if (b.type === 'thinking') renderBlock(b);
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
      clearTimeout(textChoiceTimer);
      textChoiceTimer = null;
      renderBlock(b);
      if (b.el.dataset.phase === 'final_answer') offerTextChoice(turnEl, b.body, true, true, b);
    }
    maybeScroll(was);
  }

  function rebuildTurn(content) {
    // Reconcile the canonical message with completed streaming blocks. Identical
    // text keeps its DOM and user controls, including repeated terminal events.
    finalizeStreamBlocks();
    const was = nearBottom();
    const body = turnBody();
    const processOpen = body.querySelector('.execution-process')?.open;
    const oldEntries = body.processBlocks || [];
    const oldTexts = oldEntries.filter(el => el.classList.contains('md'));
    const folded = new Set(oldTexts.map(el => el.foldedThinkEl).filter(Boolean));
    const oldThinking = oldEntries.filter(el => el.classList.contains('think') && !folded.has(el));
    const reused = new Set();
    body.processBlocks = [];
    body.processLayout = null;
    body.processRevision = (body.processRevision || 0) + 1;
    body.rebuilding = true;
    pendingTools = {};
    for (const blk of content || []) {
      if (blk.type === 'text' && blk.text) {
        const exact = oldTexts.find(el => !reused.has(el) && el.artifactText === blk.text);
        const { body: text, thinking } = exact ? { body: blk.text, thinking: '' } : splitThinking(blk.text);
        const el = exact || oldTexts.find(el => !reused.has(el)) || makeTextBlock();
        reused.add(el);
        if (!body.processBlocks.includes(el)) body.processBlocks.push(el);
        if (blk.phase) el.dataset.phase = blk.phase; else delete el.dataset.phase;
        foldThinkingBlock({ el, thinkEl: el.foldedThinkEl }, thinking);
        if (thinking && el.foldedThinkEl) reused.add(el.foldedThinkEl);
        else delete el.foldedThinkEl;
        if (!el.markdownFinal || el.artifactText !== text) {
          window.CamelliaStreamingMarkdown.reconcile(el, mdRender(text), updateStreamingLatex);
          el.artifactText = text;
          el.markdownFinal = true;
          el.markdownHasContent = !!(el.textContent.trim() || el.querySelector('.chat-inline-image'));
        }
      } else if (blk.type === 'thinking' && blk.thinking) {
        const el = oldThinking.find(el => !reused.has(el) && el.querySelector('.think-body').textContent === blk.thinking) || makeThinkBlock();
        reused.add(el);
        if (!body.processBlocks.includes(el)) body.processBlocks.push(el);
        el.classList.remove('open', 'live');
        el.querySelector('.think-status').textContent = "Completed";
        el.querySelector('.think-body').textContent = blk.thinking;
      } else if (blk.type === 'tool_use') {
        captureTodos(blk.name, blk.input);
        makeToolCard(blk.name, blk.input, blk.id);
      }
    }
    body.rebuilding = false;
    for (const el of oldEntries) if (!reused.has(el)) el.remove();
    layoutTurnProcess();
    if (processOpen && body.querySelector('.execution-process')) body.querySelector('.execution-process').open = true;
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
  function compactionDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const t = window.CamelliaI18n.t;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return t(seconds === 1 ? '{0} second' : '{0} seconds').replace('{0}', seconds);
    const minutes = Math.floor(seconds / 60);
    const parts = [t(minutes === 1 ? '{0} minute' : '{0} minutes').replace('{0}', minutes)];
    if (seconds % 60) parts.push(t(seconds % 60 === 1 ? '{0} second' : '{0} seconds').replace('{0}', seconds % 60));
    return parts.join(' ');
  }
  // The label is translated in place, so the elapsed time lives beside it and
  // is re-rendered from the stored milliseconds when the language changes.
  function compactionDurationText(element) { element.textContent = compactionDuration(Number(element.dataset.compactionMs)); }
  function compactionLabel(compaction) {
    if (compaction.state === 'completed' && compaction.fallback) return 'Context compacted: older context omitted';
    const labels = compaction.native ? {
      running: '{0}: compacting context natively…', completed: '{0}: context compacted natively',
      failed: '{0}: native compaction failed. The original conversation is retained.',
      cancelled: '{0}: native compaction canceled. The original conversation is retained.',
    } : { running: 'Compacting context…', completed: 'Context compacted', failed: 'Context compaction failed. The original conversation is retained.', cancelled: 'Context compaction canceled. The original conversation is retained.' };
    return (labels[compaction.state] || labels.running).replace('{0}', ENGINE_SHORT_NAMES[compaction.engine || loadedEngine] || 'Harness');
  }
  window.addEventListener('camellia:language', () => {
    chat.querySelectorAll('.context-compaction-duration').forEach(compactionDurationText);
  });
  function renderCompactionStatus(compaction, historyBefore) {
    if (!compaction) return;
    const was = historyBefore === undefined && nearBottom();
    let row = historyBefore === undefined ? chat.querySelector('.context-compaction[data-state="running"]') : null;
    if (!row && compaction.seq) row = chat.querySelector('.context-compaction[data-seq="' + compaction.seq + '"]');
    if (!row) {
      row = document.createElement('div');
      row.className = 'context-compaction';
      row.setAttribute('role', 'status');
      row.setAttribute('aria-live', 'polite');
      row.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2m8-18h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-2M9 8h6m-6 4h6m-6 4h3"/></svg><span data-i18n></span>';
      // History paints the notice at its stored sequence. A live marker belongs
      // at the same point in the transcript, so a turn that is still streaming
      // keeps growing below it instead of leaving the marker pinned at the end.
      chat.insertBefore(row, (historyBefore === undefined ? turnEl : historyBefore) || null);
    }
    row.dataset.state = compaction.state;
    if (compaction.seq) row.dataset.seq = compaction.seq;
    const label = compactionLabel(compaction);
    const progress = compaction.stage === 'summarizing' && Number.isInteger(compaction.chunk)
      ? (compaction.finalChunk ? 'Summarizing context: chunk {0} (last)…' : 'Summarizing context: chunk {0}…').replace('{0}', compaction.chunk)
      : compaction.stage === 'saving' ? 'Saving compacted context…' : label;
    row.querySelector('span').textContent = compaction.state === 'running' ? progress : label;
    let errorEl = row.querySelector('.context-compaction-error');
    if (compaction.state === 'failed' && compaction.error) {
      if (!errorEl) { errorEl = document.createElement('div'); errorEl.className = 'context-compaction-error'; row.appendChild(errorEl); }
      errorEl.textContent = compaction.error;
    } else errorEl?.remove();
    // The label is translated in place, so the elapsed time lives beside it
    // instead of inside the translated text node.
    const durationMs = compaction.state === 'completed' ? compaction.durationMs ?? compaction.totalMs : NaN;
    let durationEl = row.querySelector('.context-compaction-duration');
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      if (!durationEl) { durationEl = document.createElement('span'); durationEl.className = 'context-compaction-duration'; row.appendChild(durationEl); }
      durationEl.dataset.compactionMs = durationMs;
      compactionDurationText(durationEl);
    } else if (durationEl) durationEl.remove();
    if (historyBefore === undefined) maybeScroll(was);
  }
  let statusText = '';
  let conversationPhase = '';
  function setStatus(text) { statusText = text; statusLine.textContent = text; }
  function handleConversationStatus({ sessionId, text, compaction }) {
    // The transcript marker owns the compaction progress. Mirroring its text
    // into the in-turn run row would print the same sentence twice inside the
    // transcript, so the row keeps its own neutral placeholder meanwhile.
    const runText = compaction?.state === 'running' ? 'Working…' : text;
    if (text && compaction?.native && compaction.state === 'running') text = compactionLabel(compaction);
    const pending = pendingConversationSends.get(sessionId);
    if (pending) pending.phase = text;
    if (sessionId !== context.sessionId) return;
    conversationPhase = text;
    $('handoffStop').hidden = !text;
    if (statusText === 'Stopping…') { renderCompactionStatus(compaction); return; }
    if (text) {
      setStatus(text);
      if (running || pending) setRunStatus(runText);
    } else if (running) {
      setStatus('Running…');
      setRunStatus('Waiting for the engine to respond…');
    }
    renderCompactionStatus(compaction);
  }
  function startRunTicker() {
    runStartedAt = Date.now();
    clearInterval(runTimer);
    runTimer = setInterval(() => {
      if (statusText === 'Stopping…' || pendingQuestion) return;
      setStatus((conversationPhase || 'Running…') + " · Elapsed " + fmtDuration(Date.now() - runStartedAt));
    }, 1000);
    setStatus(conversationPhase || 'Running…');
  }
  function stopRunTicker() { clearInterval(runTimer); runTimer = null; conversationPhase = ''; }

  // ---------- context usage ring ----------
  let modelCtxCaps = new Map();
  let ctxTip = null;
  function contextTokens(usage) {
    return usage ? (usage.input_tokens || usage.prompt_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0;
  }
  function updateCtxRing() {
    const ring = $('ctxRing');
    if (contextTokens(lastCallUsage) > 0) contextUsage = lastCallUsage;
    else if (!contextUsage && contextTokens(lastUsage) > 0) contextUsage = lastUsage;
    const usage = contextUsage;
    const limits = accountSubscription()
      ? { contextWindow: accountModels.find(model => model.id === currentModel)?.contextWindow }
      : modelCtxCaps.get(currentModel) || modelCtxCaps.get(currentModel.replace(/:cloud$/, ''));
    const cap = usage?.context_window || limits?.effectiveWindow || limits?.contextWindow || limits?.maxContext;
    const used = contextTokens(usage);
    if (!used) {
      ring.hidden = true;
      delete ring.dataset.tip;
      ring.removeAttribute('title');
      ctxTip?.remove(); ctxTip = null;
      return;
    }
    const pct = cap ? Math.min(100, Math.round(used / cap * 100)) : 0;
    ring.hidden = false;
    $('ctxFill').style.strokeDasharray = (97.39 * pct / 100) + ' 97.39';
    $('ctxFill').classList.toggle('hot', pct >= 80);
    const translate = window.CamelliaI18n.t;
    const details = [cap
      ? translate('Context used: {0} / {1} tokens ({2}%)').replace('{0}', fmtTokens(used)).replace('{1}', fmtTokens(cap)).replace('{2}', pct)
      : translate('Context used: {0} tokens · Window unknown').replace('{0}', fmtTokens(used))];
    if (usage?.context_window) details.push(translate('Engine window: {0} tokens').replace('{0}', fmtTokens(usage.context_window)));
    else if (limits?.contextWindow) details.push(translate('Configured window: {0} tokens').replace('{0}', fmtTokens(limits.contextWindow)));
    details.push(limits?.maxContext
      ? translate('Model maximum (provider catalog): {0} tokens').replace('{0}', fmtTokens(limits.maxContext))
      : translate('Model maximum: unknown'));
    ring.dataset.tip = details.join(' · ');
    if (ctxTip) ctxTip.textContent = ring.dataset.tip;
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

  function resultStats(ev, updateUsage = true) {
    const parts = [];
    if (ev.num_turns != null) parts.push(ev.num_turns + " ");
    if (ev.duration_ms != null || updateUsage) parts.push("Elapsed " + (ev.duration_ms != null ? fmtDuration(ev.duration_ms) : fmtDuration(Date.now() - runStartedAt)));
    if (ev.total_cost_usd != null) parts.push('$' + Number(ev.total_cost_usd).toFixed(4));
    const u = ev.usage;
    if (u) {
      if (updateUsage) {
        lastUsage = u;
        if (!lastCallUsage && contextTokens(u) > 0) contextUsage = u;
        updateCtxRing();
      }
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      parts.push("Input " + fmtTokens(input) + ' tok');
      parts.push("Output " + fmtTokens(u.output_tokens) + ' tok');
      if (u.cache_read_input_tokens) parts.push("Cache hit " + fmtTokens(u.cache_read_input_tokens) + ' tok');
    }
    return parts;
  }
  function runResultChip(ev, updateUsage = true, retrySeq = null) {
    const stopped = ev.subtype === 'stopped';
    const ok = !ev.is_error && ev.subtype !== 'error_max_turns' && !stopped;
    const stats = resultStats(ev, updateUsage);
    const chip = document.createElement('div');
    chip.className = 'run-result ' + (ok ? 'ok' : 'err');
    const errLabel = ev.subtype && ev.subtype !== 'success' ? ev.subtype : 'Error';
    const label = document.createElement('span');
    label.className = 'run-result-text';
    label.textContent = (stopped ? '■ Stopped' : ok ? '✓ Done' : '✗ ' + (ev.result || errLabel))
      + (stats.length ? ' · ' + stats.slice(0, 3).join(' · ') : '');
    chip.append(label);
    if (!ok && !stopped && Number.isSafeInteger(retrySeq)) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'run-retry';
      retry.textContent = window.CamelliaI18n.t('Retry turn');
      retry.title = window.CamelliaI18n.t('Restart this turn from the saved history');
      retry.onclick = () => {
        const user = [...chat.querySelectorAll('.msg-user')].at(-1);
        if (!user || user.messageData?.seq !== retrySeq || conversationBusy() || contextBusy()) return;
        beginMessageEdit(user);
        if (editingMessage?.div === user) void resendEditedMessage(editingMessage);
      };
      chip.append(retry);
    }
    return { chip, stats, stopped, ok };
  }

  function setRunning(v) {
    running = v;
    updateConversationControls();
    sidebar.updateLabel();
    if (v) {
      lastCallUsage = null;
      startRunTicker();
      // A run started in this view shows its animated placeholder immediately.
      // The engine may stay silent for minutes (long tool runs, compactions or
      // stalled turns), and a status line outside the transcript is not enough
      // evidence that the reply is coming.
      if (!turnEl?.querySelector('.run-status')) setRunStatus('Working…');
    } else {
      stopRunTicker();
    }
    updateSendEnabled();
  }

  // ---------- event handling ----------
  function handleEvent(ev) {
    if (!ev) return;
    if (ev.type === 'gui:subagent') {
      if (ev.session_id === context.sessionId) workPanel.update(ev.tasks);
      return;
    }
    if (['conversation:workspaces', 'conversation:read'].includes(ev.type)) { void sidebar.load(); return; }
    if (ev.type === 'conversation:activity') {
      void sidebar.load();
      if (restoringRun) { eventsDuringRestore.push(ev); return; }
      if (ev.session_id === context.sessionId) {
        conversationActivity = ev.activity;
        updateConversationControls();
        if (!conversationActivity && !running && statusText === 'Stopping…') setStatus('Stopped');
        if (!conversationActivity) drainMessageQueue();
      }
      return;
    }
    // A /find answered on this computer (or by the paired phone) appends rows
    // without an engine stream, so the open transcript reloads in place.
    if (ev.type === 'conversation:transcript') {
      void sidebar.load();
      if (restoringRun) { eventsDuringRestore.push(ev); return; }
      // The window that issued the search already reloaded; only a search
      // started elsewhere (for example on the phone) needs this reload.
      if (ev.origin === 'desktop') return;
      if (ev.session_id === context.sessionId && !loadingSession && !sending && !running) void openHistorySession(ev.session_id);
      return;
    }
    if (restoringRun) { eventsDuringRestore.push(ev); return; }
    if (ev.session_id !== context.sessionId) return;
    if (ev.type === 'conversation:remote-queue') { applyRemoteQueue(ev); return; }
    if (ev.type === 'conversation:approval-resolved') {
      const index = permissionQueue.findIndex(request => request.requestId === ev.requestId && request.runId === ev.runId);
      if (index >= 0) {
        permissionQueue.splice(index, 1);
        if (permRequestId === ev.requestId) {
          finishQuestion('This request is no longer active');
          permissionSubmission = null;
          permRequestId = null; $('permMask').classList.remove('visible');
          if (permissionQueue.length) showPermissionDialog(permissionQueue[0]);
          else if (running) setRunStatus('Working…');
        }
      }
      return;
    }
    if (ev.type === 'conversation:started') acceptSessionEvents = true;
    if (ev.engine && ev.engine !== turnEngine) { turnEngine = ev.engine; applyTurnMeta(); }
    if (ev.handoff && ev.type === 'gui:permission') {
      queuePermission(ev); return;
    }
    if (!acceptSessionEvents) return;
    if (ev.type === 'conversation:steered') {
      if (currentRunId !== ev.runId) return;
      clearTextChoice();
      const previousTurn = turnEl;
      const previousStatus = previousTurn?.querySelector('.run-status');
      addUser(ev.displayText ?? ev.prompt, ev.attachments, { seq: ev.userSeq, at: Date.now(), scrollToBottom: true });
      turnEl = null;
      if (previousStatus) {
        ensureTurn().insertBefore(previousStatus, turnBody());
        if (turnIsEmpty(previousTurn)) previousTurn.remove();
      }
      return;
    }
    if (ev.type === 'conversation:continued') {
      if (currentRunId !== ev.runId) return;
      finalizeStreamBlocks();
      turnEl = null; blocks = {}; pendingTools = {};
      setRunning(true);
      return;
    }
    if (ev.type === 'conversation:started') {
      if (ev.runId !== currentRunId) {
        clearTextChoice();
        currentRunId = ev.runId;
        turnEl = null; blocks = {}; pendingTools = {};
        addUser(ev.displayText ?? ev.prompt, ev.attachments, { seq: ev.userSeq, at: Date.now(), scrollToBottom: true });
        followRunOutput = true;
        setRunning(true);
      }
      return;
    }
    if (ev.type === 'conversation:title') {
      $('headerTitle').textContent = ev.title;
      $('headerTitle').dataset.titled = '1';
      void sidebar.load();
      return;
    }
    if (currentRunId != null && ev.runId != null && currentRunId !== ev.runId) return;
    const was = nearBottom();

    if (ev.type === 'gui:compaction') {
      handleConversationStatus({ sessionId: ev.session_id, text: ev.state === 'running' ? 'Compacting context…' : '',
        compaction: { state: ev.state, native: ev.native !== false, engine: ev.engine || turnEngine || loadedEngine, seq: ev.compactionSeq, durationMs: ev.compactionDurationMs } });
      return;
    }

    if (ev.type === 'gui:usage') {
      lastCallUsage = ev.usage;
      updateCtxRing();
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'init') {
      loadedEngine = harnessId;
      context.sessionId = ev.session_id || context.sessionId;
      context.workspaceId = ev.workspaceId || null;
      sidebar.render();
      void sidebar.load();
      return;
    }

    if (ev.type === 'gui:message-phase') {
      const block = blocks[ev.index];
      if (block?.type === 'text') {
        block.el.dataset.phase = ev.phase;
        const body = turnBody(); body.processRevision = (body.processRevision || 0) + 1;
        layoutTurnProcess();
        if (ev.phase === 'commentary' && textChoice?.sourceBlock === block) clearTextChoice();
        if (ev.phase === 'final_answer') offerTextChoice(turnEl, block.body, true, true, block);
      }
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
      // Per-call usage reflects the real context footprint of the latest API
      // request; the result event sums it across every call in the turn.
      if (ev.message.usage) { lastCallUsage = ev.message.usage; updateCtxRing(); }
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
      queuePermission(ev);
      return;
    }

    if (ev.type === 'gui:tool') {
      const card = pendingTools[ev.id] || makeToolCard(ev.name || "Tool", ev.input, ev.id);
      if (ev.input !== undefined) card.setInput(ev.input);
      if (ev.status === 'completed' || ev.status === 'failed') card.setOutput(ev.output || '', ev.is_error || ev.status === 'failed');
      if (ev.permissionBlocked && !seenPermissionBlocks.has(ev.runId + ':' + ev.id)) {
        seenPermissionBlocks.add(ev.runId + ':' + ev.id);
        const dialog = $('permissionBlockedDialog');
        $('permissionBlockedDetail').textContent = ev.output || '';
        if (!dialog.open) dialog.showModal();
      }
      if (running) setRunStatus(ev.status === 'in_progress' ? "Running " + (ev.name || card.name) + '…' : "Working…");
      maybeScroll(was);
      return;
    }
    if (ev.type === 'gui:plan') {
      todoItems = (ev.entries || []).map(entry => ({ content: entry.content, status: entry.status }));
      renderTodoPanel();
      return;
    }
    // The Google subscription bridge pins its model and effort at launch, so
    // it reports no native config options; the model menu owns the levels.
    if (ev.type === 'gui:config' && harnessId !== 'claude' && !googleSubscription()) {
      const thinking = (ev.options || []).find(option => ['thinking', 'reasoning_effort'].includes(option.id));
      if ((!accountSubscription() && window.CamelliaModelLevels.thinkingFor(currentModel, routeModelCatalog)) || !thinking?.options?.length) applyApiLevels();
      else LEVELS.splice(0, LEVELS.length, { id: '', label: 'Default' },
        ...thinking.options.map(option => ({ id: option.value, label: option.name })));
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
      const { chip, stats, stopped, ok } = runResultChip(ev, true, ev.userSeq);
      for (const card of Object.values(pendingTools)) if (!card.finished) card.setOutput(stopped ? 'Stopped before a tool result was received.' : 'No tool result was received before the response ended.', true);
      (turnEl || chat).appendChild(chip);
      moveTurnFooter(turnEl);
      if (ev.session_id) {
        context.sessionId = ev.session_id;
        context.workspaceId = ev.workspaceId || null;
      }
      const artifactTools = Object.values(pendingTools).filter(card => card.finished && !card.failed);
      void showTurnArtifacts(turnEl, Array.from(turnEl?.querySelectorAll('.md') || []).map(element => element.artifactText || '').join('\n'), ev.artifacts,
        artifactTools.flatMap(card => window.CamelliaArtifacts.toolPaths(card.name, card.inputData)),
        artifactTools.flatMap(card => window.CamelliaArtifacts.toolRoots(card.inputData)
          .concat(window.CamelliaArtifacts.toolDirectories(card.inputData))));
      setStatus((stopped ? "Stopped · " : ok ? '' : "Error · ") + stats.join(' · '));
      const completedTurn = turnEl;
      turnEl = null;
      pendingTools = {};
      setRunning(false);
      currentRunId = null;
      void sidebar.load();
      maybeScroll(true);
      drainMessageQueue();
      if (ok && !messageQueue.length && !goalUI.isActive()) {
        const finalText = answerText(ev.outputBlocks?.filter(block => block.phase === 'final_answer').at(-1)?.text || ev.result);
        if (!offerTextChoice(completedTurn, finalText, true)) clearTextChoice();
      } else clearTextChoice();
      return;
    }
  }

  // ---------- send ----------
  function buildPrompt(text, atts) {
    if (!atts.length) return text;
    const lines = atts.map((a) => a.kind === 'conversation'
      ? '[Attached Camellia conversation handoff; read this overview first and consult the linked full transcript in bounded sections only as needed] ' + a.path
      : "[Attachment" + (a.isImage ? " (image; inspect its contents directly)" : '') + '] ' + a.path);
    const base = text || (atts.some(a => a.kind === 'conversation')
      ? 'Continue the attached Camellia conversation from where it stopped. Read its handoff overview, inspect current files and state, and consult the linked full transcript in bounded sections only when needed. Avoid repeating completed actions.'
      : "Please review and process these attachments.");
    return base + '\n\n' + lines.join('\n');
  }

  function updateSendEnabled() {
    // In /find mode an empty composer is a real request, so the button stays
    // live instead of collapsing into the stop action.
    const findReady = typeof findUI !== 'undefined' && findUI.isDraft();
    const hasMessage = Boolean(input.value.trim() || attachments.length || findReady);
    const active = running || Boolean(conversationActivity) || Boolean(pendingConversationSend());
    sendBtn.classList.toggle('stop', active && !hasMessage);
    sendBtn.classList.toggle('queue', active && hasMessage);
    if (active && !hasMessage) {
      sendBtn.title = 'Stop';
      sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
    } else {
      sendBtn.title = active ? 'Queue message' : 'Send';
      sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
    }
    sendBtn.disabled = (loadingSession && !(active && !hasMessage)) || (sending && !(pendingConversationSend() && active && !hasMessage)) || (Boolean(pendingConversationSend()) && hasMessage) || (Boolean(editingMessage) && !(pendingConversationSend() && active && !hasMessage)) || (!active && goalUI.isActive()) || (!active && !hasMessage);
    renderMessageQueue();
  }

  async function steerQueuedMessage(message) {
    if (!messageQueue.includes(message) || !running || !currentRunId || drainingQueue || sending || loadingSession || switchingEngine || editingMessage || pendingConversationSend()) return;
    const text = message.text, atts = message.attachments.slice();
    if (goalUI.isDraft() || typeof findUI !== 'undefined' && findUI.isDraft()) { setStatus('Finish this command before sending instructions.'); return; }
    const sessionId = context.sessionId, runId = currentRunId, openSeq = sessionOpenSeq;
    sending = true; updateSendEnabled();
    setStatus('Sending instruction…');
    try {
      const result = await chatApi.steer({ sessionId, runId, prompt: buildPrompt(text, atts), displayText: text, attachments: atts });
      if (!result?.ok) throw new Error(result?.error || 'The instruction was not accepted.');
      if (context.sessionId !== sessionId || sessionOpenSeq !== openSeq) return;
      const index = messageQueue.indexOf(message);
      if (index !== -1) messageQueue.splice(index, 1);
      saveMessageQueue();
      setStatus('Instruction accepted by the active turn');
    } catch (error) {
      if (context.sessionId === sessionId && sessionOpenSeq === openSeq) setStatus(error.message);
    } finally {
      if (context.sessionId === sessionId && sessionOpenSeq === openSeq) {
        sending = false; updateSendEnabled(); drainMessageQueue();
      }
    }
  }

  async function send(queuedMessage = null) {
    if ((loadingSession && !((running || conversationActivity || pendingConversationSend()) && !queuedMessage && !input.value.trim() && !attachments.length)) || (sending && !(pendingConversationSend() && !queuedMessage && !input.value.trim() && !attachments.length))) return;
    const active = running || Boolean(conversationActivity) || Boolean(pendingConversationSend());
    if (active && !queuedMessage) {
      if ((input.value.trim() || attachments.length) && (pendingConversationSend() || editingMessage || switchingEngine)) return;
      if (input.value.trim() || attachments.length) { queueComposerMessage(); return; }
      const stopSessionId = context.sessionId, stopRunId = currentRunId, stopOpenSeq = sessionOpenSeq;
      if (messageQueue.length) setMessageQueuePaused(true);
      setStatus("Stopping…");
      try {
        const pending = pendingConversationSend();
        if (pending && !pending.dispatched) { pending.cancelled = true; return; }
        const result = await chatApi.cancel({ sessionId: stopSessionId, ...(running && !pending ? { runId: stopRunId } : {}) });
        if (result?.ok === false) throw new Error(result.error || 'Could not stop the response');
      } catch (error) {
        if (context.sessionId === stopSessionId && currentRunId === stopRunId && sessionOpenSeq === stopOpenSeq && statusText === 'Stopping…') {
          setStatus(error.message || 'Could not stop the response');
        }
      }
      return;
    }
    if (editingMessage || !canChangeContext() || conversationBusy()) return;
    if (context.sessionId && loadedEngine !== harnessId) {
      // A conversation keeps its own harness. A stale renderer must reopen it
      // there instead of turning Send into an implicit harness switch.
      const opened = await window.dshDesktop.conversationSwitch({ engine: loadedEngine, sessionId: context.sessionId, navigate: true });
      if (!opened.ok) setStatus(opened.error);
      return;
    }
    const text = queuedMessage ? queuedMessage.text : input.value.trim();
    if (!queuedMessage && typeof findUI !== 'undefined' && findUI.isDraft()) {
      // An empty composer is a valid search here: it lists the files recent
      // conversations produced, for a user who cannot name what they want.
      input.value = '';
      autoResize();
      updateSendEnabled();
      await findUI.run(text);
      return;
    }
    if (!queuedMessage && goalUI.isDraft()) {
      // Goal draft mode turns the composer into the goal starter; attachments
      // stay put for the following message.
      if (!text) return;
      input.value = '';
      autoResize();
      const goalDraftKey = draftKey(), newGoal = !context.sessionId;
      const started = await goalUI.startFromComposer(text, harnessId === 'codex' && newGoal ? { fastMode: currentFastMode } : {});
      if (started && newGoal && harnessId === 'codex') writeUi('draft:' + goalDraftKey, {});
      return;
    }
    const atts = queuedMessage ? queuedMessage.attachments : attachments.slice();
    if (!text && !atts.length) return;
    if (chatProfile.supportsImages === false && atts.some(a => a.isImage)) {
      setStatus('This engine cannot accept images. Your attachments are retained; switch engines or remove the images to continue.');
      return;
    }
    saveDraft();
    const sentDraftKey = draftKey();
    if (context.sessionId) {
      writeUi('failed-send:' + context.sessionId, null);
      chat.querySelectorAll('.failed-send').forEach(row => {
        const message = row.closest('.msg-user');
        if (message?.messageData?.seq) row.remove(); else message?.remove();
      });
    }
    const sendContext = { sessionId: context.sessionId || null, workspaceId: context.workspaceId,
      fork: Boolean(pendingForkId), openSeq: sessionOpenSeq, dispatched: false, cancelled: false, fastMode: currentFastMode };
    if (sendContext.sessionId && !sendContext.fork) pendingConversationSends.set(sendContext.sessionId, sendContext);
    sending = true;
    turnEngine = harnessId;
    followRunOutput = true;
    restoringRun = true;
    if (!queuedMessage) {
      input.value = '';
      attachments = [];
      renderAttachments();
      autoResize();
    }
    chat.querySelector('.switch-hint')?.remove();
    clearTextChoice();
    const userMessage = addUser(text || "[Attachments]", atts, { at: Date.now(), scrollToBottom: true });
    setRunning(true);
    setRunStatus('Working…');
    updateSendEnabled();
    acceptSessionEvents = true;
    sidebar.render();
    if (pendingConversationSend()) saveDraft();
    let res;
    try {
      const settings = await chatApi.getSettings({ sessionId: sendContext.sessionId });
      if (sendContext.cancelled) throw new Error('Request canceled before sending');
      sendContext.dispatched = true;
      res = await chatApi.send({
        prompt: buildPrompt(text, atts),
        displayText: text,
        attachments: atts,
        sessionId: sendContext.sessionId,
        workspaceId: sendContext.workspaceId,
        fork: sendContext.fork,
        ...(harnessId === 'codex' && !sendContext.sessionId ? { fastMode: sendContext.fastMode } : {}),
        settings,
      });
    } catch (err) { res = { ok: false, error: err.message }; }
    if (pendingConversationSends.get(sendContext.sessionId) === sendContext) pendingConversationSends.delete(sendContext.sessionId);
    if (sendContext.openSeq !== sessionOpenSeq) {
      void sidebar.load();
      if (!res.ok && !queuedMessage && sendContext.sessionId && sendContext.dispatched) {
        writeUi('failed-send:' + sendContext.sessionId, { text, attachments: atts, error: res.error || 'No response from the app', at: userMessage.messageData.at });
        const saved = readUi('draft:' + sentDraftKey);
        if (saved?.text === text) writeUi('draft:' + sentDraftKey, { ...saved, text: '', attachments: [] });
      } else if (!res.ok && !queuedMessage) {
        const saved = readUi('draft:' + sentDraftKey);
        if (!saved?.text && !saved?.attachments?.length) writeUi('draft:' + sentDraftKey, { ...saved, text, attachments: atts });
      } else if (res.ok) {
        const saved = readUi('draft:' + sentDraftKey);
        if (saved?.text === text) writeUi('draft:' + sentDraftKey, { ...saved, text: '', attachments: [] });
      }
      if (context.sessionId === sendContext.sessionId && !loadingSession && !sending) {
        if (!res.ok) {
          if (sendContext.dispatched) {
            if (sendContext.sessionId && input.value === text) { input.value = ''; attachments = []; renderAttachments(); autoResize(); saveDraft(); }
            showFailedSend({ text, attachments: atts, error: res.error || 'No response from the app', at: userMessage.messageData.at });
          }
          clearRunStatus();
          setStatus('Failed to start: ' + res.error);
        }
        updateConversationControls();
      }
      return Boolean(res.ok);
    }
    sending = false;
    // The run is dispatched: refresh the controls so a model change can be
    // queued behind it even if the engine has not emitted an event yet.
    updateConversationControls();
    if (!res.ok) {
      if (sendContext.sessionId && sendContext.dispatched && !queuedMessage) {
        writeUi('failed-send:' + sendContext.sessionId, { text, attachments: atts, error: res.error || 'No response from the app', at: userMessage.messageData.at });
        showFailedSend({ text, attachments: atts, error: res.error || 'No response from the app', at: userMessage.messageData.at }, userMessage);
      } else if (!queuedMessage && !input.value && !attachments.length) { input.value = text; attachments = atts; renderAttachments(); autoResize(); }
      saveDraft();
      finalizeStreamBlocks();
      const chip = document.createElement('div');
      chip.className = 'run-result err';
      chip.textContent = "Failed to start: " + res.error;
      chat.appendChild(chip);
      setStatus("Failed to start");
      updateSwitchHint();
      clearRunStatus();
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
    restoringRun = false;
    for (const event of eventsDuringRestore.splice(0)) handleEvent(event);
    updateSendEnabled(); void sidebar.load();
    writeUi('draft:' + sentDraftKey, {});
    saveDraft();
    return true;
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(Math.max(input.scrollHeight, 52), 180) + 'px';
  }
  input.addEventListener('input', () => {
    autoResize();
    updateSendEnabled();
    saveDraft();
    renderSlash();
  });
  sendBtn.addEventListener('click', () => void send());
  // ---------- slash commands ----------
  const SLASH_COMMANDS = [
    { id: 'goal', label: '/goal', desc: 'Set a goal; the engine keeps working until done or blocked',
      icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
      run: () => goalUI.reveal() },
    { id: 'find', label: '/find', desc: 'Find files on this computer and download them',
      icon: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.2-4.2"/>',
      run: () => findUI.reveal() },
    { id: 'tasks', label: '/tasks', desc: 'Schedule periodic experiment checks',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', run: () => void tasksUI.reveal() },
    { id: 'usage', label: '/usage', desc: 'Show request and token usage through the local router',
      icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
      run: () => void showUsageCard() },
    { id: 'compact', label: '/compact', desc: 'Compact context; keep recent messages if summarization fails',
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
          for (const target of day === days[0] ? [today, week] : [week]) {
            for (const m of Object.values(models)) {
              target.requests += m.requests || 0; target.failures += m.failures || 0;
              target.inputTokens += m.inputTokens || 0; target.outputTokens += m.outputTokens || 0;
            }
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
    if (!context.sessionId) { setStatus('Start a conversation first, then compact it.'); return; }
    if (conversationBusy()) { setStatus('Available when this conversation stops working'); return; }
    try {
      const res = await window.dshDesktop.conversationCommand({ engine: harnessId, action: 'compact', payload: { sessionId: context.sessionId } });
      if (!res?.ok) setStatus(res?.error || 'Compaction failed');
      else {
        const duration = compactionDuration(res.durationMs);
        const label = res.fallback ? 'Context compacted: older context omitted'
          : res.native ? compactionLabel({ state: 'completed', native: true }) : 'Context compacted. The conversation continues with the summary.';
        setStatus(window.CamelliaI18n.t(label) + (duration ? ' · ' + duration : ''));
      }
    } catch (error) { setStatus(error.message); }
  }
  input.addEventListener('keydown', (e) => {
    if (slashPop) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = slashMatches().length; slashIndex = (((slashIndex + (e.key === 'ArrowDown' ? 1 : -1)) % n) + n) % n; renderSlash(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) { e.preventDefault(); runSlashActive(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Escape' && findUI.isDraft()) { e.preventDefault(); findUI.setDraft(false); return; }
    if (e.key === 'Enter' && e.altKey && !e.isComposing && (running || conversationActivity)) { e.preventDefault(); if (!sending) queueComposerMessage(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  async function newSession(workspaceId = null) {
    if (!canChangeContext()) return;
    saveDraft();
    if (!leaveDiscussion()) return;
    const wasReady = uiReady; uiReady = false;
    ++sessionOpenSeq;
    resetConversationView();
    loadingSession = true; input.disabled = true;
    updateConversationControls();
    closePops();
    acceptSessionEvents = false;
    currentRunId = null;
    context.sessionId = null;
    void tasksUI.refresh();
    loadedEngine = harnessId;
    $('conversationOrigin').hidden = true;
    updateSwitchHint();
    context.workspaceId = workspaceId;
    writeUi('location', { sessionId: null, workspaceId });
    pendingForkId = null;
    turnEl = null;
    turnEngine = null;
    blocks = {};
    pendingTools = {};
    contextUsage = null;
    lastUsage = null; lastCallUsage = null; updateCtxRing();
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

  // ---------- Task questions and tool permissions ----------
  function scheduleTextChoice(block, index) {
    clearTimeout(textChoiceTimer);
    textChoiceTimer = null;
    const phase = block.el.dataset.phase;
    if (currentRunId == null || pendingQuestion ||
      (phase !== 'final_answer' && !(harnessId === 'codex' && phase == null))) return;
    const turn = turnEl, runId = currentRunId;
    // A final-answer phase may arrive only after Codex finishes the item. A
    // short quiet period lets a streamed list open while that item is still live.
    textChoiceTimer = setTimeout(() => {
      textChoiceTimer = null;
      const currentPhase = block.el.dataset.phase;
      if (currentRunId === runId && turnEl === turn && blocks[index] === block &&
        (currentPhase === 'final_answer' || harnessId === 'codex' && currentPhase == null))
        if (!offerTextChoice(turn, block.body, true, true, block) && textChoice?.sourceBlock === block) clearTextChoice();
    }, 300);
  }
  function clearTextChoice() {
    clearTimeout(textChoiceTimer);
    textChoiceTimer = null;
    const dialog = $('textChoiceDialog');
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    textChoice?.slot.remove();
    textChoice = null;
  }
  function offerTextChoice(turn, reply, autoOpen = false, live = false, sourceBlock = null) {
    if (!turn?.isConnected || pendingQuestion || loadedEngine !== harnessId) return false;
    if (live && (!context.sessionId || currentRunId == null)) return false;
    const choice = window.CamelliaAssistantChoice.parse(reply);
    if (!choice) return false;
    const choiceKey = JSON.stringify(choice);
    if (textChoice?.turn === turn && textChoice.choiceKey === choiceKey) {
      textChoice.runId = live ? currentRunId : null;
      textChoice.sourceBlock = sourceBlock;
      return true;
    }
    const saved = textChoice ? { selected: textChoice.field.choices.filter(option => option.checked).map(option => option.value),
      custom: textChoice.field.custom.value } : null;
    clearTextChoice();
    const dialog = $('textChoiceDialog');
    const card = document.createElement('form'); card.className = 'question-card';
    const header = document.createElement('header'); header.className = 'question-header';
    const title = document.createElement('h3'); title.id = 'textChoiceTitle'; title.dataset.i18n = ''; title.textContent = 'Choose a reply';
    const hint = document.createElement('p'); hint.id = 'textChoiceHint'; hint.className = 'question-hint'; hint.dataset.i18n = '';
    hint.textContent = 'Selecting sends a new message to this conversation.';
    header.append(title, hint);
    const fieldList = document.createElement('div'); fieldList.className = 'question-fields';
    const [field] = window.CamelliaChatControls.questionFields(fieldList, [{ id: 'reply', question: choice.question,
      options: choice.options.map(label => ({ label })) }], saved ? { saved: { reply: saved } } : {});
    const status = document.createElement('div'); status.className = 'question-status'; status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'question-actions';
    const later = document.createElement('button'); later.type = 'button'; later.className = 'btn-secondary'; later.dataset.i18n = ''; later.textContent = 'Later';
    later.onclick = () => dialog.close();
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn-primary'; submit.dataset.i18n = ''; submit.textContent = 'Send reply';
    actions.append(later, submit); card.append(header, fieldList, status, actions);
    const slot = document.createElement('div'); slot.className = 'question-pending text-choice-pending';
    const description = document.createElement('div'), label = document.createElement('strong'), preview = document.createElement('p');
    label.dataset.i18n = ''; label.textContent = 'Choose a reply'; preview.textContent = choice.question;
    description.append(label, preview);
    const openButton = document.createElement('button'); openButton.type = 'button'; openButton.className = 'btn-secondary'; openButton.dataset.i18n = ''; openButton.textContent = 'Answer questions';
    openButton.onclick = () => { if (!dialog.open && !pendingQuestion) dialog.showModal(); };
    slot.append(description, openButton);
    turn.insertBefore(slot, turn.querySelector('.run-result'));
    const state = { slot, turn, field, choiceKey, sourceBlock, sessionId: context.sessionId,
      openSeq: sessionOpenSeq, runId: live ? currentRunId : null };
    textChoice = state;
    card.onsubmit = async event => {
      event.preventDefault();
      if (textChoice !== state || context.sessionId !== state.sessionId || sessionOpenSeq !== state.openSeq) return;
      const answer = field.custom.value.trim() || field.choices.find(option => option.checked)?.value || '';
      if (!answer) { status.textContent = 'Answer each question before submitting'; status.setAttribute('role', 'alert'); return; }
      if (state.runId != null && running && currentRunId === state.runId) {
        if (sending || submit.disabled) return;
        submit.disabled = true;
        status.textContent = window.CamelliaI18n.t('Sending answer…'); status.setAttribute('role', 'status');
        try {
          const response = await chatApi.steer({ sessionId: state.sessionId, runId: state.runId,
            prompt: answer, displayText: answer, attachments: [] });
          if (!response?.ok) throw new Error(response?.error || window.CamelliaI18n.t('The answer was not accepted.'));
          if (textChoice === state) clearTextChoice();
        } catch (error) {
          if (textChoice === state) { status.textContent = error.message; status.setAttribute('role', 'alert'); submit.disabled = false; }
        }
        return;
      }
      if (conversationBusy() || contextBusy() || sending) {
        status.textContent = 'Wait for this conversation to finish or stop it first.'; status.setAttribute('role', 'alert'); return;
      }
      clearTextChoice();
      input.value = answer; autoResize();
      void send();
    };
    dialog.replaceChildren(card);
    if (autoOpen) queueMicrotask(() => {
      if (textChoice === state && (!running || live && currentRunId === state.runId)
        && !sending && !loadingSession && !document.querySelector('dialog[open]')) dialog.showModal();
    });
    return true;
  }
  function queuePermission(ev) {
    if (permissionQueue.some(request => request.requestId === ev.requestId && request.runId === ev.runId)) return;
    if (currentPermission === 'full' && !ev.questions?.length) { void autoAllowPermission(ev); return; }
    permissionQueue.push(ev);
    if (!permRequestId) showPermissionDialog(permissionQueue[0]);
  }
  function openQuestionDialog() {
    if (!pendingQuestion || pendingQuestion.requestId !== permRequestId) return;
    const dialog = $('questionDialog');
    if (dialog.open) return;
    dialog.replaceChildren(pendingQuestion.card);
    dialog.showModal();
    // Focus the question, without preselecting an option or a submit button.
    $('questionTitle').focus();
  }
  function deferQuestion() {
    const state = pendingQuestion;
    if (!state) return;
    if ($('questionDialog').open) $('questionDialog').close();
    state.openButton.focus({ preventScroll: true });
  }
  $('questionDialog').addEventListener('cancel', event => { event.preventDefault(); deferQuestion(); });
  function questionError(text) {
    if (!pendingQuestion) return;
    pendingQuestion.status.textContent = text;
    pendingQuestion.status.classList.add('error');
    pendingQuestion.status.setAttribute('role', 'alert');
  }
  function finishQuestion(text, confirmed = false) {
    if (!pendingQuestion) return;
    const state = pendingQuestion;
    if ($('questionDialog').open) $('questionDialog').close();
    const title = state.card.querySelector('h3'); title.removeAttribute('id'); title.textContent = text;
    state.card.querySelector('.question-hint').removeAttribute('id');
    for (const control of state.card.querySelectorAll('input, textarea, button')) control.disabled = true;
    state.status.textContent = text; state.status.classList.remove('error'); state.status.setAttribute('role', 'status');
    // Collapse the answered form: a compact answer summary stays visible while
    // the full option lists fold behind a toggle.
    const answers = document.createElement('div'); answers.className = 'question-answers';
    for (const { question: q, choices, custom } of state.fields) {
      const picked = choices.filter(c => c.checked).map(c => c.value);
      const value = confirmed ? q.isSecret ? '••••••' : [...picked, ...(custom.value.trim() ? [custom.value.trim()] : [])].join(' · ') : '';
      if (q.isSecret || !confirmed) { custom.value = ''; choices.forEach(choice => choice.checked = false); }
      const line = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = q.question;
      const answer = document.createElement('span'); answer.textContent = value || '—';
      line.append(name, answer); answers.append(line);
    }
    const review = document.createElement('details'); review.className = 'question-review';
    const toggle = document.createElement('summary'); toggle.dataset.i18n = ''; toggle.textContent = 'Review options';
    review.append(toggle);
    for (const field of state.card.querySelectorAll('fieldset')) review.append(field);
    state.card.querySelector('.question-fields').remove();
    state.card.insertBefore(answers, state.status);
    state.card.insertBefore(review, state.status);
    state.card.classList.add('done');
    state.slot.replaceWith(state.card);
    $('questionDialog').replaceChildren();
    questionDrafts.delete(state.key); pendingQuestion = null;
  }
  function showQuestion(ev) {
    clearTextChoice();
    $('permMask').classList.remove('visible');
    const was = nearBottom(), key = JSON.stringify([context.sessionId, ev.runId, ev.requestId]);
    const saved = questionDrafts.get(key) || {};
    const card = document.createElement('form'); card.className = 'question-card';
    const header = document.createElement('header'); header.className = 'question-header';
    const heading = document.createElement('div'); heading.className = 'question-heading';
    const title = document.createElement('h3'); title.dataset.i18n = ''; title.textContent = 'Your input is needed';
    title.id = 'questionTitle'; title.tabIndex = -1;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'question-close';
    close.setAttribute('aria-label', 'Close'); close.title = 'Answer later'; close.dataset.i18nAttrs = 'aria-label title';
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.onclick = deferQuestion; heading.append(title, close);
    const hint = document.createElement('p'); hint.className = 'question-hint'; hint.dataset.i18n = '';
    hint.id = 'questionHint'; hint.textContent = 'Choose or write an answer to continue this task. Answering later keeps it waiting.';
    const fieldList = document.createElement('div'); fieldList.className = 'question-fields';
    // A queued question can outlive the turn that asked it, so name its
    // conversation. Otherwise a deferred dialog reads as an orphaned form.
    const origin = document.createElement('p'); origin.className = 'question-context';
    const originId = ev.session_id || context.sessionId;
    const originSession = sidebar.sessions.find(entry => entry.id === originId);
    const headerTitle = $('headerTitle').dataset.titled ? $('headerTitle').textContent : '';
    const originTitle = originSession?.title || headerTitle || (originId ? 'Session ' + String(originId).slice(0, 8) : '');
    origin.textContent = originTitle ? window.CamelliaI18n.t('Conversation') + ' · ' + originTitle : '';
    header.append(heading, origin, hint); card.append(header, fieldList);
    const fields = window.CamelliaChatControls.questionFields(fieldList, ev.questions, { saved,
      changed: fields => questionDrafts.set(key, Object.fromEntries(fields.filter(f => !f.question.isSecret).map(f => [f.question.id, { selected: f.choices.filter(c => c.checked).map(c => c.value), custom: f.custom.value }]))),
    });
    const status = document.createElement('div'); status.className = 'question-status'; status.dataset.i18n = ''; status.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'question-actions';
    const later = document.createElement('button'); later.type = 'button'; later.className = 'btn-secondary question-later'; later.dataset.i18n = ''; later.textContent = 'Answer later';
    later.onclick = deferQuestion;
    const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'question-skip'; skip.dataset.i18n = ''; skip.textContent = 'Skip questions';
    skip.onclick = () => void answerPermission(false);
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn-primary'; submit.dataset.i18n = ''; submit.textContent = 'Submit answers';
    actions.append(later, skip, submit); card.append(status, actions);
    card.onsubmit = event => { event.preventDefault(); void answerPermission(true); };
    const slot = document.createElement('div'); slot.className = 'question-pending';
    const description = document.createElement('div'), label = document.createElement('strong'), preview = document.createElement('p');
    const firstTopic = typeof ev.questions[0].header === 'string' ? ev.questions[0].header.trim() : '';
    label.dataset.i18n = ''; label.textContent = 'Waiting for your answer';
    preview.textContent = firstTopic ? firstTopic + ' · ' + ev.questions[0].question : ev.questions[0].question;
    description.append(label, preview);
    const openButton = document.createElement('button'); openButton.type = 'button'; openButton.className = 'btn-secondary'; openButton.dataset.i18n = ''; openButton.textContent = 'Answer questions';
    openButton.onclick = openQuestionDialog; slot.append(description, openButton);
    pendingQuestion = { card, status, fields, key, slot, openButton, requestId: ev.requestId };
    // Keep the pending entry outside streamed text so replies cannot erase it.
    ensureTurn().append(slot); setRunStatus('Waiting for your answer'); setStatus('Waiting for your answer');
    if (was) slot.scrollIntoView({ block: 'start' });
    openQuestionDialog();
  }
  async function autoAllowPermission(ev) {
    if (ev.questions?.length) return;
    const payload = { requestId: ev.requestId, allow: true };
    Object.assign(payload, { sessionId: context.sessionId, runId: ev.runId });
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
        return [q.id, q.multiSelect ? [...selected, ...(text ? [text] : [])] : text || selected[0] || ''];
      });
      if (entries.some(([, value]) => !value.length)) { questionError('Answer each question before submitting'); return; }
      input = Object.fromEntries(entries);
    }
    const submission = {}; permissionSubmission = submission;
    if (question) { question.status.textContent = 'Sending…'; question.status.classList.remove('error'); question.status.setAttribute('role', 'status'); question.card.querySelectorAll('input, button').forEach(el => el.disabled = true); }
    let result;
    try {
      result = await chatApi.controlRespond({ requestId: answered, allow, optionId, input,
        ...(question && !allow ? { message: 'The user skipped these questions without selecting an answer. Continue from the existing request; no option has been confirmed.' } : {}),
        sessionId, runId });
    } catch (error) { result = { ok: false, error: error.message }; }
    if (permissionSubmission === submission) permissionSubmission = null;
    if (context.sessionId !== sessionId || permissionQueue[0]?.runId !== runId) return;
    if (permRequestId !== answered) return;
    if (!result?.ok) {
      const error = result?.error || 'This request is no longer active';
      if (question && pendingQuestion === question) { question.card.querySelectorAll('input, button').forEach(el => el.disabled = false); questionError(error); }
      setStatus(error); return;
    }
    finishQuestion(allow ? 'Answers sent' : 'Questions skipped', allow);
    setStatus(allow ? 'Answers sent' : 'Questions skipped');
    permRequestId = null;
    permissionQueue.shift();
    $('permMask').classList.remove('visible');
    if (permissionQueue.length) showPermissionDialog(permissionQueue[0]);
    else if (running) setRunStatus('Working…');
  }
  $('permAllow').addEventListener('click', () => void answerPermission(true));
  $('permDeny').addEventListener('click', () => void answerPermission(false));
  $('permLater').hidden = false;
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

  function openActionMenu(anchor, actions, position) {
    const rect = anchor.getBoundingClientRect();
    closePops();
    const pop = document.createElement('div');
    pop.className = 'dsh-pop action-menu';
    pop.setAttribute('role', 'menu');
    actions.forEach((action) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pop-row' + (action.current ? ' current' : '') + (action.danger ? ' danger' : '');
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
    clampPopPosition(pop, position ? position.y : rect.bottom + 4,
      (position ? position.x : rect.left) + pop.offsetWidth);
    openPops.push(pop);
    pop.querySelector('button:not(:disabled)')?.focus();
  }
  function conversationBusy() { return running || Boolean(conversationActivity) || Boolean(pendingConversationSend()) || goalUI.isActive(); }
  function contextBusy() {
    return (loadingSession && !historyOpening) || switchingEngine || (sending && !pendingConversationSend());
  }
  function canChangeContext() {
    if (!contextBusy()) return true;
    setStatus('Please wait for the conversation to open.');
    return false;
  }
  function updateConversationControls() {
    const locked = conversationBusy() || loadingSession || switchingEngine || sending;
    $('conversationActions').disabled = !context.sessionId || loadingSession || switchingEngine;
    // Changing the model or reasoning level is queued the same way a message is:
    // it applies to the next message, not the running turn, so it stays usable
    // while a response runs. Switching harness, and the session-level settings
    // that restart the engine process, still wait for the turn to stop.
    $('engineSwitch').disabled = locked;
    $('engineSwitch').title = locked ? 'Available when this conversation stops working' : 'Switch chat mode';
    $('handoffBtn').disabled = locked;
    $('modelPill').disabled = loadingSession || switchingEngine || sending;
    renderFastMode();
    $('selPermission').disabled = locked;
    updateSendEnabled();
    updateMessageActions();
  }
  function resetConversationView() {
    workPanel.reset();
    historyOpening = false;
    sending = false;
    drainingQueue = false;
    closePops();
    contextUsage = null;
    lastUsage = null; lastCallUsage = null; updateCtxRing();
    ctxTip?.remove(); ctxTip = null;
    closeSlash();
    cancelMessageEdit();
    clearTextChoice();
    if ($('questionDialog').open) $('questionDialog').close();
    $('questionDialog').replaceChildren();
    pendingQuestion = null; permissionSubmission = null;
    acceptSessionEvents = false; currentRunId = null; conversationActivity = null;
    restoringRun = false; eventsDuringRestore.length = 0;
    permRequestId = null; permissionQueue.length = 0; $('permMask').classList.remove('visible');
    seenPermissionBlocks.clear();
    if ($('permissionBlockedDialog').open) $('permissionBlockedDialog').close();
    clearRunStatus(); setRunning(false);
    $('handoffStop').hidden = true;
    messageQueue = []; messageQueuePaused = false; remoteMessageQueue = []; remoteQueueVersion = -1; renderMessageQueue();
  }
  const sidebar = createClaudeSidebar({ $, context, contextBusy, canChangeContext, setStatus,
    canReadReply: () => !discussionVisible && !loadingSession && !restoringRun,
    getDiscussionId: () => discussionVisible ? discussionSurface?.groupId : null, discussionVisible: () => discussionVisible, discussionOpening: () => discussionOpening,
    newSession, openHistorySession, openDiscussions, forkSession, openActionMenu, closePops,
    noteLocalDelete: (id) => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('camellia-chat-') && key.endsWith(':' + id)) localStorage.removeItem(key);
      selfDeletedIds.add(id);
      setTimeout(() => selfDeletedIds.delete(id), 5000);
    } });
  const workPanel = window.createWorkPanel({ context, setStatus, openFilePreview });
  $('conversationActions').onclick = () => sidebar.openCurrentActions($('conversationActions'));
  const goalUI = createClaudeGoalUI({ $, context, canChangeContext: () => !editingMessage && canChangeContext() && !running, openHistorySession, setStatus,
    acceptEvents: () => { acceptSessionEvents = true; }, onChange: () => { sidebar.updateLabel(); updateConversationControls(); queueMicrotask(drainMessageQueue); }, openActionMenu, closePops });

  // /find turns the composer into a file search box: type what you want, and
  // the matching files come back on this computer as a normal reply, ready for
  // the artifact panel here and the download sheet on the phone.
  function createFindUI() {
    let draft = false, savedPlaceholder = null;
    const row = $('findRow');
    function render() {
      row.replaceChildren();
      row.hidden = !draft;
      if (!draft) return;
      const chip = document.createElement('span');
      chip.className = 'goal-chip draft';
      chip.title = 'File search';
      chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.2-4.2"/></svg><span class="goal-chip-text"></span><button class="attchip-x" title="Remove">✕</button>';
      const text = chip.querySelector('.goal-chip-text');
      text.dataset.i18n = '';
      text.textContent = 'Find files';
      chip.querySelector('.attchip-x').addEventListener('click', event => { event.stopPropagation(); setDraft(false); });
      row.appendChild(chip);
      const scope = document.createElement('span');
      scope.className = 'goal-chip draft';
      scope.title = 'Searched folders';
      const scopeText = document.createElement('span');
      scopeText.className = 'goal-chip-text'; scopeText.dataset.i18n = '';
      scopeText.textContent = findScopeLabel();
      scope.appendChild(scopeText);
      row.appendChild(scope);
    }
    function findScopeLabel() {
      const session = sidebar.sessions.find(entry => entry.id === context.sessionId);
      const workspace = sidebar.workspaces.find(item => item.id === (session?.workspaceId || context.workspaceId));
      return workspace ? 'Folder: ' + workspace.name : 'This conversation folder';
    }
    function setDraft(value, focus = true) {
      draft = value;
      if (draft) {
        if (!savedPlaceholder) savedPlaceholder = input.placeholder;
        input.placeholder = "Describe the file (press Enter with nothing to list recent files)";
        if (focus) input.focus();
      } else if (savedPlaceholder) {
        input.placeholder = savedPlaceholder;
        savedPlaceholder = null;
      }
      render();
      updateSendEnabled();
    }
    async function run(query) {
      if (context.sessionId && conversationBusy()) { setStatus('Available when this conversation stops working'); return false; }
      setStatus(query ? 'Looking for files…' : 'Listing recent files…');
      try {
        const result = await chatApi.find({ sessionId: context.sessionId || null, workspaceId: context.workspaceId || null, query });
        if (!result?.ok) { setStatus(result?.error || 'Search failed'); return false; }
        setDraft(false);
        if (result.sessionId !== context.sessionId) await openHistorySession(result.sessionId);
        else await openHistorySession(context.sessionId);
        setStatus(result.count ? result.count + ' file' + (result.count === 1 ? '' : 's') + ' found'
          : query ? 'No matching files' : 'No files from earlier conversations yet');
        return true;
      } catch (error) { setStatus(error.message); return false; }
    }
    return { isDraft: () => draft, reveal: () => setDraft(true), setDraft, run };
  }
  const findUI = createFindUI();

  let pendingForkId = null;
  const tasksUI = createScheduledTasksUI({ $, context, setStatus });
  async function forkSession(s) {
    if (!canChangeContext()) return;
    loadingSession = true;
    input.disabled = true;
    updateConversationControls();
    updateSendEnabled();
    sidebar.updateLabel();
    try {
      await window.CamelliaI18n.ready;
      const title = window.CamelliaI18n.t('Fork of {0}').replace('{0}', () => s.title);
      const res = await chatApi.forkSession({ sessionId: s.id, title });
      if (!res.ok) throw new Error(res.error);
      pendingForkId = null;
      const workspace = sidebar.workspaces.find(entry => entry.id === context.workspaceId);
      if (workspace?.collapsed) await chatApi.metaOp({ op: 'toggle-collapse', workspaceId: workspace.id });
      await sidebar.load();
      loadingSession = false;
      if (await openHistorySession(res.sessionId)) {
        setStatus('Session forked. Use Rename in its sidebar menu to change its name.');
        input.focus();
      }
    } catch (err) { setStatus('Could not fork session: ' + err.message); }
    finally {
      loadingSession = false;
      input.disabled = false;
      updateConversationControls();
      updateSendEnabled();
      sidebar.updateLabel();
    }
  }
  async function openHistorySession(id) {
    if (!canChangeContext()) return false;
    saveDraft();
    if (!leaveDiscussion()) return false;
    const seq = ++sessionOpenSeq;
    resetConversationView();
    loadingSession = true; input.disabled = true;
    historyOpening = true;
    restoringRun = true;
    context.sessionId = id;
    context.workspaceId = sidebar.sessions.find(entry => entry.id === id)?.workspaceId || null;
    conversationActivity = sidebar.sessions.find(entry => entry.id === id)?.activity || null;
    input.value = ''; attachments = []; renderAttachments();
    updateConversationControls();
    updateSendEnabled();
    sidebar.updateLabel();
    setStatus("Loading history…");
    try {
      const res = await chatApi.loadSession(id);
      if (seq !== sessionOpenSeq) return false;
      if (!res.ok) {
        context.sessionId = null;
        conversationActivity = null;
        chat.replaceChildren(emptyStateTemplate.cloneNode(true));
        throw new Error(res.error);
      }
      const s = sidebar.sessions.find((entry) => entry.id === id);
      if (res.currentEngine && res.currentEngine !== harnessId) {
        loadedEngine = res.currentEngine;
        writeUi('location', { sessionId: id, workspaceId: res.workspaceId });
        restoreDraft();
        const opened = await window.dshDesktop.conversationSwitch({ engine: res.currentEngine, sessionId: id, navigate: true });
        if (!opened.ok) throw new Error(opened.error);
        return false;
      }
      context.sessionId = id;
      if (res.remoteQueue) applyRemoteQueue(res.remoteQueue);
      void tasksUI.refresh();
      context.workspaceId = res.workspaceId || null;
      conversationPrefs = res.preferences || conversationPrefs;
      loadedEngine = res.currentEngine || harnessId;
      conversationActivity = res.activity || null;
      updateConversationControls();
      $('conversationOrigin').hidden = !conversationPrefs.showOrigin || !res.origin;
      $('conversationOrigin').textContent = res.origin === harnessId ? 'Created in this engine' : 'Created in ' + res.origin;
      if (res.settings) applySessionSettings(res.settings);
      void loadSettings();
      acceptSessionEvents = false;
      currentRunId = null;
      pendingForkId = null;
      turnEl = null;
      turnEngine = null;
      blocks = {};
      pendingTools = {};
      todoItems = null;
      todoPanelEl = null;
      hideSuggestion();
      chat.innerHTML = '';
      $('headerTitle').textContent = s ? s.title : "Session " + id.slice(0, 8);
      $('headerTitle').dataset.titled = '1';
      if (!res.live && !await renderHistoryMessages(res.messages, res.historyPage)) return false;
      if (!res.live) {
        const last = res.messages.findLast(message => ['user', 'assistant'].includes(message.role));
        if (last?.role === 'assistant' && (!last.runResult || last.runResult.subtype === 'success'))
          offerTextChoice([...chat.querySelectorAll('.turn')].at(-1),
            answerText(last.outputBlocks?.filter(block => block.phase === 'final_answer').at(-1)?.text || last.text));
      }
      showFailedSend(readUi('failed-send:' + id));
      if (!chat.childElementCount) chat.innerHTML = "<div class=\"empty-state\"><div class=\"empty-state-desc\" data-i18n>No messages to display. Send a message to continue this session.</div></div>";
      sidebar.render();
      restoreDraft();
      setStatus(res.interrupted ? 'The last turn was interrupted. Review its result before continuing.' : res.truncated ? "Showing the latest 200 messages. Continuation uses the full history." : "History loaded. Your next message continues this session.");
      if (!await applyLiveRun(res.live)) return false;
      workPanel.update(res.subagents);
      if (seq !== sessionOpenSeq) return false;
      const lastSeq = res.live?.eventSeq || 0;
      const liveRun = res.live?.runId;
      restoringRun = false;
      for (const event of eventsDuringRestore.splice(0)) if (event.type === 'conversation:activity' || event.runId !== liveRun || event.eventSeq > lastSeq) handleEvent(event);
      const pending = pendingConversationSend();
      if (pending?.phase || res.compaction) handleConversationStatus({ sessionId: id,
        text: pending?.phase || (res.compaction?.state === 'running' ? 'Compacting context…' : ''), compaction: res.compaction });
      void goalUI.refresh();
      if (res.lastReplyAt) sidebar.markReplyRead(id, res.lastReplyAt);
      scrollToLatest();
      return true;
    } catch (err) { if (seq === sessionOpenSeq && !/archived/i.test(err.message)) setStatus("Could not load: " + err.message); return false; }
    finally {
      if (seq === sessionOpenSeq) { historyOpening = false; loadingSession = false; input.disabled = false; restoringRun = false; updateSendEnabled(); updateConversationControls(); sidebar.updateLabel(); saveDraft(); restoreFailedMessageEdit(); }
    }
  }

  async function renderHistoryMessages(messages, pagination) {
      const openSeq = sessionOpenSeq;
      const latest = messages.findLast(message => message.role === 'assistant'
        && (contextTokens(message.lastCallUsage) > 0 || contextTokens(message.usage) > 0));
      const latestAssistant = messages.findLast(message => message.role === 'assistant');
      const latestUser = messages.findLast(message => message.role === 'user');
      contextUsage = null;
      lastUsage = latest?.usage || null;
      lastCallUsage = latest?.lastCallUsage || null;
      updateCtxRing();
      const pageSize = 100;
      let start = Math.max(0, messages.length - pageSize);
      if (start || pagination?.nextBefore != null) {
        const earlier = document.createElement('button');
        earlier.type = 'button'; earlier.className = 'history-earlier';
        earlier.textContent = window.CamelliaI18n.t('Load earlier messages');
        chat.appendChild(earlier);
        earlier.onclick = async () => {
          earlier.disabled = true;
          const anchor = earlier.nextSibling;
          const top = anchor?.getBoundingClientRect().top;
          try {
            let rows;
            if (start) {
              const end = start; start = Math.max(0, start - pageSize); rows = messages.slice(start, end);
            } else {
              const response = await chatApi.loadSession(context.sessionId, { before: pagination.nextBefore, version: pagination.version });
              if (openSeq !== sessionOpenSeq) return;
              if (!response.ok) throw new Error(response.error);
              rows = response.messages; pagination = response.historyPage;
            }
            if (!await paint(rows, anchor) || openSeq !== sessionOpenSeq) return;
            if (!start && pagination?.nextBefore == null) earlier.remove();
            if (anchor) chatScroll.scrollTop += anchor.getBoundingClientRect().top - top;
            updateMessageActions();
          } catch (error) { if (openSeq === sessionOpenSeq) setStatus(error.message); }
          finally { if (openSeq === sessionOpenSeq) earlier.disabled = false; }
        };
      }
      if (!await paint(messages.slice(start)) || openSeq !== sessionOpenSeq) return false;
      updateMessageActions();
      updateSwitchHint();
      return true;

      async function paint(rows, before = null) {
        let batchStarted = performance.now();
        for (const m of rows) {
          if (openSeq !== sessionOpenSeq) return false;
          if (performance.now() - batchStarted > 8) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (openSeq !== sessionOpenSeq) return false;
            batchStarted = performance.now();
          }
          if (m.role === 'notice') {
            if (m.compaction || ['Context compacted automatically', 'Context compacted: summary saved'].includes(m.text)) {
              renderCompactionStatus({ ...m.compaction, engine: m.engine, state: m.compaction?.state || 'completed', error: m.compaction?.error || (m.compaction?.state === 'failed' ? m.text : ''), seq: m.seq }, before);
              continue;
            }
            if (!conversationPrefs.showOrigin) continue;
            const note = document.createElement('div'); note.className = 'handoff-notice'; note.textContent = m.text;
            if (m.file) { const button = document.createElement('button'); button.textContent = 'Open Markdown'; button.onclick = () => window.dshDesktop.conversationOpenHandoff({ sessionId: context.sessionId, file: m.file }); note.appendChild(button); }
            chat.insertBefore(note, before);
          }
          else if (m.role === 'user') {
            const user = addUser(m.displayText ?? m.text, m.attachments, { ...m, history: true });
            if (before) chat.insertBefore(user, before);
          }
          else {
            const div = document.createElement('div');
            div.className = 'turn';
            const label = m.engine ? ENGINE_SHORT_NAMES[m.engine] || m.engine : 'Assistant';
            div.innerHTML = '<div class="turn-meta">' + (m.engine ? engineAvatar(m.engine) : chatAvatar) + '<span>' + esc(label) + '</span></div><div class="turn-body"><div class="md"></div></div>';
            const runResult = m.runResult;
            const resultOnly = runResult && m.text === runResult.result;
            const body = div.querySelector('.turn-body');
            body.innerHTML = '';
            body.processBlocks = [];
            const outputBlocks = Array.isArray(m.outputBlocks) ? m.outputBlocks : [{ phase: 'final_answer', text: m.text }];
            for (const block of outputBlocks.filter(block => block.text && (!resultOnly || block.phase !== 'final_answer'))) {
              const { body: text, thinking } = splitThinking(block.text);
              if (thinking.trim()) {
                const think = buildThinkBlock('Completed', false, false);
                think.querySelector('.think-body').textContent = thinking.trim();
                body.processBlocks.push(think);
                body.appendChild(think);
              }
              const el = document.createElement('div'); el.className = 'md'; el.innerHTML = mdRender(text);
              el.dataset.phase = block.phase || 'commentary';
              el.artifactText = text;
              body.processBlocks.push(el);
              body.appendChild(el);
            }
            layoutTurnProcess(true, body);
            if (runResult) div.appendChild(runResultChip(runResult, false,
              m === latestAssistant && latestUser?.seq < m.seq ? m.userSeq || latestUser.seq : null).chip);
            turnFooter(div, m.at, () => turnCopyText(div));
            chat.insertBefore(div, before);
            void showTurnArtifacts(div, resultOnly ? '' : m.text, m.artifacts);
          }
        }
        return true;
      }
  }

  function updateSwitchHint() {
    chat.querySelector('.switch-hint')?.remove();
    if (!context.sessionId || !loadedEngine || loadedEngine === harnessId) return;
    const hint = document.createElement('div');
    hint.className = 'switch-hint';
    const mode = conversationPrefs.mode === 'markdown' ? 'Automatic Markdown handoff' : 'Continue directly';
    const t = window.CamelliaI18n.t;
    hint.textContent = t('Last reply from {0} · Continuing with {1}: {2}').replace('{0}', ENGINE_SHORT_NAMES[loadedEngine] || loadedEngine)
      .replace('{1}', chatProfile.name).replace('{2}', t(mode));
    chat.appendChild(hint);
  }

  async function applyLiveRun(live) {
    if (!live) { acceptSessionEvents = true; return true; }
    const openSeq = sessionOpenSeq;
    context.sessionId = live.sessionId; context.workspaceId = live.workspaceId;
    currentRunId = live.runId; acceptSessionEvents = true;
    turnEl = null; blocks = {}; pendingTools = {}; todoItems = null; todoPanelEl = null;
    if (live.engine) turnEngine = live.engine;
    followRunOutput = true;
    chat.innerHTML = '';
    if (!await renderHistoryMessages(live.messages, live.historyPage)) return false;
    addUser(live.displayText ?? live.prompt, live.attachments || [], { seq: live.userSeq, at: live.startedAt });
    setRunning(true);
    runStartedAt = live.startedAt || Date.now();
    sidebar.render();
    // Snapshot events are already ordered. New arrivals remain buffered until
    // this snapshot has been painted, then replay only events after its cursor.
    for (let index = 0; index < live.events.length; index++) {
      if (index && index % 50 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (openSeq !== sessionOpenSeq) return false;
      }
      const buffering = restoringRun;
      restoringRun = false;
      try { handleEvent(live.events[index]); }
      finally { restoringRun = buffering; }
    }
    return true;
  }
  // ---------- settings panel ----------
  $('settingsBtn').addEventListener('click', () => { closePops(); void window.dshDesktop.openSettingsWindow(); });
  function applyRouterModels(state) {
    if (state?.ok === false) return;
    routeModelCatalog = state || {};
    if (Array.isArray(state?.providers)) modelCtxCaps.clear();
    for (const p of state?.providers || []) {
      if (state.enabled === false || p.enabled === false || (p.keys && !p.keys.some(key => key.enabled))) continue;
      for (const m of p.models || []) {
        const previous = modelCtxCaps.get(m.id) || {};
        const limits = { ...previous };
        for (const field of ['contextWindow', 'maxContext']) {
          if (m[field] > 0) limits[field] = previous[field] ? Math.min(previous[field], m[field]) : m[field];
        }
        const effectiveWindow = m.contextWindow || m.maxContext;
        if (effectiveWindow > 0) limits.effectiveWindow = previous.effectiveWindow ? Math.min(previous.effectiveWindow, effectiveWindow) : effectiveWindow;
        modelCtxCaps.set(m.id, limits);
      }
    }
    updateCtxRing();
    if (Array.isArray(state?.models)) routeModels = state.enabled ? state.models : [];
    applyApiLevels();
    if (accountSubscription() && (accountModels.length || googleSubscription())) return;
    if (!Array.isArray(state?.models)) return;
    const models = state.enabled ? state.models : [];
    const canonical = currentModel.replace(/:cloud$/, '');
    // Keep the saved selection ID on its canonical row, including legacy :cloud IDs.
    MODELS.splice(0, MODELS.length, ...(models.length ? [] : [{ id: '', label: "Configure models in Camellia first" }]),
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
    if (harnessId === 'antigravity') {
      $('selPermission').querySelector('[value="ask"]').textContent = googleSubscription() ? 'CLI defaults' : 'Ask before acting';
      $('selPermission').title = googleSubscription() ? 'CLI permission rules apply. Camellia asks for your approval when a tool requires review.' : '';
    }
    currentPermission = permissionLevel(harnessId, s.permissionMode || chatProfile.permission);
    $('selPermission').value = currentPermission;
    currentLevel = s.thinkingBudget || '';
    currentModel = s.model || '';
    currentFastMode = harnessId === 'codex' && (context.sessionId ? s.fastMode : readUi('draft:' + draftKey())?.codexFastMode) === true;
    if (googleSubscription()) {
      const family = accountFamily(currentModel);
      if (family) currentModel = family.id;
    }
    // Keep previously saved custom model selectable even if not in the list.
    if (currentModel && !MODELS.some((m) => m.id === currentModel)) {
      MODELS.push({ id: currentModel, label: currentModel });
    }
    renderModelPill();
  }

  function applyApiLevels() {
    const model = accountModels.find(m => m.id === currentModel);
    const efforts = accountSubscription() ? (model?.supportedReasoningEfforts || [])
      .map(e => e.reasoningEffort || e).filter(id => typeof id === 'string') : window.CamelliaModelLevels.levelsFor(currentModel, routeModelCatalog);
    LEVELS.splice(0, LEVELS.length, { id: '', label: 'Default' },
      ...efforts.map(id => ({ id, label: window.CamelliaModelLevels.labelFor(id, currentModel, accountSubscription() ? undefined : routeModelCatalog) })));
    // The saved level may have been rendered before its model's levels loaded.
    renderModelPill();
  }
  async function loadSettings() {
    const seq = ++settingsLoadSeq, sessionId = context.sessionId;
    try {
      const selected = await chatApi.getSettings({ sessionId });
      if (selected.ok === false) throw new Error(selected.error);
      const subscription = supportsAccounts() && selected.connection === 'subscription';
      // Engines with subscriptions load both lists so the composer can offer
      // account and API models together and pick the connection itself.
      const [routerState, accountState, preferences] = await Promise.all([
        window.dshDesktop.apiRouterGetState(),
        supportsAccounts() ? Promise.resolve().then(() => window.dshDesktop[harnessId + 'AccountState'](
          harnessId === 'codex' ? { id: selected.subscriptionId } : undefined))
          .catch(error => ({ ok: false, error: error.message })) : Promise.resolve(null),
        window.dshDesktop.workbenchSettings(),
      ]);
      if (seq !== settingsLoadSeq || sessionId !== context.sessionId) return;
      hiddenSubscriptionModels = preferences?.hiddenSubscriptionModels || {};
      accountModels = accountState?.ok && Array.isArray(accountState.models) ? accountState.models : [];
      applySessionSettings(selected);
      // Fills API routes and context caps independently of account sign-in.
      applyRouterModels(routerState);
      if (subscription) {
        const account = accountState || {};
        const apiOnly = !accountModels.length && !googleSubscription() && routeModels.length > 0;
        if (!account.ok && !apiOnly) throw new Error(account.error);
        if (!apiOnly) {
          const visible = visibleAccountModels();
          MODELS.splice(0, MODELS.length, ...(accountModels.length ? [] : [{ id: '', label: 'Connect ' + accountName + ' in settings' }]),
            ...visible.map(model => ({ id: model.id, label: model.name || model.displayName || model.id })));
          if (currentModel && !accountModels.some(model => model.id === currentModel)) MODELS.push({ id: currentModel, label: currentModel + ' (refresh account)' });
        }
        $('modelPill').title = window.CamelliaI18n.t('Model · double-click to switch to your model and reasoning default');
        renderModelPill(); updateCtxRing();
      }
      applyApiLevels();
    } catch (error) { if (seq === settingsLoadSeq && sessionId === context.sessionId) setStatus("Could not load settings: " + error.message); }
  }

  window.dshDesktop.onEngineSettingsChanged(({ engine }) => { if (engine === harnessId) void loadSettings(); });
  window.dshDesktop.onArchivedChanged?.(({ id, action, ids }) => {
    // Our own delete already reloaded and moved to the neighbor; ignore its echo.
    if (selfDeletedIds.has(id)) { selfDeletedIds.delete(id); return; }
    if (action === 'delete-all') {
      if (context.sessionId && ids?.includes(context.sessionId)) void newSession(null);
      else void sidebar.load();
      return;
    }
    if (action === 'delete' && context.sessionId === id) void newSession(null);
    else void sidebar.load();
  });

  window.CamelliaWorkbenchNavigation?.rememberEngine(harnessId);
  sidebar.render();
  void goalUI.refresh();
  chatApi.onEvent((ev) => handleEvent(ev));
  void (async () => {
    input.disabled = true;
    await sidebar.load();
    const previous = readUi('location');
    const navigation = new URLSearchParams(location.search), newDraft = navigation.get('new') === '1';
    const id = newDraft ? null : navigation.get('conversation') || previous?.sessionId;
    if (!running) {
      if (id) await openHistorySession(id);
      else {
        const workspace = newDraft ? navigation.get('workspace') : previous?.workspaceId;
        if (workspace && sidebar.workspaces.some(w => w.id === workspace)) context.workspaceId = workspace;
      }
    }
    restoringRun = false; eventsDuringRestore.length = 0;
    await loadSettings();
    await goalUI.refresh();
    restoreDraft(); uiReady = true; input.disabled = false; saveDraft(); sidebar.render();
    if (navigation.get('addWorkspace') === '1') $('wsCreateBtn')?.click();
    if (newDraft) { for (const key of ['new', 'workspace', 'addWorkspace']) navigation.delete(key); history.replaceState(null, '', '?' + navigation); }
    if (navigation.get('discussion') === '1') {
      await openDiscussions({ group: navigation.get('group'), intent: navigation.get('intent') });
    } else if (window.requestIdleCallback) requestIdleCallback(() => { void discussionSurface.prepare().catch(() => {}); });
  })().catch(error => { input.disabled = false; setStatus('Could not restore the conversation: ' + error.message); });
  window.dshDesktop.onApiRouterState(applyRouterModels);

  window.CamelliaChatModeSelect.populate($('engineSwitch'), harnessId);
  $('engineSwitch').disabled = false;
  $('handoffBtn').hidden = false;
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
  async function openDiscussions(navigation) {
    if (!uiReady || !canChangeContext()) return;
    const ticket = ++discussionNavigationSeq;
    discussionOpening = true;
    try {
      await discussionSurface.prepare();
      if (ticket !== discussionNavigationSeq || !canChangeContext()) return;
      if (discussionVisible && !discussionSurface.suspend()) return;
      await discussionSurface.open(navigation);
      if (ticket !== discussionNavigationSeq || !canChangeContext()) return;
      if (!discussionVisible) {
        saveDraft(); ++sessionOpenSeq; resetConversationView(); closeFilePreview();
        loadingSession = false; input.disabled = false;
        context.sessionId = null; context.workspaceId = null;
        discussionVisible = true; document.querySelector('.app > .main').hidden = true;
        $('discussionSurface').hidden = false;
      }
      if (ticket === discussionNavigationSeq && discussionVisible) { setWorkbenchSidebarOpen(false); sidebar.render(); updateDiscussionLocation(); discussionSurface.refresh(); }
    } catch (error) { if (ticket === discussionNavigationSeq) { if (discussionVisible) discussionSurface.error(error); else setStatus(error.message); } }
    finally { if (ticket === discussionNavigationSeq) discussionOpening = false; }
  }
  function leaveDiscussion() {
    if (discussionVisible && !discussionSurface.suspend()) return false;
    ++discussionNavigationSeq;
    discussionOpening = false;
    discussionVisible = false;
    setWorkbenchSidebarOpen(false);
    updateDiscussionLocation();
    if ($('discussionSurface')) $('discussionSurface').hidden = true;
    document.querySelector('.app > .main').hidden = false;
    return true;
  }
  function updateDiscussionLocation() {
    const query = new URLSearchParams(location.search);
    for (const key of ['discussion', 'group', 'intent']) query.delete(key);
    if (discussionVisible) {
      query.delete('conversation'); query.set('discussion', '1');
      if (discussionSurface.groupId) query.set('group', discussionSurface.groupId);
    }
    history.replaceState(null, '', '?' + query);
  }
  const discussionHost = document.createElement('section');
  discussionHost.id = 'discussionSurface'; discussionHost.className = 'discussion-surface'; discussionHost.hidden = true;
  document.querySelector('.app').append(discussionHost);
  function setWorkbenchSidebarOpen(open) {
    const narrow = innerWidth <= 680;
    document.body.classList.toggle('workbench-sidebar-open', narrow && open);
    $('sidebar').inert = narrow && !open;
    $('workbenchSidebarBackdrop').hidden = !narrow || !open;
    $('workbenchSidebarToggle').setAttribute('aria-expanded', String(narrow && open));
    discussionHost.shadowRoot?.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(narrow && open));
  }
  const toggleWorkbenchSidebar = () => setWorkbenchSidebarOpen(!document.body.classList.contains('workbench-sidebar-open'));
  $('workbenchSidebarToggle').onclick = toggleWorkbenchSidebar;
  $('workbenchSidebarBackdrop').onclick = () => setWorkbenchSidebarOpen(false);
  window.addEventListener('resize', () => setWorkbenchSidebarOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !discussionHost.shadowRoot?.querySelector('dialog[open]')) setWorkbenchSidebarOpen(false);
  });
  setWorkbenchSidebarOpen(false);
  let selectedDiscussionId = null;
  async function navigateFromDiscussion(target) {
    if (target !== harnessId) return window.dshDesktop.conversationSwitch({ engine: target, navigate: true });
    const previous = readUi('location');
    if (previous?.sessionId) await openHistorySession(previous.sessionId); else await newSession(previous?.workspaceId);
    return { ok: true };
  }
  discussionSurface = window.CamelliaDiscussionSurface.create({ host: discussionHost,
    onChange: id => { if (discussionVisible && id !== selectedDiscussionId) { selectedDiscussionId = id; sidebar.render(); updateDiscussionLocation(); } },
    onRename: row => sidebar.renameDiscussion(row), onSidebarToggle: toggleWorkbenchSidebar,
  });
  $('engineSwitch').onchange = () => {
    const target = $('engineSwitch').value; $('engineSwitch').value = harnessId;
    if (target !== harnessId) void switchOptions(target);
  };
  window.dshDesktop.onHarnessNavigate?.(target => { if (discussionVisible) void navigateFromDiscussion(target); else if (target !== harnessId) void switchOptions(target); });
  window.dshDesktop.onDiscussionNavigate?.(openDiscussions);
  $('handoffBtn').onclick = () => void switchOptions(harnessId, true);
  $('switchCancel').onclick = () => $('switchDialog').close();
  $('switchConfirm').onclick = () => { $('switchDialog').close(); void switchConversation($('switchTarget').value, $('switchMethod').value); };
  $('handoffStop').onclick = () => void chatApi.cancel({ sessionId: context.sessionId });
  window.dshDesktop.onConversationStatus(handleConversationStatus);
