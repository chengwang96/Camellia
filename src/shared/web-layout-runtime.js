'use strict';

const { normalizeProfile } = require('./web-providers.js');

function extractionScript(provider, profileValue = null, options = {}) {
  const config = JSON.stringify({
    id: provider.id,
    expectedSessions: options.expectedSessions === true,
    forceSync: options.forceSync === true,
    history: provider.history,
    layout: {
      sidebarSelectors: provider.layout.sidebarSelectors,
      readySelectors: provider.layout.readySelectors,
      promoSelectors: provider.layout.promoSelectors,
      promoText: provider.layout.promoText,
    },
    profile: normalizeProfile(provider, profileValue),
  });
  return `(() => {
    const cfg = ${config};
    const historySelector = cfg.profile?.historyAnchorSelector || cfg.history.anchorSelector;
    const titleSelector = cfg.profile?.titleSelector || cfg.history.titleSelector;
    const clean = value => String(value || '').replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 180);
    const root = document.documentElement;
    const hiddenBeforeMeasure = [...document.querySelectorAll('[data-camellia-web-site-sidebar]')];
    const rootHiddenBeforeMeasure = root.hasAttribute('data-camellia-web-hide-site-sidebar');
    // Provider navigation is hidden from the first frame by the preload boot
    // CSS. It has to be laid out for one measurement pass; the decision below
    // restores the final state synchronously, before the browser paints.
    // Hidden or deleted provider rows still have no usable boxes.
    root.setAttribute('data-camellia-web-site-sidebar-visible', '');
    if (rootHiddenBeforeMeasure) root.removeAttribute('data-camellia-web-hide-site-sidebar');
    hiddenBeforeMeasure.forEach(node => node.removeAttribute('data-camellia-web-site-sidebar'));
    if (rootHiddenBeforeMeasure) void document.body.offsetWidth;
    let anchors = [];
    try {
      anchors = [...document.querySelectorAll(historySelector)].filter(anchor => {
        const rect = anchor.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        for (let node = anchor; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden'
            || style.opacity === '0' || style.contentVisibility === 'hidden') return false;
        }
        return true;
      });
    } catch (error) {
      anchors = [];
    }
    if (rootHiddenBeforeMeasure) root.setAttribute('data-camellia-web-hide-site-sidebar', '');
    const rows = [], seen = new Set();
    for (const anchor of anchors) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      if (url.protocol !== 'https:') continue;
      const titleNode = titleSelector ? anchor.querySelector(titleSelector) : null;
      const title = clean(titleNode?.textContent || anchor.getAttribute('aria-label') || anchor.textContent);
      if (!title) continue;
      const canonical = url.origin + url.pathname;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      rows.push({ url: canonical, title });
    }
    let sidebarMarked = root.hasAttribute('data-camellia-web-hide-site-sidebar');
    const markSidebar = node => {
      if (!node || node === document.body || node === document.documentElement) return;
      node.setAttribute('data-camellia-web-site-sidebar', '');
      sidebarMarked = true;
    };
    if (rows.length) {
      root.setAttribute('data-camellia-web-hide-site-sidebar', '');
      root.removeAttribute('data-camellia-web-site-sidebar-visible');
      root.removeAttribute('data-camellia-web-empty-polls');
      for (const selector of cfg.layout.sidebarSelectors) {
        try { document.querySelectorAll(selector).forEach(markSidebar); } catch {}
      }
      if (!sidebarMarked && anchors.length) {
        let node = anchors[0];
        while (node && node !== document.body) {
          const rect = node.getBoundingClientRect();
          if (rect.left <= 40 && rect.width >= 180 && rect.width <= 380 && rect.height >= innerHeight * 0.45) {
            markSidebar(node);
            break;
          }
          node = node.parentElement;
        }
      }
    } else if (cfg.forceSync
      || /(?:^|[./_-])(?:sign[-_]?in|login|log[-_]?in)(?:[./?#_-]|$)/i.test(location.href)
      || (!cfg.expectedSessions && !root.hasAttribute('data-camellia-web-hide-site-sidebar'))) {
      root.removeAttribute('data-camellia-web-hide-site-sidebar');
      root.setAttribute('data-camellia-web-site-sidebar-visible', '');
      root.removeAttribute('data-camellia-web-empty-polls');
      document.querySelectorAll('[data-camellia-web-site-sidebar]').forEach(node => node.removeAttribute('data-camellia-web-site-sidebar'));
      sidebarMarked = false;
    } else {
      const emptyPolls = Number(root.getAttribute('data-camellia-web-empty-polls') || 0) + 1;
      if (!cfg.expectedSessions && emptyPolls >= 3) {
        root.removeAttribute('data-camellia-web-hide-site-sidebar');
        root.setAttribute('data-camellia-web-site-sidebar-visible', '');
        root.removeAttribute('data-camellia-web-empty-polls');
        document.querySelectorAll('[data-camellia-web-site-sidebar]').forEach(node => node.removeAttribute('data-camellia-web-site-sidebar'));
        sidebarMarked = false;
      } else {
        root.setAttribute('data-camellia-web-empty-polls', String(emptyPolls));
        root.removeAttribute('data-camellia-web-site-sidebar-visible');
        if (cfg.expectedSessions) root.setAttribute('data-camellia-web-hide-site-sidebar', '');
        sidebarMarked = root.hasAttribute('data-camellia-web-hide-site-sidebar');
        for (const selector of cfg.layout.sidebarSelectors) {
          try { document.querySelectorAll(selector).forEach(markSidebar); } catch {}
        }
      }
    }
    let hiddenCount = 0;
    const hiddenNodes = new Set();
    const hide = node => {
      if (!node || node === document.body || node === document.documentElement) return;
      node.setAttribute('data-camellia-web-hidden', '');
      hiddenNodes.add(node);
    };
    for (const selector of cfg.layout.promoSelectors) {
      try { document.querySelectorAll(selector).forEach(hide); } catch {}
    }
    const promoText = cfg.layout.promoText || [];
    const candidates = document.querySelectorAll([
      'a', 'button', '[role="button"]', '[role="menuitem"]',
      '[class*="download"]', '[class*="sub-item"]', '[class*="nav-item"]',
      '[class*="menu-item"]', '[class*="promo"]', '[class*="upgrade"]',
      '[class*="membership"]',
    ].join(','));
    for (const node of candidates) {
      const text = clean([
        node.textContent,
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
      ].filter(Boolean).join(' '));
      if (!text || text.length > 80 || !promoText.some(item => text.includes(item))) continue;
      const chrome = node.closest([
        'aside', '.sidebar', '.next-sidebar', '[class*="sidebar"]',
        '[class*="user-area"]', '[class*="user-nav"]', '[class*="footer"]',
        '[class*="header"]', '[class*="nav"]', '[role="menu"]',
        '[class*="download"]', '[class*="sub-item"]', '[class*="menu-item"]',
        '[class*="promo"]', '[class*="membership"]', '[class*="upgrade"]',
        '[class*="banner"]',
      ].join(','));
      const href = node.getAttribute('href') || '';
      const promotionalLink = /\\/membership\\b|\\/download\\b|desktop[-_]?app|app[-_]?download|apps\\.apple|google\\.com\\/store/i.test(href);
      if (!chrome && !promotionalLink) continue;
      const container = node.closest('.desktop-download-entry, [class*="download-entry"]')
        || node.closest('[class*="menu-item"], [class*="sub-item"], [role="menuitem"], [class*="card"], [class*="banner"], [class*="promo"]')
        || node;
      hide(container);
    }
    hiddenCount = hiddenNodes.size;
    let pageReady = false;
    for (const selector of cfg.layout.readySelectors || []) {
      try {
        if ([...document.querySelectorAll(selector)].some(node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 1 && rect.height > 1 && style.display !== 'none'
            && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        })) {
          pageReady = true;
          break;
        }
      } catch {}
    }
    root.setAttribute('data-camellia-web-ready', '');
    return {
      url: location.href,
      title: clean(document.title),
      sessions: rows,
      layout: { historyCount: rows.length, sidebarMarked, hiddenCount, pageReady },
    };
  })()`;
}

