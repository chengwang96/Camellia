'use strict';

window.CamelliaPanelMotion = (() => {
  const closeTimers = new WeakMap();
  const closeDelay = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;

  function clearCloseTimer(panel) {
    const timer = closeTimers.get(panel);
    if (timer) clearTimeout(timer);
    closeTimers.delete(panel);
  }

  function open(panel) {
    clearCloseTimer(panel);
    const reopening = panel.hidden || panel.classList.contains('is-closing') || !panel.classList.contains('is-open');
    panel.hidden = false;
    panel.classList.remove('is-closing');
    if (!reopening) return;
    panel.classList.remove('is-open');
    void panel.offsetWidth;
    if (!panel.hidden && !panel.classList.contains('is-closing')) panel.classList.add('is-open');
  }

  function close(panel) {
    clearCloseTimer(panel);
    if (panel.hidden) {
      panel.classList.remove('is-open', 'is-closing');
      return;
    }
    panel.classList.remove('is-open');
    panel.classList.add('is-closing');
    const delay = closeDelay();
    if (!delay) {
      panel.hidden = true;
      panel.classList.remove('is-closing');
      return;
    }
    closeTimers.set(panel, setTimeout(() => {
      panel.hidden = true;
      panel.classList.remove('is-closing');
      closeTimers.delete(panel);
    }, delay));
  }

  function isOpen(panel) {
    return !panel.hidden && !panel.classList.contains('is-closing');
  }

  return { open, close, isOpen };
})();
