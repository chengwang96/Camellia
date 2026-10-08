'use strict';

// Only explicitly marked UI labels are translated. Message bodies, editable
// values, model IDs and user-chosen names never enter this binding layer.
window.CamelliaI18n = (() => {
  const { normalizeLanguage, translate } = window.CamelliaLocale;
  let language = 'en';
  const textSources = new WeakMap(), attributeSources = new WeakMap();
  const selector = '[data-i18n], [data-i18n-attrs]';
  const roots = new Set([document]);
  function translated(source, previous) {
    const original = previous && previous.rendered === source ? previous.original : source;
    return { original, rendered: translate(original, language) };
  }
  function apply(element) {
    if (element.closest('[translate="no"]')) return;
    if (element.hasAttribute('data-i18n') && !element.matches('textarea, input, script, style')) {
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const record = translated(node.textContent, textSources.get(node));
        textSources.set(node, record);
        if (node.textContent !== record.rendered) node.textContent = record.rendered;
      }
    }
    const attributes = element.dataset.i18nAttrs;
    if (attributes) {
      const sources = attributeSources.get(element) || {};
      for (const name of attributes.split(' ')) {
        if (!element.hasAttribute(name)) continue;
        const record = translated(element.getAttribute(name), sources[name]);
        sources[name] = record;
        if (element.getAttribute(name) !== record.rendered) element.setAttribute(name, record.rendered);
      }
      attributeSources.set(element, sources);
    }
  }
  function scan(root) {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) apply(root);
    root.querySelectorAll(selector).forEach(apply);
  }
  function setLanguage(value) {
    language = normalizeLanguage(value);
    document.documentElement.lang = language;
    roots.forEach(scan);
    window.dispatchEvent(new CustomEvent('camellia:language', { detail: { language } }));
  }
  // Translate new menus and status updates without rebuilding forms or chats.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const element = record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target;
      if (element?.matches(selector)) apply(element);
      for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(node);
    }
  });
  function observe(root) {
    roots.add(root);
    observer.observe(root === document ? document.documentElement : root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['title', 'placeholder', 'aria-label', 'data-i18n', 'data-i18n-attrs'] });
    scan(root);
  }
  observe(document);
  window.dshDesktop.onLanguageChanged(setLanguage);
  const ready = window.dshDesktop.workbenchSettings().then(preferences => {
    if (preferences.ok) setLanguage(preferences.language);
  }).catch(() => {
    // Keep the default language usable when preferences cannot be read.
  }).finally(() => {
    document.documentElement.removeAttribute('data-i18n-pending');
  });
  return { ready, setLanguage, observe, t: text => translate(text, language),
    get language() { return language; }, get locale() { return language === 'en' ? 'en-US' : 'zh-CN'; } };
})();
