'use strict';

// Native title bubbles are inconsistent across platforms and do not belong to
// Camellia's visual language. Titles are held only while the pointer is over
// their element, and a hint that merely repeats visible content is suppressed.
window.CamelliaTooltip = (() => {
  const TITLE_SELECTOR = '[title]';
  const TARGET_SELECTOR = TITLE_SELECTOR + ',[data-tooltip]';
  const SHOW_DELAY = 320;
  const GAP = 8;
  const EDGE = 8;
  const heldTitles = new WeakMap();
  const contentProviders = new WeakMap();
  let node = null;
  let active = null;
  let pending = null;
  let timer = 0;
  let popoverSupported = false;
  let enabled = true;
  try { enabled = localStorage.getItem('camellia-hover-hints') !== 'off'; } catch { /* use the default */ }

  function setEnabled(value) {
    enabled = value !== false;
    try { localStorage.setItem('camellia-hover-hints', enabled ? 'on' : 'off'); } catch { /* optional cache */ }
    if (!enabled) hide();
  }

  function ensureNode() {
    if (node?.isConnected) return node;
    node = document.createElement('div');
    node.id = 'camelliaTooltip';
    node.className = 'camellia-tooltip';
    node.setAttribute('role', 'tooltip');
    node.setAttribute('aria-hidden', 'true');
    popoverSupported = typeof node.showPopover === 'function';
    if (popoverSupported) node.setAttribute('popover', 'manual');
    document.body.append(node);
    return node;
  }

  function openLayer(tooltip) {
    if (!popoverSupported) return;
    try {
      if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    } catch {
      // The fallback is already in the document and remains usable.
    }
  }

  function closeLayer(tooltip) {
    if (!popoverSupported) return;
    try {
      if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    } catch {
      // Chromium may close an owned popover during window teardown.
    }
  }

  function hintText(target) {
    return (target.getAttribute('title') || target.getAttribute('data-tooltip') || '').trim();
  }

  function normalized(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isRedundantHint(target) {
    if (contentProviders.has(target)) return false;
    const selected = target instanceof HTMLSelectElement ? target.selectedOptions?.[0]?.textContent : '';
    const value = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : '';
    const text = target.innerText != null ? target.innerText : target.textContent;
    const visible = normalized(selected || value || text);
    return Boolean(visible) && visible === normalized(hintText(target));
  }

  function fillContent(target, tooltip) {
    const provider = contentProviders.get(target);
    tooltip.classList.toggle('is-rich', Boolean(provider));
    if (provider) {
      const content = provider(target);
      if (content instanceof Node) tooltip.replaceChildren(content);
      else tooltip.textContent = content == null ? '' : String(content);
      return Boolean(tooltip.firstChild || tooltip.textContent);
    }
    const text = hintText(target);
    if (!text) return false;
    tooltip.textContent = text;
    return true;
  }

  function bind(target, provider) {
    if (!(target instanceof Element) || typeof provider !== 'function') return target;
    contentProviders.set(target, provider);
    if (!target.matches(TARGET_SELECTOR)) target.setAttribute('data-tooltip', '');
    return target;
  }

  function translatedTitle(record) {
    if (!record.translatable || !window.CamelliaI18n?.t) return record.title;
    return window.CamelliaI18n.t(record.title);
  }

  function holdTitle(target) {
    if (heldTitles.has(target)) return;
    const title = target.getAttribute('title');
    if (!title?.trim()) return;
    const bindings = target.getAttribute('data-i18n-attrs') || '';
    heldTitles.set(target, {
      title,
      translatable: bindings.split(/\s+/).includes('title'),
    });
    target.setAttribute('data-tooltip', title);
    target.removeAttribute('title');
  }

  function releaseTitle(target) {
    const record = heldTitles.get(target);
    if (!record) return;
    heldTitles.delete(target);
    if (!target.hasAttribute('title')) target.setAttribute('title', translatedTitle(record));
  }

  function targetFrom(value) {
    let element = value instanceof Element ? value : null;
    while (element) {
      if (element instanceof HTMLIFrameElement && !element.hasAttribute('data-tooltip') && !contentProviders.has(element)) {
        element = element.parentElement;
        continue;
      }
      const title = (element.getAttribute('title') || '').trim();
      const hint = (element.getAttribute('data-tooltip') || '').trim();
      if (title || hint || contentProviders.has(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function position(target, tooltip) {
    const host = target.getBoundingClientRect();
    if (!host.width && !host.height) return false;
    const box = tooltip.getBoundingClientRect();
    const preferred = target.getAttribute('data-tooltip-placement');
    const below = host.bottom + GAP + box.height <= innerHeight - EDGE;
    const above = host.top - GAP - box.height >= EDGE;
    const right = innerWidth - host.right - GAP - box.width >= EDGE;
    const left = host.left - GAP - box.width >= EDGE;
    let placement = ['top', 'bottom', 'left', 'right'].includes(preferred) ? preferred : 'bottom';
    if (placement === 'right' && !right) placement = left ? 'left' : below ? 'bottom' : 'top';
    if (placement === 'left' && !left) placement = right ? 'right' : below ? 'bottom' : 'top';
    if (placement === 'bottom' && !below && above) placement = 'top';
    if (placement === 'top' && !above && below) placement = 'bottom';
    let top = placement === 'top' ? host.top - box.height - GAP
      : placement === 'bottom' ? host.bottom + GAP
      : host.top + host.height / 2 - box.height / 2;
    top = Math.max(EDGE, Math.min(innerHeight - box.height - EDGE, top));
    const x = placement === 'right' ? host.right + GAP
      : placement === 'left' ? host.left - box.width - GAP
      : host.left + host.width / 2 - box.width / 2;
    const xPos = Math.max(EDGE, Math.min(innerWidth - box.width - EDGE, x));
    tooltip.dataset.placement = placement;
    tooltip.style.left = Math.round(xPos) + 'px';
    tooltip.style.top = Math.round(top) + 'px';
    return true;
  }

  function addDescription(target, tooltip) {
    const previous = target.getAttribute('aria-describedby');
    const tokens = String(previous || '').split(/\s+/).filter(Boolean);
    if (!tokens.includes(tooltip.id)) tokens.push(tooltip.id);
    target.setAttribute('aria-describedby', tokens.join(' '));
    return previous;
  }

  function hide() {
    clearTimeout(timer);
    timer = 0;
    pending = null;
    if (!active) return;
    const { target, tooltip, previousDescription } = active;
    active = null;
    if (previousDescription == null) target.removeAttribute('aria-describedby');
    else target.setAttribute('aria-describedby', previousDescription);
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
    closeLayer(tooltip);
  }

  function show(target) {
    clearTimeout(timer);
    timer = 0;
    pending = null;
    if (!enabled || !target.isConnected || isRedundantHint(target)) {
      hide();
      return;
    }
    if (active?.target === target && active.tooltip.classList.contains('is-visible')) return;
    if (active) hide();
    const tooltip = ensureNode();
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'false');
    if (!fillContent(target, tooltip)) {
      tooltip.setAttribute('aria-hidden', 'true');
      closeLayer(tooltip);
      return;
    }
    openLayer(tooltip);
    if (!position(target, tooltip)) {
      tooltip.setAttribute('aria-hidden', 'true');
      closeLayer(tooltip);
      return;
    }
    const previousDescription = addDescription(target, tooltip);
    active = { target, tooltip, previousDescription };
    void tooltip.offsetWidth;
    tooltip.classList.add('is-visible');
  }

  function queue(target, delay = SHOW_DELAY) {
    if (!enabled || !target?.matches(TARGET_SELECTOR)) return;
    if (active?.target === target) return;
    clearTimeout(timer);
    hide();
    pending = target;
    if (delay <= 0) {
      show(target);
      return;
    }
    timer = setTimeout(() => {
      timer = 0;
      if (pending === target) show(target);
    }, delay);
  }

  document.addEventListener('pointerover', event => {
    const target = targetFrom(event.target);
    if (!target || target.contains(event.relatedTarget)) return;
    holdTitle(target);
    queue(target);
  });
  document.addEventListener('pointerout', event => {
    const target = targetFrom(event.target);
    if (!target || target.contains(event.relatedTarget)) return;
    if (active?.target === target || pending === target) hide();
    releaseTitle(target);
  });
  document.addEventListener('focusin', event => {
    const target = targetFrom(event.target);
    if (target?.matches(':focus-visible')) queue(target, 0);
  });
  document.addEventListener('focusout', event => {
    const target = targetFrom(event.target);
    if (target && !target.contains(event.relatedTarget) && active?.target === target) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('click', hide, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  window.addEventListener('camellia:language', hide);
  window.dshDesktop?.onHoverHintsChanged?.(setEnabled);
  void window.dshDesktop?.workbenchSettings?.().then(settings => {
    if (settings?.ok && Object.prototype.hasOwnProperty.call(settings, 'showHoverHints')) {
      setEnabled(settings.showHoverHints !== false);
    }
  }).catch(() => {});
  new MutationObserver(() => {
    if (active && !active.target.isConnected) hide();
  }).observe(document.documentElement, { childList: true, subtree: true });

  return { bind, hide, setEnabled };
})();