function sessionActionScript(provider, { sessionId, action, value = '', autoConfirm = true }) {
  const labels = provider.sessionActions?.labels?.[action];
  if (!labels?.length) return null;
  const config = JSON.stringify({
    anchorSelector: provider.history.anchorSelector,
    idPattern: provider.history.idPattern,
    moreSelector: provider.sessionActions.moreSelector,
    labels,
    action,
    value: String(value || ''),
    sessionId: String(sessionId || ''),
    autoConfirm: autoConfirm !== false,
  });
  return `(async () => {
    const cfg = ${config};
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = node => Boolean(node && node.getClientRects().length
      && getComputedStyle(node).display !== 'none'
      && getComputedStyle(node).visibility !== 'hidden');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async (find, timeout = 1800) => {
      const started = Date.now();
      do {
        const value = find();
        if (value) return value;
        await sleep(40);
      } while (Date.now() - started < timeout);
      return null;
    };
    try {
      const anchor = [...document.querySelectorAll(cfg.anchorSelector)].find(node => {
        try {
          const match = new RegExp(cfg.idPattern).exec(new URL(node.href, location.href).pathname);
          return match && match[1] === cfg.sessionId;
        } catch { return false; }
      });
      if (!anchor) throw new Error('Conversation item was not found on the official page.');
      const item = anchor.closest('.next-sidebar-history-item') || anchor;
      const more = item.querySelector(cfg.moreSelector) || anchor.querySelector(cfg.moreSelector);
      if (!more) throw new Error('Conversation actions were not found on the official page.');
      const preventNavigation = event => event.preventDefault();
      anchor.addEventListener('click', preventNavigation, true);
      try {
        more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } finally {
        setTimeout(() => anchor.removeEventListener('click', preventNavigation, true), 0);
      }
      const candidateSelector = '[role="menuitem"], [role="option"], [class*="menu"], [class*="dropdown"], [tabindex], button, li';
      const actionItem = await waitFor(() => {
        const candidates = [...document.querySelectorAll(candidateSelector)]
          .filter(node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
        return candidates.find(node => cfg.labels.includes(clean(node.textContent)))
          || candidates.find(node => cfg.labels.some(label => clean(node.textContent).startsWith(label)
            && clean(node.textContent).length <= label.length + 8 && node.children.length <= 2));
      });
      if (!actionItem) throw new Error('The website did not expose the ' + cfg.action + ' action.');
      actionItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      if (cfg.action === 'pin' || cfg.action === 'share') {
        await sleep(180);
        return { ok: true, action: cfg.action };
      }

      const dialogSelector = '[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popover"]';
      if (cfg.action === 'rename') {
        const input = await waitFor(() => {
          const dialogs = [...document.querySelectorAll(dialogSelector)].filter(visible);
          const scoped = dialogs.flatMap(dialog => [...dialog.querySelectorAll(
            'input:not([type="hidden"]), textarea, [contenteditable="true"]')]).filter(visible);
          const inline = item.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
          return scoped[0] || inline || [...document.querySelectorAll(
            'input:not([type="hidden"]), textarea, [contenteditable="true"]')].filter(visible)
            .find(node => !node.closest('main, [class*="chat-input"], [class*="editor"]'));
        });
        if (!input) throw new Error('The website did not show a rename field.');
        input.focus();
        if (input.isContentEditable) {
          input.textContent = cfg.value;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: cfg.value }));
        } else {
          const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(input, cfg.value); else input.value = cfg.value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const confirmLabels = ['保存', '确定', '完成', '重命名', 'Save', 'Confirm', 'Done', 'Rename'];
        const scope = input.closest(dialogSelector) || document;
        const confirm = [...scope.querySelectorAll('button, [role="button"]')]
          .find(node => visible(node) && !node.disabled && confirmLabels.includes(clean(node.textContent)));
        if (confirm) confirm.click();
        else {
          for (const type of ['keydown', 'keypress', 'keyup']) {
            input.dispatchEvent(new KeyboardEvent(type, {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
            }));
          }
        }
        await sleep(300);
        return { ok: true, action: cfg.action };
      }

      if (cfg.action === 'delete') {
        const confirmLabels = [
          '删除', '删除该对话', '确认', '确认删除', '确定', '删除对话',
          'Delete', 'Delete conversation', 'Delete this conversation', 'Confirm', 'OK',
        ];
        const confirm = await waitFor(() => {
          const dialogs = [...document.querySelectorAll(dialogSelector)].filter(visible);
          const buttons = dialogs.flatMap(dialog => [...dialog.querySelectorAll('button, [role="button"]')])
            .filter(node => visible(node) && !node.disabled);
          return buttons.find(node => confirmLabels.includes(clean(node.textContent)))
            || buttons.find(node => {
              const label = clean(node.textContent);
              if (!label || /cancel|close|取消|关闭/i.test(label)) return false;
              return /^(删除|确认|确定|delete|confirm|ok)\b/i.test(label)
                || /(?:删除|delete).+(?:对话|conversation)/i.test(label);
            });
        }, cfg.autoConfirm ? 900 : 1800);
        if (cfg.autoConfirm && confirm) confirm.click();
        if (!cfg.autoConfirm && confirm) {
          await waitFor(() => !confirm.isConnected || !visible(confirm)
            || !anchor.isConnected || !visible(anchor), 60000);
        }
        const confirmed = Boolean(await waitFor(() => !anchor.isConnected || !visible(anchor), 1600));
        await sleep(150);
        return { ok: true, action: cfg.action, confirmed };
      }

      throw new Error('Unsupported conversation action.');
    } catch (error) {
      return { ok: false, error: error.message };
    }
  })()`;
}

module.exports = { extractionScript, sessionActionScript };
