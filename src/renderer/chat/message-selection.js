'use strict';

// WeChat-style multi-select for the transcript. The transcript stays the
// source of truth; this controller only adds selection affordances and asks
// the backend for immutable export/delete operations.
window.CamelliaMessageSelection = (() => {
  const ROW_SELECTOR = '.msg-user[data-seq], .turn[data-seq]';
  const MESSAGE_CONTENT = '.msg-user > :is(.bubble, .attchips), .turn > :is(.turn-body, .turn-artifacts)';
  const INTERACTIVE = 'button, a, input, textarea, select, [contenteditable], summary, video, audio';
  const SEQUENCE = row => {
    const raw = row?.dataset?.seq;
    return /^\d+$/.test(String(raw || '')) ? Number(raw) : null;
  };
  const t = (value, ...args) => {
    let text = window.CamelliaI18n?.t?.(value) || value;
    for (const [index, arg] of args.entries()) text = text.replaceAll('{' + index + '}', String(arg));
    return text;
  };

  function create({ chat, chatScroll, inputZone, header, getSessionId, getBusy, getBlockedReason, setStatus, reload }) {
    if (!chat || !chatScroll || !inputZone) return null;
    let selecting = false;
    const selected = new Set();
    let drag = null;
    let suppressClick = false;
    let canceledMouseDrag = false;
    let pendingLoad = false;
    let longPressTimer = 0;
    let menu = null;
    const listeners = new AbortController();
    const { signal } = listeners;
    const dock = document.createElement('div');
    dock.className = 'composer-selection-toolbar';
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', t('Selected messages'));
    dock.hidden = true;
    dock.innerHTML = [
      '<div class="ms-actions">',
      '<button type="button" data-ms-action="copy" title="' + t('Copy') + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>' +
        '<span>' + t('Copy') + '</span></button>',
      '<button type="button" data-ms-action="export" title="' + t('Export') + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M5 19h14"/></svg>' +
        '<span>' + t('Export') + '</span></button>',
      '<button type="button" data-ms-action="delete" class="danger" title="' + t('Delete') + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="m7 7 1 13h8l1-13"/><path d="M10 11v5M14 11v5"/></svg>' +
        '<span>' + t('Delete') + '</span></button>',
      '<button type="button" data-ms-action="exit" title="Exit selection" data-i18n-attrs="title">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>' +
        '<span data-i18n>Exit</span></button>',
      '</div>',
    ].join('');
    // Replace the composer's controls in place, rather than drawing a second
    // card above it. WeChat changes the existing input area the same way.
    const inputCard = inputZone.querySelector('.input-card');
    (inputCard || inputZone.querySelector(':scope > .column'))?.append(dock);
    const marquee = document.createElement('div');
    marquee.className = 'message-selection-marquee';
    marquee.hidden = true;
    marquee.setAttribute('aria-hidden', 'true');
    document.body.append(marquee);

    // Mobile WeChat uses a long-press menu before multi-select. The header
    // swaps only while selecting; the composer's own box is reused below.
    const headerBackup = new Map();
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'message-selection-cancel';
    cancelButton.textContent = t('Cancel');
    const countLabel = document.createElement('span');
    countLabel.className = 'message-selection-count';
    header?.append(cancelButton, countLabel);
    countLabel.hidden = true;
    cancelButton.hidden = true;
    countLabel.setAttribute('aria-live', 'polite');
    for (const child of header?.children || []) {
      if (child === cancelButton || child === countLabel) continue;
      headerBackup.set(child, { hidden: child.hidden, display: child.style.display });
    }
    cancelButton.addEventListener('click', exit, { signal });

    function rows() {
      return [...chat.querySelectorAll(ROW_SELECTOR)].filter(canSelect);
    }
    function canSelect(row) {
      return row && SEQUENCE(row) !== null && !row.querySelector('.failed-send');
    }
    function setRowVisual(row) {
      const seq = SEQUENCE(row);
      const active = seq !== null && selected.has(seq);
      row.classList.toggle('message-selected', active);
      const check = row.querySelector(':scope > .message-select-check');
      if (check) {
        check.hidden = !selecting;
        check.setAttribute('aria-pressed', String(active));
        check.setAttribute('aria-label', t(active ? 'Deselect message' : 'Select message'));
      }
    }
    function ensureCheck(row) {
      let check = row.querySelector(':scope > .message-select-check');
      if (!check) {
        check = document.createElement('button');
        check.type = 'button';
        check.className = 'message-select-check';
        check.dataset.i18nAttrs = 'aria-label';
        row.prepend(check);
      }
      return check;
    }
    function render() {
      const currentRows = rows();
      for (const button of dock.querySelectorAll('[data-ms-action]')) {
        button.disabled = button.dataset.msAction !== 'exit' && (pendingLoad || selected.size === 0);
      }
      dock.hidden = !selecting;
      chat.classList.toggle('message-selection-mode', selecting);
      inputZone.classList.toggle('message-selection-mode', selecting && currentRows.length > 0);
      // WeChat replaces the header text/actions only during multi-select.
      if (header) {
        header.classList.toggle('is-message-selection', selecting);
        for (const [child, was] of headerBackup) {
          if (!child.isConnected) continue;
          child.hidden = selecting || was.hidden;
          child.style.display = selecting ? 'none' : was.display;
        }
        cancelButton.hidden = !selecting;
        countLabel.hidden = !selecting;
        countLabel.textContent = t('Selected {0} messages', selected.size);
      }
      for (const row of currentRows) {
        if (selecting) ensureCheck(row);
        setRowVisual(row);
      }
      dock.setAttribute('aria-label', t('Selected messages'));
    }
    function exit() {
      cancelDrag();
      closeMenu();
      if (!selecting && !selected.size) return;
      selecting = false;
      selected.clear();
      render();
    }
    function sequenceTarget(event) {
      const row = event.target.closest?.(ROW_SELECTOR);
      return canSelect(row) && chat.contains(row) ? row : null;
    }
    function toggleRow(row) {
      const seq = SEQUENCE(row);
      if (seq === null) return;
      if (selected.has(seq)) selected.delete(seq); else selected.add(seq);
      render();
    }
    function blocked() {
      if (pendingLoad) return true;
      const session = getSessionId();
      if (!session) return true;
      return Boolean(getBusy?.());
    }
    function closeMenu() {
      menu?.remove();
      menu = null;
    }
    function showMenu(row, x, y) {
      closeMenu();
      menu = document.createElement('div');
      menu.className = 'message-context-menu';
      menu.setAttribute('role', 'menu');
      const add = (action, label, icon, danger = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.selectionAction = action;
        button.className = danger ? 'danger' : '';
        button.setAttribute('role', 'menuitem');
        button.innerHTML = icon + '<span>' + label + '</span>';
        button.addEventListener('click', () => {
          closeMenu();
          const seq = SEQUENCE(row);
          if (!chat.contains(row) || !canSelect(row)) return;
          if (action === 'copy') {
            void copy(new Set([seq]));
          } else if (action === 'delete') {
            void removeSelection([seq]);
          } else if (action === 'select') {
            selected.clear();
            selected.add(seq);
            selecting = true;
            render();
          }
        });
        menu.append(button);
      };
      add('copy', t('Copy'), '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>');
      add('select', t('Select'), '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 12h16M4 17h16"/><path d="m16.5 9.5 2 2-2 2"/></svg>');
      add('delete', t('Delete'), '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>', true);
      document.body.append(menu);
      const box = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - box.width - 8, x - box.width / 2));
      const top = Math.max(8, Math.min(innerHeight - box.height - 8, y - box.height - 12));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      menu.querySelector('button')?.focus({ preventScroll: true });
    }
    function textAtPoint({ target, clientX, clientY }) {
      const node = document.caretPositionFromPoint?.(clientX, clientY)?.offsetNode
        ?? document.caretRangeFromPoint?.(clientX, clientY)?.startContainer;
      if (node?.nodeType !== Node.TEXT_NODE || !target.contains(node) || !node.textContent.trim()) return false;
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].some(rect => clientX >= rect.left && clientX < rect.right
        && clientY >= rect.top && clientY < rect.bottom);
    }
    function begin(event) {
      if (drag || event.button !== 0 || event.isPrimary === false || event.target.closest?.(INTERACTIVE)) return;
      const row = sequenceTarget(event);
      const mouse = event.pointerType === 'mouse';
      if (mouse ? event.buttons !== 1 : !row || selecting) return;
      const nativeSelection = mouse && (Boolean(event.target.closest?.(MESSAGE_CONTENT)) || textAtPoint(event));
      drag = { id: event.pointerId, mouse, x: event.clientX, y: event.clientY,
        nativeSelection, moved: false };
      if (!selecting && row && !nativeSelection) {
        longPressTimer = setTimeout(() => {
          suppressClick = true;
          showMenu(row, event.clientX, event.clientY);
        }, 420);
      }
    }
    function stopDrag() {
      if (!drag) return;
      const { id } = drag;
      drag = null;
      clearTimeout(longPressTimer);
      marquee.hidden = true;
      chatScroll.classList.remove('message-selection-dragging');
      if (chatScroll.hasPointerCapture(id)) chatScroll.releasePointerCapture(id);
    }
    function cancelDrag() {
      if (!drag) return;
      if (drag.mouse && !drag.nativeSelection) closeMenu();
      suppressClick = true;
      stopDrag();
    }
    function mouseDown(event) {
      if (event.button === 0 || !(event.buttons & 1)) canceledMouseDrag = false;
      if (event.button !== 0 && drag?.mouse && !drag.nativeSelection) {
        canceledMouseDrag = true;
        cancelDrag();
      }
      if (canceledMouseDrag) event.preventDefault();
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.mouse && !drag.nativeSelection && (event.buttons !== 1 || event.button > 0)) {
        canceledMouseDrag = Boolean(event.buttons & ~1);
        if (canceledMouseDrag) event.preventDefault();
        cancelDrag();
        return;
      }
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        drag.moved = true;
        suppressClick = true;
        clearTimeout(longPressTimer);
        if (!drag.mouse || drag.nativeSelection) return;
        closeMenu();
        chatScroll.setPointerCapture(event.pointerId);
        chatScroll.classList.add('message-selection-dragging');
      }
      if (!drag.mouse || drag.nativeSelection) return;
      const bounds = chatScroll.getBoundingClientRect();
      const endX = Math.max(bounds.left, Math.min(bounds.right, event.clientX));
      const endY = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY));
      marquee.style.left = Math.min(drag.x, endX) + 'px';
      marquee.style.top = Math.min(drag.y, endY) + 'px';
      marquee.style.width = Math.max(1, Math.abs(endX - drag.x)) + 'px';
      marquee.style.height = Math.max(1, Math.abs(endY - drag.y)) + 'px';
      marquee.hidden = false;
      event.preventDefault();
    }
    function end(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const finished = drag;
      stopDrag();
      if (finished.moved || (finished.nativeSelection && window.getSelection()?.type === 'Range')) suppressClick = true;
      if (!finished.mouse || finished.nativeSelection || !finished.moved || event.button !== 0) return;
      const { clientY } = event;
      const bounds = chatScroll.getBoundingClientRect();
      if (clientY < bounds.top || clientY >= bounds.bottom) return;
      const top = Math.max(bounds.top, Math.min(finished.y, clientY));
      const bottom = Math.min(bounds.bottom, Math.max(finished.y, clientY));
      const hits = [];
      let hitAtRelease = false;
      for (const row of rows()) {
        const rect = row.getBoundingClientRect();
        if (rect.height <= 0 || rect.bottom <= top || rect.top > bottom) continue;
        hits.push(SEQUENCE(row));
        if (clientY >= rect.top && clientY < rect.bottom) hitAtRelease = true;
      }
      if (!hitAtRelease) return;
      for (const seq of hits) selected.add(seq);
      selecting = true;
      render();
    }
    function cancel(event) {
      if (drag && event.pointerId === drag.id) cancelDrag();
    }
    function selectedRows(seqs) {
      return rows().filter(row => seqs.has(SEQUENCE(row)))
        .sort((a, b) => SEQUENCE(a) - SEQUENCE(b));
    }
    async function copy(seqs = selected) {
      const count = seqs.size;
      const text = selectedRows(seqs).map(row => {
        const time = row.querySelector('.message-actions time, .turn-actions time')?.textContent?.trim();
        const body = row.classList.contains('msg-user')
          ? row.querySelector('.bubble')?.innerText || row.querySelector('.attchips')?.innerText || ''
          : row.querySelector('.turn-body')?.innerText || '';
        return (time ? '[' + time + '] ' : '') + body.trim();
      }).filter(Boolean).join('\n\n');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        setStatus?.(t('Copied {0} messages', count));
      } catch { setStatus?.(t('Could not copy the selected messages')); }
    }
    async function exportSelection() {
      if (blocked()) { setStatus?.(getBlockedReason?.() || t('Wait for this conversation to finish')); return; }
      const seqs = [...selected].sort((a, b) => a - b);
      pendingLoad = true; render();
      try {
        const result = await window.dshDesktop.conversationExportMessages({
          engine: document.body.dataset.harness,
          sessionId: getSessionId(), seqs,
        });
        if (!result?.ok) throw new Error(result?.error || t('Could not export the selected messages'));
        if (!result.canceled) setStatus?.(t('Exported {0} messages', result.count || seqs.length));
      } catch (error) { setStatus?.(error.message); }
      finally { pendingLoad = false; render(); }
    }
    async function removeSelection(seqs = [...selected].sort((a, b) => a - b)) {
      if (blocked()) { setStatus?.(getBlockedReason?.() || t('Wait for this conversation to finish')); return; }
      if (!seqs.length) return;
      const sessionId = getSessionId();
      const reason = getBlockedReason?.();
      if (reason) { setStatus?.(reason); return; }
      if (!window.confirm(t('Delete {0} selected messages from this conversation? Files and workspace content are kept.', seqs.length))) return;
      pendingLoad = true; render();
      try {
        const result = await window.dshDesktop.conversationCommand({ engine: document.body.dataset.harness,
          action: 'delete-messages', payload: { sessionId, seqs } });
        if (!result?.ok) throw new Error(result?.error || t('Could not delete the selected messages'));
        if (getSessionId() !== sessionId) return;
        exit();
        await reload?.();
        setStatus?.(t('Deleted {0} messages', result.deleted || seqs.length));
      } catch (error) { setStatus?.(error.message); }
      finally { pendingLoad = false; render(); }
    }
    function keydown(event) {
      if (event.key !== 'Escape' || (!selecting && marquee.hidden && !menu)) return;
      event.preventDefault();
      exit();
    }
    dock.addEventListener('click', event => {
      const name = event.target.closest('[data-ms-action]')?.dataset.msAction;
      if (name === 'copy') void copy();
      else if (name === 'export') void exportSelection();
      else if (name === 'delete') void removeSelection();
      else if (name === 'exit') exit();
    }, { signal });
    chatScroll.addEventListener('pointerdown', begin, { signal });
    window.addEventListener('pointermove', move, { capture: true, passive: false, signal });
    window.addEventListener('pointerup', end, { capture: true, signal });
    window.addEventListener('pointercancel', cancel, { capture: true, signal });
    window.addEventListener('mousedown', mouseDown, { capture: true, signal });
    window.addEventListener('blur', cancelDrag, { signal });
    chatScroll.addEventListener('lostpointercapture', cancel, { signal });
    chatScroll.addEventListener('dragstart', event => event.preventDefault(), { signal });
    chatScroll.addEventListener('selectstart', event => {
      if (drag?.mouse && !drag.nativeSelection) event.preventDefault();
    }, { signal });
    function suppressChording(event) {
      if (!canceledMouseDrag) return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener('contextmenu', suppressChording, { capture: true, signal });
    window.addEventListener('auxclick', suppressChording, { capture: true, signal });
    window.addEventListener('mouseup', event => {
      if (event.button !== 0) suppressChording(event);
    }, { capture: true, signal });
    chatScroll.addEventListener('contextmenu', event => {
      event.preventDefault();
      const row = sequenceTarget(event);
      if (row && !selecting) showMenu(row, event.clientX, event.clientY);
    }, { signal });
    // Mobile WeChat keeps the long-press menu for copy/select/delete. A
    // click elsewhere dismisses it without changing the transcript.
    document.addEventListener('pointerdown', event => {
      if (event.button === 0 && event.isPrimary) suppressClick = false;
      if (menu && !menu.contains(event.target)) closeMenu();
    }, { capture: true, signal });
    chatScroll.addEventListener('click', event => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!selecting) return;
      const control = event.target.closest(INTERACTIVE);
      if (control && !control.classList.contains('message-select-check')) return;
      const row = sequenceTarget(event);
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
    }, { capture: true, signal });
    const observer = new MutationObserver(() => {
      if (selecting) render();
    });
    observer.observe(chat, { childList: true, subtree: false });
    document.addEventListener('keydown', keydown, { signal });
    render();
    return {
      refresh: render,
      exit,
      isSelecting: () => selecting,
      selectedSeqs: () => [...selected].sort((a, b) => a - b),
      destroy() {
        exit();
        listeners.abort();
        observer.disconnect();
        for (const row of rows()) row.querySelector(':scope > .message-select-check')?.remove();
        dock.remove();
        marquee.remove();
        cancelButton.remove();
        countLabel.remove();
      },
    };
  }
  return { create };
})();
