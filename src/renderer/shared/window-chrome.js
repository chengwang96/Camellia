'use strict';

// Browser/server pages and embedded native views retain their own frame.
(() => {
  const desktop = window.dshDesktop;
  if (typeof desktop?.onSettingsOverlay === 'function' && typeof desktop?.settingsOverlay === 'function') {
    let backdrop, receivedUpdate = false;
    const dimWorkbench = visible => {
      if (!backdrop && visible === true) {
        backdrop = document.createElement('div'); backdrop.className = 'settings-window-backdrop';
        backdrop.setAttribute('aria-hidden', 'true'); document.body.appendChild(backdrop);
        backdrop.addEventListener('pointerdown', event => {
          // Keep the release/click on this element if saving closes Settings
          // and hides the backdrop before the pointer is released.
          backdrop.setPointerCapture(event.pointerId);
          event.preventDefault();
          event.stopPropagation();
          void desktop.closeSettingsWindow();
        });
        // Consume the dismissal click without activating workbench controls.
        backdrop.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
      }
      if (backdrop) backdrop.hidden = visible !== true;
    };
    desktop.onSettingsOverlay(visible => { receivedUpdate = true; dimWorkbench(visible); });
    void desktop.settingsOverlay().then(visible => { if (!receivedUpdate) dimWorkbench(visible); });
    // The main process uses this acknowledgement to show Settings only after
    // the backdrop has actually had a frame to paint. No fixed timeout is used.
    window.paintSettingsBackdrop = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  const api = window.camelliaWindowChrome;
  if (!api) return;
  const overlayRoots = new Set([document]);
  const watchedRoots = new WeakSet();
  const maskObservers = new WeakMap();
  let nativeDimmed = false;
  function hasVisibleOverlay(root) {
    for (const dialog of root.querySelectorAll('dialog[open]')) {
      if (dialog.matches(':modal')) return true;
    }
    return Boolean(root.querySelector('.perm-mask.visible, .ws-mask.visible'));
  }
  function syncNativeDim() {
    const visible = [...overlayRoots].some(hasVisibleOverlay);
    if (visible === nativeDimmed) return;
    nativeDimmed = visible;
    try {
      const pending = api.setDimmed?.(visible);
      if (pending?.catch) pending.catch(() => {});
    } catch { /* Browser previews and non-Windows frames have no native caption. */ }
  }
  function watchMask(mask) {
    if (maskObservers.has(mask)) return;
    const observer = new MutationObserver(syncNativeDim);
    observer.observe(mask, { attributes: true, attributeFilter: ['class'] });
    maskObservers.set(mask, observer);
  }
  function watchOverlayRoot(root) {
    if (!root || watchedRoots.has(root)) return;
    watchedRoots.add(root);
    overlayRoots.add(root);
    const observer = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target.matches?.('dialog')) changed = true;
          continue;
        }
        for (const node of record.removedNodes || []) {
          if (node.nodeType === Node.ELEMENT_NODE
            && (node.matches('dialog[open], .perm-mask.visible, .ws-mask.visible')
              || node.querySelector('dialog[open], .perm-mask.visible, .ws-mask.visible'))) changed = true;
        }
        for (const node of record.addedNodes || []) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches('.perm-mask, .ws-mask')) watchMask(node);
          for (const mask of node.querySelectorAll('.perm-mask, .ws-mask')) watchMask(mask);
          if (node.matches('dialog[open], .perm-mask.visible, .ws-mask.visible')
            || node.querySelector('dialog[open], .perm-mask.visible, .ws-mask.visible')) changed = true;
        }
      }
      if (changed) syncNativeDim();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    for (const mask of root.querySelectorAll('.perm-mask, .ws-mask')) watchMask(mask);
    syncNativeDim();
  }
  window.CamelliaNativeOverlay = { observe: watchOverlayRoot };
  watchOverlayRoot(document);

  let bar, opening = false, previousFocus = null;
  const leaveMenu = () => { document.activeElement.blur(); previousFocus?.focus(); };
  function apply(state) {
    if (!state.enabled) return;
    const root = document.documentElement;
    root.dataset.desktopChrome = '';
    root.dataset.theme = state.theme;
    root.style.setProperty('--desktop-chrome-height', state.height / state.zoomFactor + 'px');
    root.style.setProperty('--desktop-chrome-zoom', state.zoomFactor);
    if (!bar) {
      bar = document.createElement('nav'); bar.className = 'desktop-titlebar';
      bar.setAttribute('role', 'menubar');
      bar.addEventListener('keydown', event => {
        const buttons = [...bar.children], index = buttons.indexOf(document.activeElement);
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (offset || ['Escape', 'ArrowDown'].includes(event.key)) event.stopPropagation();
        if (offset) { event.preventDefault(); buttons[(index + offset + buttons.length) % buttons.length]?.focus(); }
        if (event.key === 'Escape') { event.preventDefault(); leaveMenu(); }
        if (event.key === 'ArrowDown') { event.preventDefault(); document.activeElement.click(); }
      });
      document.body.prepend(bar);
    }
    bar.hidden = state.height === 0;
    bar.setAttribute('aria-label', state.label);
    // Theme and zoom updates should not replace focused/open menu buttons.
    const signature = JSON.stringify(state.menus);
    if (bar.dataset.menus === signature) return;
    bar.dataset.menus = signature;
    bar.replaceChildren();
    for (const menu of state.menus) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = menu.label; button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', async () => {
        if (opening) return;
        opening = true; button.setAttribute('aria-expanded', 'true');
        const rect = button.getBoundingClientRect();
        try { await api.openMenu({ index: menu.index, x: rect.left, y: rect.bottom }); }
        finally { opening = false; button.setAttribute('aria-expanded', 'false'); }
      });
      bar.appendChild(button);
    }
  }
  api.onState(apply);
  api.onFocus(() => {
    if (!bar || bar.hidden) return;
    if (bar.contains(document.activeElement)) leaveMenu();
    else { previousFocus = document.activeElement; bar.firstElementChild?.focus(); }
  });
  window.addEventListener('resize', () => { void api.getState().then(apply); });
  void api.getState().then(apply);
})();
