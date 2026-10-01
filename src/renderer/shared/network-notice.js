'use strict';

// In-app advisory shown when the selected system proxy stopped working and
// Camellia downgraded to "auto". Rendered as the same <dialog> used by
// the settings surfaces so it matches the product instead of a native alert.
// Copy is translated through the shared catalogue when the page loads it.
window.CamelliaNetworkNotice = (() => {
  const COPY = {
    title: { en: 'System proxy unavailable', zh: '系统代理不可用' },
    body: { en: 'The system proxy you selected can no longer reach the internet, so every request through it would fail. Camellia switched to “Auto”: direct connections are tried first and the proxy is kept only as a fallback.',
      zh: '你选择的系统代理已无法访问网络，经它发出的请求都会失败。Camellia 已自动切换为「自动」：优先直连，代理仅作回退。' },
    mode: { en: 'Connection mode: Auto', zh: '连接方式：自动' },
    proxy: { en: 'Proxy', zh: '代理' },
    next: { en: 'Check the proxy service and your system proxy settings as soon as possible. Once it works again, switch back to “Use system proxy” in Settings → Network.',
      zh: '请尽快排查代理服务与系统代理设置。恢复后可在 设置 → 网络 中切回「系统代理」。' },
    open: { en: 'Open network settings', zh: '打开网络设置' },
    close: { en: 'Got it', zh: '知道了' },
  };
  const t = key => {
    const entry = COPY[key];
    if (!entry) return key;
    if (window.CamelliaI18n && typeof window.CamelliaI18n.t === 'function') {
      const translated = window.CamelliaI18n.t(entry.en);
      if (translated && translated !== entry.en) return translated;
    }
    return (document.documentElement.lang || 'en').startsWith('zh') ? entry.zh : entry.en;
  };
  let dialog = null, pending = null, proxyUrl = '', lastShown = null;
  // Re-render the labels when the language changes, so an open notice follows
  // the rest of the UI instead of keeping the previous language.
  window.addEventListener('camellia:language', () => { if (dialog) renderText(); });
  function renderText() {
    dialog.querySelector('h2').textContent = t('title');
    dialog.querySelector('#networkNoticeBody').textContent = t('body');
    dialog.querySelector('#networkNoticeMode').textContent = t('mode');
    dialog.querySelector('#networkNoticeProxy').textContent = proxyUrl ? `${t('proxy')}: ${proxyUrl}` : '';
    dialog.querySelector('#networkNoticeProxy').hidden = !proxyUrl;
    dialog.querySelector('#networkNoticeNext').textContent = t('next');
    dialog.querySelector('#networkNoticeOpen').textContent = t('open');
    dialog.querySelector('#networkNoticeClose').textContent = t('close');
  }
  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'network-notice';
    dialog.setAttribute('role', 'alertdialog');
    dialog.innerHTML = `
      <div class="notice-head">
        <span class="notice-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 8v5m0 3.5v.01"/><circle cx="12" cy="12" r="9"/></svg></span>
        <h2></h2>
        <button type="button" aria-label="Close">×</button>
      </div>
      <p id="networkNoticeBody"></p>
      <p class="notice-mode" id="networkNoticeMode"></p>
      <p id="networkNoticeProxy"></p>
      <p id="networkNoticeNext"></p>
      <div class="notice-actions">
        <button type="button" id="networkNoticeOpen"></button>
        <button type="button" class="primary" id="networkNoticeClose"></button>
      </div>`;
    // All copy is placed as text, so a proxy address from the main process can
    // never be interpreted as markup.
    renderText();
    dialog.querySelector('button[aria-label="Close"]').onclick = () => dialog.close();
    dialog.querySelector('#networkNoticeClose').onclick = () => dialog.close();
    dialog.querySelector('#networkNoticeOpen').onclick = () => {
      dialog.close();
      if (window.dshDesktop && window.dshDesktop.openSettingsWindow) void window.dshDesktop.openSettingsWindow({ page: 'network', focus: 'networkMode' });
    };
    document.body.appendChild(dialog);
  }
  // One message at a time; a second notice waits until the first is dismissed.
  const proxyKey = payload => String(payload?.proxy || '');
  // Pages call sync() with every health update: a broken proxy is reported, and
  // a recovered one clears the memory so the next failure is reported again.
  function sync(payload = {}) {
    if (payload.degraded) { show(payload); return; }
    lastShown = null;
    if (dialog && dialog.open) dialog.close();
  }
  function show(payload = {}) {
    if (dialog && dialog.open) { pending = payload; return; }
    // The same broken proxy is reported once per session; a page that reloads
    // its state on every language change must not nag the user again.
    if (lastShown && lastShown === proxyKey(payload)) return;
    if (!dialog) build();
    // Hide the proxy row when the payload has no address, and never let a
    // remote value render as markup.
    proxyUrl = payload.proxy || '';
    lastShown = proxyKey(payload);
    renderText();
    dialog.addEventListener('close', () => {
      if (!pending) return;
      const next = pending; pending = null;
      show(next);
    }, { once: true });
    if (typeof dialog.showModal === 'function') dialog.showModal();
  }
  return { show, sync, t, build, get element() { return dialog; } };
})();
