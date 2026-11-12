'use strict';

// Only the desktop settings window owns window controls. Browser settings and
// embedded engine panels keep their existing host's controls.
(() => {
  const api = window.dshDesktop;
  if (api?.settingsWindow !== true) return;
  document.documentElement.dataset.settingsWindow = '';
  const close = document.getElementById('closeSettings');
  close.hidden = false;
  close.addEventListener('click', () => { void api.closeSettingsWindow(); });
  // A modal dialog makes the rest of the document inert, including the
  // window-level close control. Keep that control working as the native
  // window close button would by recognizing clicks that land on its area
  // through the dialog backdrop. Clicks inside the dialog still belong to it.
  document.addEventListener('click', event => {
    if (event.button !== 0) return;
    const modal = document.querySelector('dialog:modal');
    if (!modal) return;
    const closeRect = close.getBoundingClientRect();
    const dialogRect = modal.getBoundingClientRect();
    const inClose = event.clientX >= closeRect.left && event.clientX <= closeRect.right
      && event.clientY >= closeRect.top && event.clientY <= closeRect.bottom;
    const inDialog = event.clientX >= dialogRect.left && event.clientX <= dialogRect.right
      && event.clientY >= dialogRect.top && event.clientY <= dialogRect.bottom;
    if (!inClose || inDialog) return;
    event.preventDefault();
    event.stopPropagation();
    void api.closeSettingsWindow();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    // Escape belongs to a nested dialog, popover or field being edited first.
    if (document.querySelector('dialog[open], [popover]:popover-open, select:open')
      || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    void api.closeSettingsWindow();
  });
})();
