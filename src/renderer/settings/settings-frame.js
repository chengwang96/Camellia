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
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    // Escape belongs to a nested dialog, popover or field being edited first.
    if (document.querySelector('dialog[open], [popover]:popover-open, select:open')
      || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    void api.closeSettingsWindow();
  });
})();
