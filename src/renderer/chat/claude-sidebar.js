'use strict';

function createClaudeSidebar({ $, context, contextBusy, canChangeContext, setStatus, newSession, openHistorySession, forkSession, canFork = () => true, openActionMenu, closePops }) {
  const input = $('input');
  let sessionHistory = [], workspaces = [];
  let historyLoadSeq = 0;
  let pagination = {}, limits = {};
  let drag = null, suppressClickUntil = 0;
  const replyReadKey = id => 'reply-read:' + id;
  function replyReadAt(id) {
    const value = Number(localStorage.getItem('camellia-chat-' + replyReadKey(id)));
    return Number.isFinite(value) ? value : 0;
  }
  function markReplyRead(id, at = Date.now()) {
    if (!id) return;
    localStorage.setItem('camellia-chat-' + replyReadKey(id), String(at));
    const session = sessionHistory.find(entry => entry.id === id);
    if (session) session.unread = false;
  }
  // ---------- Workspaces and session history ----------
  const SIDEBAR_ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
  };
  function sidebarIcon(name) {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SIDEBAR_ICONS[name] + '</svg>';
  }
  function relTime(ms) {
    const min = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    if (min < 1) return "Just now";
    if (min < 60) return min + ' min ago';
    if (min < 1440) return Math.floor(min / 60) + ' hr ago';
    return Math.floor(min / 1440) + ' days ago';
  }
  function updateWorkspaceLabel() {
    $('newSessionBtn').disabled = contextBusy();
  }
  async function loadSessionHistory() {
    const seq = ++historyLoadSeq;
    try {
      const res = await chatApi.listSessions({ limits, activeSessionId: context.sessionId });
      if (seq !== historyLoadSeq) return false;
      if (!res.ok) throw new Error(res.error);
      sessionHistory = res.sessions.map(session => ({ ...session,
        unread: session.id !== context.sessionId && session.lastReplyAt > replyReadAt(session.id) }));
      workspaces = res.workspaces;
      pagination = res.pagination;
      const active = sessionHistory.find((s) => s.id === context.sessionId);
      if (active) context.workspaceId = active.workspaceId || null;
      if (context.workspaceId && !workspaces.some((w) => w.id === context.workspaceId)) context.workspaceId = null;
      renderSessionSidebar();
      return true;
    } catch (err) {
      setStatus("Could not load session: " + err.message);
      return false;
    }
  }
  function sidebarButton(icon, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-more';
    button.dataset.i18nAttrs = 'title aria-label'; button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = sidebarIcon(icon);
    button.addEventListener('click', (e) => { e.stopPropagation(); onClick(button); });
    return button;
  }
  function appendGroup(list, label, button) {
    const group = document.createElement('div');
    group.className = 'sb-group sb-flex';
    group.dataset.i18n = ''; group.textContent = label;
    if (button) group.appendChild(button);
    list.appendChild(group);
    return group;
  }
  function renderSessionSidebar() {
    if (drag?.active) return;
    const list = $('sessionList');
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (importableCount > 0) {
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'import-hint';
      hint.innerHTML = '<span data-i18n></span><span class="import-dismiss" role="button" aria-label="Dismiss">×</span>';
      hint.querySelector('span[data-i18n]').textContent = importableCount + ' local Codex sessions can be imported';
      hint.addEventListener('click', () => void openImportDialog());
      hint.querySelector('.import-dismiss').addEventListener('click', (e) => { e.stopPropagation(); importableCount = 0; renderSessionSidebar(); });
      list.appendChild(hint);
    }
    const sessions = sessionHistory.slice();
    if (context.sessionId && !sessions.some((s) => s.id === context.sessionId)) {
      sessions.unshift({ id: context.sessionId, title: $('headerTitle').textContent, workspaceId: context.workspaceId, mtimeMs: Date.now() });
    }
    const pinned = sessions.filter((s) => s.pinned);
    const groupedSessions = new Map();
    for (const s of sessions) {
      const key = s.workspaceId || null;
      if (!groupedSessions.has(key)) groupedSessions.set(key, []);
      groupedSessions.get(key).push(s);
    }
    if (pinned.length) {
      appendGroup(list, "Pinned").dataset.dropGroup = 'pinned';
      pinned.forEach((s) => list.appendChild(makeSessionItem(s)));
      appendMore(list, 'pinned');
    }
    const add = sidebarButton('plus', "Add workspace", () => openWorkspaceDialog());
    add.id = 'wsCreateBtn';
    appendGroup(list, 'Workspaces', add);
    for (const ws of workspaces) {
      const workspaceSessions = groupedSessions.get(ws.id) || [];
      const section = document.createElement('section');
      section.dataset.workspaceId = ws.id;
      section.dataset.dropGroup = ws.id;
      section.setAttribute('aria-label', ws.name);
      const row = document.createElement('div');
      row.className = 'session-item ws-row' + (ws.collapsed ? ' collapsed' : '') + (context.workspaceId === ws.id ? ' active' : '');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-expanded', String(!ws.collapsed));
      row.title = ws.path;
      row.innerHTML = '<span class="ws-chev">' + sidebarIcon('chevron') + '</span>' + sidebarIcon('folder') + '<span class="session-item-text ws-name"></span><span class="ws-count"></span>';
      row.querySelector('.ws-name').textContent = ws.name;
      row.querySelector('.ws-count').textContent = ws.sessionCount || '';
      const toggle = async () => {
        const res = await runMetaOp({ op: 'toggle-collapse', workspaceId: ws.id });
        if (res) await loadSessionHistory();
      };
      row.addEventListener('click', () => void toggle());
      row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggle(); }
      });
      row.appendChild(sidebarButton('plus', 'New session in ' + ws.name, () => void newSession(ws.id)));
      row.appendChild(sidebarButton('more', ws.name + " workspace actions", (button) => openWorkspaceActions(button, ws)));
      section.appendChild(row);
      if (!ws.collapsed) {
        const children = document.createElement('div');
        children.className = 'ws-children';
        const grouped = workspaceSessions.filter((s) => !s.pinned);
        if (!context.sessionId && context.workspaceId === ws.id) children.appendChild(makeSessionItem(null));
        grouped.forEach((s) => children.appendChild(makeSessionItem(s)));
        appendMore(children, ws.id);
        if (!children.childElementCount) {
          const empty = document.createElement('div');
          empty.dataset.i18n = ''; empty.className = 'ws-empty';
          empty.textContent = workspaceSessions.length ? "Session appears in Pinned" : "No sessions. Click + to start.";
          children.appendChild(empty);
        }
        section.appendChild(children);
      }
      list.appendChild(section);
    }
    if (!workspaces.length) {
      const empty = document.createElement('button');
      empty.type = 'button';
      empty.dataset.i18n = ''; empty.className = 'ws-create-link';
      empty.textContent = "Add a folder as a workspace";
      empty.addEventListener('click', () => openWorkspaceDialog());
      list.appendChild(empty);
    }
    appendGroup(list, "Standalone sessions").dataset.dropGroup = 'recent';
    const independent = document.createElement('div');
    independent.id = 'independentSessions';
    independent.dataset.dropGroup = 'recent';
    if (!context.sessionId && !context.workspaceId) independent.appendChild(makeSessionItem(null));
    (groupedSessions.get(null) || []).filter((s) => !s.pinned).forEach((s) => independent.appendChild(makeSessionItem(s)));
    appendMore(independent, 'recent');
    if (!independent.childElementCount) {
      const empty = document.createElement('div');
      empty.dataset.i18n = ''; empty.className = 'ws-empty';
      empty.textContent = "Choose New session to start a standalone conversation";
      independent.appendChild(empty);
    }
    list.appendChild(independent);
    list.scrollTop = scroll;
    updateWorkspaceLabel();
  }
  function appendMore(container, group) {
    const page = pagination[group];
    if (!page?.hasMore) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-more'; button.dataset.i18n = '';
    button.dataset.group = group;
    button.textContent = `Load more (${page.loaded} / ${page.total})`;
    button.addEventListener('click', async () => {
      button.disabled = true;
      limits[group] = page.loaded + 60;
      if (!await loadSessionHistory()) button.disabled = false;
    });
    container.appendChild(button);
  }
  function makeSessionItem(s) {
    const active = s ? s.id === context.sessionId : !context.sessionId;
    const item = document.createElement('div');
    item.className = 'session-item' + (active ? ' active' : '');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    if (active) item.setAttribute('aria-current', 'true');
    if (s) { item.dataset.history = '1'; item.dataset.sid = s.id; item.dataset.dropGroup = s.pinned ? 'pinned' : s.workspaceId || 'recent'; }
    else item.id = 'sessionCurrent';
    const title = s ? s.title : $('headerTitle').textContent;
    item.title = title + (s && s.cwd ? '\n' + s.cwd : '');
    item.innerHTML = sidebarIcon('chat') + '<span class="session-item-text"><span></span></span><span class="session-unread" title="Unread agent reply" aria-label="Unread agent reply" data-i18n-attrs="title aria-label"></span><span class="session-item-time" data-i18n></span>';
    item.classList.toggle('unread', Boolean(s?.unread));
    item.querySelector('.session-item-text > span').textContent = title || "(Empty session)";
    if (s?.showOrigin && s.origin) {
      const badge = document.createElement('span'); badge.className = 'session-origin'; badge.dataset.i18n = '';
      badge.textContent = s.origin === harnessId ? 'Created here' : 'Created in ' + s.origin;
      item.querySelector('.session-item-text').appendChild(badge);
    }
    const activity = s?.activity;
    item.dataset.activity = activity || '';
    item.querySelector('.session-item-time').textContent = activity === 'permission' ? 'Needs approval' : activity === 'question' ? 'Needs input' : activity ? 'Working' : s ? relTime(s.mtimeMs) : 'Now';
    const open = () => { if (s && (s.id !== context.sessionId || ['permission', 'question'].includes(s.activity))) void openHistorySession(s.id); else input.focus(); };
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
      if (e.target !== item) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    const showActions = (button, position) => {
      openSessionActions(button, item, s, position);
    };
    const moreButton = sidebarButton('more', "Session actions", showActions);
    item.appendChild(moreButton);
    item.addEventListener('contextmenu', (event) => {
      if (event.target.closest('input, textarea, [contenteditable]')) return;
      event.preventDefault();
      event.stopPropagation();
      showActions(moreButton, { x: event.clientX, y: event.clientY });
    });
    return item;
  }
  async function runMetaOp(payload) {
    try {
      const res = await chatApi.metaOp(payload);
      if (!res.ok) throw new Error(res.error);
      return res;
    } catch (err) { setStatus(err.message); return null; }
  }
  function openWorkspaceActions(anchor, ws) {
    openActionMenu(anchor, [
      { label: "New session in this workspace", disabled: contextBusy(), run: () => void newSession(ws.id) },
      { label: "Rename workspace", run: () => openWorkspaceDialog(ws) },
      { label: "Remove workspace (keep sessions)", disabled: contextBusy(), run: () => removeWorkspace(ws, false) },
      { label: "Remove workspace (archive sessions)", disabled: contextBusy(), run: () => removeWorkspace(ws, true) },
    ]);
  }
  function clearDropIndicator() {
    $('sessionList').querySelectorAll('.session-drop-before, .session-drop-after, .session-drop-group').forEach(element => {
      element.classList.remove('session-drop-before', 'session-drop-after', 'session-drop-group');
    });
    $('sessionList').querySelectorAll('[data-sid]').forEach(item => item.style.removeProperty('--session-drag-offset'));
  }
  function dragMotionDuration(duration) {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration;
  }
  function createDragPreview() {
    const rect = drag.item.getBoundingClientRect();
    const preview = document.createElement('div');
    preview.className = 'session-drag-preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.inert = true;
    preview.style.width = rect.width + 'px';
    const card = drag.item.cloneNode(true);
    card.removeAttribute('id'); card.removeAttribute('data-sid'); card.removeAttribute('data-drop-group');
    card.removeAttribute('aria-current'); card.removeAttribute('role'); card.removeAttribute('tabindex');
    card.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    card.className = 'session-item session-drag-card';
    card.style.height = rect.height + 'px';
    preview.appendChild(card);
    document.body.appendChild(preview);
    drag.preview = preview;
    drag.offsetX = drag.x - rect.left; drag.offsetY = drag.y - rect.top;
    drag.origin = rect;
    drag.scrollTop = $('sessionList').scrollTop;
    drag.dropRects = [...$('sessionList').querySelectorAll('[data-drop-group]')].map(element => ({ element, rect: element.getBoundingClientRect() }));
    positionDragPreview();
    card.animate([{ transform: 'scale(1)', opacity: .8 }, { transform: 'scale(1.035)', opacity: 1 }],
      { duration: dragMotionDuration(220), easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function positionDragPreview() {
    drag.preview.style.transform = `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0)`;
  }
  function updateDropTarget() {
    const list = $('sessionList');
    const bounds = list.getBoundingClientRect();
    const scrollDelta = list.scrollTop - drag.scrollTop;
    let hit = null;
    if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom) {
      for (const candidate of drag.dropRects) {
        const rect = candidate.rect;
        if (drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top - scrollDelta && drag.y <= rect.bottom - scrollDelta) hit = candidate;
      }
    }
    const hovered = hit?.element.dataset.sid === drag.sessionId ? null : hit?.element;
    const targetSessionId = hovered?.dataset.sid;
    const placement = hit && drag.y < hit.rect.top - scrollDelta + hit.rect.height / 2 ? 'before' : 'after';
    if (drag.targetElement === hovered && (!hovered || drag.target?.placement === placement)) return;
    clearDropIndicator();
    drag.target = null; drag.targetElement = hovered;
    if (!hovered) return;
    hovered.classList.add(targetSessionId ? 'session-drop-' + placement : 'session-drop-group');
    drag.target = { group: hovered.dataset.dropGroup, targetSessionId, placement };
    if (targetSessionId) {
      const siblings = [...hovered.parentElement.children].filter(element => element.dataset.sid && element.dataset.dropGroup === hovered.dataset.dropGroup);
      const split = siblings.indexOf(hovered) + (placement === 'after' ? 1 : 0);
      siblings.forEach((element, index) => {
        if (element !== drag.item) element.style.setProperty('--session-drag-offset', index < split ? '-5px' : '5px');
      });
    }
  }
  function animateDrag(time = performance.now()) {
    if (!drag?.active) return;
    const list = $('sessionList');
    const rect = list.getBoundingClientRect();
    if (drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom) {
      const distance = drag.y < rect.top + 32 ? drag.y - rect.top - 32 : drag.y > rect.bottom - 32 ? drag.y - rect.bottom + 32 : 0;
      const elapsed = drag.lastFrame === undefined ? 16 : Math.min(32, time - drag.lastFrame);
      list.scrollTop += distance * elapsed / 64;
    }
    drag.lastFrame = time;
    positionDragPreview();
    updateDropTarget();
    drag.frame = requestAnimationFrame(animateDrag);
  }
  function finishDrag(commit = false) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    clearTimeout(finished.timer);
    cancelAnimationFrame(finished.frame);
    if (!finished.active) return;
    const destination = commit && finished.target ? finished.targetElement : finished.item;
    const rect = destination?.getBoundingClientRect() || finished.origin;
    const preview = finished.preview;
    const animation = preview.animate([
      { transform: preview.style.transform, opacity: 1 },
      { transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`, opacity: 0 },
    ], { duration: dragMotionDuration(180), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    animation.finished.then(() => preview.remove(), () => preview.remove());
    suppressClickUntil = Date.now() + 350;
    finished.item.classList.remove('session-dragging');
    document.body.classList.remove('session-drag-active');
    if (finished.item.hasPointerCapture(finished.pointerId)) finished.item.releasePointerCapture(finished.pointerId);
    clearDropIndicator();
    renderSessionSidebar();
    if (commit && finished.target) void (async () => {
      const result = await runMetaOp({ op: 'move-session', sessionId: finished.sessionId, ...finished.target });
      if (result) await loadSessionHistory();
    })();
  }
  const sessionList = $('sessionList');
  sessionList.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || drag || contextBusy()) return;
    if (event.target.closest('button, input, textarea, [contenteditable]')) return;
    const item = event.target.closest('[data-sid]');
    if (!item) return;
    drag = { item, sessionId: item.dataset.sid, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    drag.timer = setTimeout(() => {
      if (!drag || !item.isConnected || contextBusy()) { finishDrag(); return; }
      drag.active = true;
      closePops();
      window.getSelection()?.removeAllRanges();
      item.setPointerCapture(drag.pointerId);
      createDragPreview();
      item.classList.add('session-dragging');
      document.body.classList.add('session-drag-active');
      animateDrag();
    }, 350);
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) { finishDrag(); return; }
    drag.x = event.clientX; drag.y = event.clientY;
    if (drag.active) { event.preventDefault(); updateDropTarget(); }
  }, { passive: false });
  window.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.active) { drag.x = event.clientX; drag.y = event.clientY; updateDropTarget(); }
    finishDrag(true);
  });
  window.addEventListener('pointercancel', () => finishDrag());
  window.addEventListener('blur', () => finishDrag());
  window.addEventListener('resize', () => finishDrag());
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finishDrag(); }
  }, true);
  sessionList.addEventListener('lostpointercapture', () => finishDrag());
  sessionList.addEventListener('dragstart', event => event.preventDefault());
  sessionList.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  sessionList.addEventListener('contextmenu', event => {
    if (drag?.active) { event.preventDefault(); event.stopImmediatePropagation(); }
    else finishDrag();
  }, true);
  async function removeWorkspace(ws, archiveSessions) {
    if (!canChangeContext()) return;
    const res = await runMetaOp({ op: 'delete-workspace', id: ws.id, archiveSessions });
    if (!res) return;
    if (context.workspaceId === ws.id) context.workspaceId = null;
    if (archiveSessions && context.sessionId && res.meta.archived[context.sessionId]) await newSession(null);
    await loadSessionHistory();
    setStatus(archiveSessions ? "Workspace removed. Sessions were archived and files were kept." : "Workspace removed. Sessions and files were kept.");
  }
  function openSessionActions(anchor, item, s, position) {
    if (!s) {
      openActionMenu(anchor, [
        { label: "Change workspace…", disabled: contextBusy(), run: () => openWorkspacePicker(anchor, null, position) },
      ], position);
      return;
    }
    openActionMenu(anchor, [
      { label: "Rename", run: () => startInlineRename(item, s) },
      { label: s.pinned ? "Unpin" : "Pin session", run: async () => {
        if (await runMetaOp({ op: 'toggle-pin', sessionId: s.id })) await loadSessionHistory();
      } },
      ...(!chatProfile.fixedCwd ? [{ label: "Move to workspace…", disabled: contextBusy(), run: () => openWorkspacePicker(anchor, s, position) }] : []),
      ...(s.workspaceId && !chatProfile.fixedCwd ? [{ label: "Move out of workspace", disabled: contextBusy(), run: () => void assignWorkspace(s, null) }] : []),
      ...(canFork(s) ? [{ label: "Fork session", disabled: contextBusy(), run: () => void forkSession(s) }] : []),
      ...(s.imported ? [{ label: "Sync from Codex desktop", run: () => openSyncDialog(s) }] : []),
      { label: "Archive session", disabled: contextBusy(), run: () => void archiveSession(s) },
    ], position);
  }
  function openWorkspacePicker(anchor, s, position) {
    if (s && chatProfile.fixedCwd) {
      openActionMenu(anchor, [
        { label: "This session's directory was set when it was created", disabled: true },
        { label: "New standalone session", disabled: contextBusy(), run: () => void newSession(null) },
        ...workspaces.map(ws => ({ label: "New session in " + ws.name, title: ws.path, disabled: contextBusy(), run: () => void newSession(ws.id) })),
      ], position);
      return;
    }
    const selected = s ? s.workspaceId : context.workspaceId;
    openActionMenu(anchor, [
      { label: "No workspace · Standalone session", current: !selected, disabled: contextBusy(), run: () => void assignWorkspace(s, null) },
      ...workspaces.map((ws) => ({ label: ws.name, title: ws.path, localize: false, current: selected === ws.id, disabled: contextBusy(), run: () => void assignWorkspace(s, ws.id) })),
      { label: "Add workspace…", run: () => openWorkspaceDialog() },
    ], position);
  }
  async function assignWorkspace(s, workspaceId) {
    if (!canChangeContext()) return;
    if (s) {
      if ((s.workspaceId || null) === workspaceId) return;
      if (!await runMetaOp({ op: 'assign-session', sessionId: s.id, workspaceId })) return;
    }
    if (!s || s.id === context.sessionId) context.workspaceId = workspaceId;
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (ws && ws.collapsed) await runMetaOp({ op: 'toggle-collapse', workspaceId });
    await loadSessionHistory();
    setStatus(workspaceId ? "Moved to workspace. The next message will run in that folder." : "Session is now standalone");
  }

  let editingWorkspace = null;
  let workspaceReturnFocus = null;
  function openWorkspaceDialog(ws = null) {
    closePops();
    editingWorkspace = ws;
    workspaceReturnFocus = document.activeElement;
    $('wsDialogTitle').textContent = ws ? "Rename workspace" : "Add workspace";
    $('wsName').value = ws ? ws.name : '';
    $('wsPath').value = ws ? ws.path : '';
    $('wsPath').disabled = Boolean(ws);
    $('wsPathField').hidden = Boolean(ws);
    $('wsHint').hidden = Boolean(ws);
    $('wsError').textContent = '';
    $('wsCreate').textContent = ws ? "Save" : "Add";
    $('wsMask').classList.add('visible');
    $('wsName').focus();
  }
  function closeWorkspaceDialog() {
    if ($('wsCreate').disabled) return;
    $('wsMask').classList.remove('visible');
    if (workspaceReturnFocus && workspaceReturnFocus.isConnected) workspaceReturnFocus.focus();
    else $('input').focus();
  }
  $('wsCancel').addEventListener('click', closeWorkspaceDialog);
  $('wsMask').addEventListener('click', (e) => { if (e.target === $('wsMask')) closeWorkspaceDialog(); });
  $('wsMask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeWorkspaceDialog(); }
    if (e.key === 'Tab') {
      const fields = [...$('wsForm').querySelectorAll('input:not(:disabled), button:not(:disabled)')].filter((el) => el.offsetParent);
      const first = fields[0], last = fields[fields.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  function defaultWorkspaceName() {
    if (!$('wsName').value.trim()) $('wsName').value = $('wsPath').value.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  }
  $('wsPath').addEventListener('change', defaultWorkspaceName);
  $('wsBrowse').addEventListener('click', async () => {
    try {
      const res = await window.dshDesktop.pickFile({ kind: 'directory', title: "Choose workspace folder" });
      if (res.canceled) return;
      $('wsPath').value = res.path;
      defaultWorkspaceName();
    } catch (err) { $('wsError').textContent = err.message; }
  });
  $('wsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('wsCreate').disabled) return;
    $('wsCreate').disabled = true;
    $('wsError').textContent = '';
    try {
      const payload = editingWorkspace
        ? { op: 'rename-workspace', id: editingWorkspace.id, name: $('wsName').value.trim() }
        : { op: 'create-workspace', name: $('wsName').value.trim(), path: $('wsPath').value.trim() };
      const res = await chatApi.metaOp(payload);
      if (!res.ok) throw new Error(res.error);
      if (!editingWorkspace && !context.sessionId && !contextBusy()) context.workspaceId = res.workspace.id;
      $('wsCreate').disabled = false;
      closeWorkspaceDialog();
      await loadSessionHistory();
      setStatus(editingWorkspace ? "Workspace renamed" : "Workspace added");
    } catch (err) { $('wsError').textContent = err.message; }
    finally { $('wsCreate').disabled = false; }
  });
  function startInlineRename(item, s) {
    const titleEl = item.querySelector('.session-item-text > span');
    const inputEl = document.createElement('input');
    inputEl.className = 'session-rename-input';
    inputEl.value = s.title === "(Empty session)" ? '' : s.title;
    titleEl.replaceWith(inputEl);
    inputEl.focus();
    inputEl.select();
    let done = false;
    const commit = async (save) => {
      if (done) return;
      done = true;
      if (save) {
        try {
          const res = await chatApi.renameSession({ id: s.id, title: inputEl.value.trim() });
          if (!res.ok) throw new Error(res.error);
          if (context.sessionId === s.id && inputEl.value.trim()) $('headerTitle').textContent = inputEl.value.trim();
          setStatus("Session renamed");
        } catch (err) { setStatus(err.message); }
      }
      await loadSessionHistory();
    };
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); void commit(false); }
      e.stopPropagation();
    });
    inputEl.addEventListener('blur', () => void commit(true));
    inputEl.addEventListener('click', (e) => e.stopPropagation());
  }
  async function archiveSession(s) {
    if (!canChangeContext()) return;
    try {
      const res = await chatApi.archiveSession({ id: s.id, archived: true });
      if (!res.ok) throw new Error(res.error);
      if (context.sessionId === s.id) await newSession(null);
      await loadSessionHistory();
      setStatus("Session archived");
    } catch (err) { setStatus(err.message); }
  }

  // ---------- local Codex desktop session import ----------
  let importableCount = 0;
  function importRow(s) {
    const label = document.createElement('label');
    label.className = 'import-row';
    label.title = s.cwd || s.project?.path || '';
    if (s.project) label.dataset.project = s.project.id;
    const box = document.createElement('input'); box.type = 'checkbox'; box.value = s.id; box.checked = s.importable; box.disabled = !s.importable;
    const text = document.createElement('span');
    text.textContent = s.title + (s.importable ? '' : ' ' + window.CamelliaI18n.t('(history file missing or unreadable)'));
    label.append(box, text);
    return label;
  }
  function projectHead(project, sessions) {
    const head = document.createElement('div');
    head.className = 'import-project';
    head.dataset.project = project.id;
    const box = document.createElement('input'); box.type = 'checkbox';
    box.setAttribute('aria-label', window.CamelliaI18n.t('Select workspace'));
    const text = document.createElement('span');
    text.className = 'import-project-name';
    text.textContent = project.name || project.path || window.CamelliaI18n.t('Unnamed workspace');
    text.title = project.path || '';
    const count = document.createElement('span');
    count.className = 'import-project-count';
    count.textContent = window.CamelliaI18n.t('{0} sessions').replace('{0}', sessions.length);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'import-project-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', window.CamelliaI18n.t('Collapse workspace'));
    toggle.innerHTML = sidebarIcon('chevron');
    head.append(box, text, count, toggle);
    return head;
  }
  function groupedImportNodes(sessions) {
    const byProject = new Map();
    for (const s of sessions) {
      if (!s.project) continue;
      if (!byProject.has(s.project.id)) byProject.set(s.project.id, { project: s.project, sessions: [] });
      byProject.get(s.project.id).sessions.push(s);
    }
    const nodes = [], seen = new Set();
    for (const s of sessions) {
      if (!s.project) { nodes.push(importRow(s)); continue; }
      if (seen.has(s.project.id)) continue;
      seen.add(s.project.id);
      const group = byProject.get(s.project.id);
      const section = document.createElement('section');
      section.className = 'import-project-group';
      section.dataset.project = group.project.id;
      const children = document.createElement('div');
      children.className = 'import-project-sessions';
      children.append(...group.sessions.map(importRow));
      section.append(projectHead(group.project, group.sessions), children);
      nodes.push(section);
    }
    return nodes;
  }
  function syncImportBoxes() {
    const list = $('importList');
    for (const head of list.querySelectorAll('.import-project')) {
      const boxes = [...list.querySelectorAll('.import-row[data-project="' + head.dataset.project + '"] input[type=checkbox]:not(:disabled)')];
      const box = head.querySelector('input');
      box.disabled = boxes.length === 0;
      box.checked = boxes.length > 0 && boxes.every(b => b.checked);
      box.indeterminate = !box.checked && boxes.some(b => b.checked);
    }
    const boxes = [...list.querySelectorAll('.import-row input[type=checkbox]:not(:disabled)')];
    const all = $('importAll');
    all.disabled = boxes.length === 0;
    all.checked = boxes.length > 0 && boxes.every(b => b.checked);
    all.indeterminate = !all.checked && boxes.some(b => b.checked);
    $('importConfirm').disabled = !boxes.some(b => b.checked);
  }
  async function openImportDialog() {
    const list = $('importList');
    $('importAll').disabled = true;
    $('importConfirm').disabled = true;
    list.innerHTML = '<p class="hint" data-i18n>Reading local Codex sessions\u2026</p>';
    $('importMask').classList.add('visible');
    try {
      const res = await window.dshDesktop.codexDesktopSessions();
      if (!res?.ok) throw new Error(res?.error || 'Could not read the Codex desktop state');
      if (!res.sessions.length) { $('importAll').checked = false; list.innerHTML = '<p class="hint" data-i18n>No local Codex sessions to import.</p>'; return; }
      const all = $('importAll'); all.disabled = false; all.checked = true; all.indeterminate = false;
      $('importConfirm').disabled = false;
      const nodes = groupedImportNodes(res.sessions);
      if (res.truncated) {
        const warning = document.createElement('p'); warning.className = 'hint';
        warning.textContent = window.CamelliaI18n.t('Only the newest 1,000 sessions are shown for safety.');
        nodes.unshift(warning);
      }
      list.replaceChildren(...nodes);
      syncImportBoxes();
    } catch (error) { list.replaceChildren(); const p = document.createElement('p'); p.className = 'hint'; p.textContent = error.message; list.appendChild(p); }
  }
  $('importConfirm').onclick = async () => {
    const ids = [...$('importList').querySelectorAll('.import-row input:checked')].map(i => i.value);
    $('importMask').classList.remove('visible');
    if (!ids.length) return;
    setStatus('Importing\u2026');
    try {
      const res = await window.dshDesktop.codexDesktopImport(ids);
      if (!res?.ok) throw new Error(res?.error || 'Import failed');
      importableCount = Math.max(0, importableCount - (res.imported?.length || 0));
      const skipped = res.skipped?.length || 0;
      setStatus(skipped ? 'Imported ' + (res.imported?.length || 0) + ' sessions \u00b7 ' + skipped + ' skipped' : 'Imported ' + (res.imported?.length || 0) + ' sessions');
      await loadSessionHistory();
    } catch (error) { setStatus(error.message); }
  };
  $('importAll').onchange = e => {
    for (const box of $('importList').querySelectorAll('.import-row input[type=checkbox]:not(:disabled)')) box.checked = e.target.checked;
    $('importAll').indeterminate = false;
    syncImportBoxes();
  };
  $('importList').onchange = (e) => {
    const head = e.target.closest ? e.target.closest('.import-project') : null;
    if (head && e.target.matches('input[type=checkbox]')) {
      for (const b of $('importList').querySelectorAll('.import-row[data-project="' + head.dataset.project + '"] input[type=checkbox]:not(:disabled)')) b.checked = e.target.checked;
    }
    syncImportBoxes();
  };
  $('importList').onclick = (e) => {
    const toggle = e.target.closest ? e.target.closest('.import-project-toggle') : null;
    if (!toggle) return;
    const group = toggle.closest('.import-project-group');
    const collapsed = group.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', window.CamelliaI18n.t(collapsed ? 'Expand workspace' : 'Collapse workspace'));
  };
  $('importCancel').onclick = () => $('importMask').classList.remove('visible');
  $('importBtn').addEventListener('click', () => void openImportDialog());

  // ---------- manual re-sync of an imported conversation ----------
  let syncTarget = null;
  function openSyncDialog(s) {
    syncTarget = s;
    $('syncTitle').textContent = s.title || '';
    $('syncMask').classList.add('visible');
  }
  $('syncCancel').onclick = () => { syncTarget = null; $('syncMask').classList.remove('visible'); };
  $('syncConfirm').onclick = async () => {
    const target = syncTarget; syncTarget = null;
    $('syncMask').classList.remove('visible');
    if (!target) return;
    setStatus('Syncing from the Codex desktop app\u2026');
    try {
      const res = await window.dshDesktop.codexDesktopSync(target.id);
      if (!res?.ok) throw new Error(res?.error || 'Sync failed');
      if (target.id === context.sessionId) await openHistorySession(target.id);
      await loadSessionHistory();
      setStatus('Synced from Codex desktop \u00b7 ' + (res.messages || 0) + ' messages');
    } catch (error) { setStatus(error.message); }
  };

  window.addEventListener('camellia:language', updateWorkspaceLabel);
  return {
    load: loadSessionHistory, render: renderSessionSidebar, updateLabel: updateWorkspaceLabel, metaOp: runMetaOp,
    markReplyRead,
    get sessions() { return sessionHistory; }, get workspaces() { return workspaces; },
  };
}
