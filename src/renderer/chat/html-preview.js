'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaHtmlPreview = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const escape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

  function sourceDocument(file, interactive = true) {
    let base = '';
    try {
      const url = new URL(file.url);
      if (url.protocol === 'file:' && !url.host) base = url.href;
    } catch {}
    const policy = "default-src 'none'; " +
      "img-src data: blob: file:; media-src data: blob: file:; style-src 'unsafe-inline' file:; font-src data: file:; " +
      (interactive ? "script-src 'unsafe-inline'; " : "script-src 'none'; ") +
      "connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri file:";
    return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape(policy) + '">' +
      '<meta name="referrer" content="no-referrer">' + (base ? '<base href="' + escape(base) + '">' : '') + (file.text || '');
  }

  function render(file) {
    const chinese = document.documentElement.lang.toLowerCase().startsWith('zh');
    const text = (zh, en) => chinese ? zh : en;
    const stage = document.createElement('section'); stage.className = 'html-preview-stage';
    const toolbar = document.createElement('div'); toolbar.className = 'html-preview-toolbar';
    const label = document.createElement('label'); label.textContent = text('显示方式', 'View');
    const select = document.createElement('select'); select.setAttribute('aria-label', label.textContent);
    select.append(new Option(text('交互预览', 'Interactive preview'), 'interactive'), new Option(text('静态预览', 'Static preview'), 'static'), new Option(text('源码', 'Source'), 'source'));
    label.append(select);
    const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = text('重新加载', 'Reload');
    toolbar.append(label, reload);
    const notice = document.createElement('p'); notice.className = 'html-preview-notice';
    notice.textContent = text('隔离预览：支持内嵌脚本；不提供应用权限，禁止接口请求和外部脚本。', 'Isolated preview: inline scripts are supported. No app privileges, API requests or external scripts.');
    const content = document.createElement('div'); content.className = 'html-preview-content';
    stage.append(toolbar, notice, content);
    function show() {
      content.replaceChildren();
      reload.disabled = select.value === 'source';
      if (select.value === 'source') {
        const source = document.createElement('pre'); source.className = 'file-preview-text'; source.textContent = file.text || '';
        content.append(source);
        return;
      }
      const frame = document.createElement('iframe'); frame.title = file.name;
      frame.className = 'file-preview-html'; frame.setAttribute('sandbox', select.value === 'interactive' ? 'allow-scripts' : '');
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'");
      frame.referrerPolicy = 'no-referrer';
      frame.srcdoc = sourceDocument(file, select.value === 'interactive');
      content.append(frame);
    }
    select.onchange = show; reload.onclick = show; show();
    return stage;
  }
  return { sourceDocument, render };
});
