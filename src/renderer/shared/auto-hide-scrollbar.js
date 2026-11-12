'use strict';

// Native scrollbars keep their scrolling and drag behavior, but their thumbs
// step out of the way once a list has been idle for a moment. Scrolling brings
// a thumb back, and so does reaching for its gutter, so the handle stays
// discoverable.
window.CamelliaAutoHideScrollbar = (() => {
  const IDLE_DELAY = 900;
  const GUTTER_REACH = 20;

  function attach(element, options = {}) {
    if (!element) return null;
    const delay = Number.isFinite(options.delay) ? options.delay : IDLE_DELAY;
    let idleTimer = 0;
    let nearGutter = false;

    const hide = () => {
      if (!nearGutter) element.classList.add('is-scroll-idle');
    };
    const scheduleIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(hide, delay);
    };
    const reveal = () => {
      element.classList.remove('is-scroll-idle');
      scheduleIdle();
    };
    const trackGutter = event => {
      nearGutter = event.clientX >= element.getBoundingClientRect().right - GUTTER_REACH;
      if (nearGutter) reveal();
      else if (!element.classList.contains('is-scroll-idle')) scheduleIdle();
    };
    const leave = () => {
      nearGutter = false;
      scheduleIdle();
    };

    element.classList.add('is-scroll-idle');
    element.addEventListener('scroll', reveal, { passive: true });
    element.addEventListener('pointermove', trackGutter, { passive: true });
    element.addEventListener('pointerleave', leave);

    return {
      reveal,
      destroy() {
        clearTimeout(idleTimer);
        element.removeEventListener('scroll', reveal);
        element.removeEventListener('pointermove', trackGutter);
        element.removeEventListener('pointerleave', leave);
        element.classList.remove('is-scroll-idle');
      },
    };
  }

  function init() {
    document.querySelectorAll('.session-list').forEach(element => attach(element));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  return { attach };
})();
