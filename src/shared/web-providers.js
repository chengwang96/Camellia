'use strict';

const COMMON_LAYOUT_CSS = `
  :root {
    color-scheme: light dark;
    --camellia-web-column-width: calc(var(--camellia-chat-content-width, 768px) + 48px);
    --camellia-web-home-offset: 123px;
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: light-dark(#00000030, #ffffff30); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: light-dark(#00000055, #ffffff55); }
  ::selection { background: color-mix(in srgb, #4d6bfe 24%, transparent); }
`;

const PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek Web',
    shortLabel: 'DeepSeek',
    brand: 'deepseek',
    startUrl: 'https://chat.deepseek.com/',
    partition: 'persist:camellia-web-deepseek',
    navigationHosts: ['deepseek.com'],
    history: Object.freeze({
      anchorSelector: 'a[href*="/a/chat/s/"]',
      titleSelector: '',
      idPattern: '^/a/chat/s/([^/?#]+)',
    }),
    sessionActions: Object.freeze({
      moreSelector: '[role="button"]',
      labels: Object.freeze({
        rename: ['重命名', 'Rename'],
        pin: ['置顶', '取消置顶', 'Pin', 'Unpin'],
        share: ['分享', 'Share'],
        delete: ['删除', 'Delete'],
      }),
    }),
    layout: Object.freeze({
      sidebarSelectors: ['.dc04ec1d'],
      readySelectors: ['._9a2f8e4', '._77cefa5'],
      promoSelectors: [],
      promoText: [
        '开通会员', '会员优惠', '会员权益', '推荐有礼', '邀请有奖',
        '升级会员', '客户端限时优惠', '抢 K3.1 Pro 权益',
        'Upgrade to', 'Membership', 'Invite friends', 'Refer a friend', 'Get Pro',
      ],
      css: `
        ${COMMON_LAYOUT_CSS}
        [data-camellia-web-site-sidebar] { display: none !important; }
        [data-camellia-web-hidden] { display: none !important; }
        html[data-camellia-web-hide-site-sidebar] .dc04ec1d,
        html[data-camellia-web-hide-site-sidebar] ._4cbcd96 { display: none !important; }
        div:has(> .the-header) { display: none !important; }
        :root {
          --message-list-max-width: var(--camellia-web-column-width) !important;
          --message-list-padding-horizontal: 24px !important;
        }
        ._9a2f8e4 {
          box-sizing: border-box !important;
          max-width: var(--camellia-web-column-width) !important;
          padding-left: 24px !important;
          padding-right: 24px !important;
          padding-bottom: 32px !important;
        }
        ._871cbca {
          box-sizing: border-box !important;
          width: min(100%, var(--camellia-web-column-width)) !important;
          margin-left: auto !important;
          margin-right: auto !important;
          padding-left: 24px !important;
          padding-right: 24px !important;
        }
        ._77cefa5 {
          width: 100% !important;
          border-radius: 22px !important;
          background-color: light-dark(#fff, #2c2c2e) !important;
          border-color: light-dark(#0000001a, #ffffff1f) !important;
          box-shadow: 0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a !important;
        }
        ._77cefa5:focus-within { border-color: #d3e2ff !important; }
        html, body {
          background-color: light-dark(#fff, #151517) !important;
          overscroll-behavior: none;
        }
      `,
    }),
  }),
  kimi: Object.freeze({
    id: 'kimi',
    label: 'Kimi Web',
    shortLabel: 'Kimi',
    brand: 'kimi',
    startUrl: 'https://www.kimi.com/',
    partition: 'persist:camellia-web-kimi',
    webRTCIPHandlingPolicy: 'disable_non_proxied_udp',
    navigationHosts: ['kimi.com', 'moonshot.cn', 'accounts.google.com', 'appleid.apple.com'],
    history: Object.freeze({
      anchorSelector: 'a.next-sidebar-history-item__link[href*="/chat/"]',
      titleSelector: '.next-sidebar-history-item__title',
      idPattern: '^/chat/([^/?#]+)',
    }),
    sessionActions: Object.freeze({
      moreSelector: 'button.next-sidebar-history-item__more, button[aria-label="更多"], button[aria-label="More"]',
      labels: Object.freeze({
        rename: ['重命名', 'Rename'],
        pin: ['置顶', '取消置顶', 'Pin', 'Unpin'],
        share: ['分享', 'Share'],
        delete: ['删除', 'Delete'],
      }),
    }),
    layout: Object.freeze({
      sidebarSelectors: ['.sidebar-slot'],
      readySelectors: ['.chat-editor-content', '.chat-content-list'],
      promoSelectors: [
        '.membership-upgrade', '.upgrade-membership', '.use-desktop-app-entry',
        '.desktop-download-entry', '[class*="desktop-download"]',
        '[data-testid="sidebar-get-app"]',
        'button.user-download-button[aria-label*="获取应用程序"]',
        'button.user-download-button[aria-label*="Get app"]',
        'button.user-download-button[aria-label*="Download"]',
        '.resource-placement-card', '.entry-text-promo', 'a[href*="/membership"]',
        '#YSF-BTN-HOLDER', '#YSF-PANEL-INFO',
      ],
      promoText: [
        '开通会员', '会员优惠', '会员权益', '推荐有礼', '邀请有奖',
        '升级会员', '客户端限时优惠', '抢 K3.1 Pro 权益',
        '获取应用程序', '下载桌面端', '下载客户端', '获取客户端',
        'Upgrade to', 'Membership', 'Invite friends', 'Refer a friend', 'Get Pro',
        'Get app', 'Get the app', 'Download desktop', 'Download the app', 'Download app',
      ],
      css: `
        ${COMMON_LAYOUT_CSS}
        [data-camellia-web-site-sidebar] { display: none !important; }
        [data-camellia-web-hidden] { display: none !important; }
        html[data-camellia-web-hide-site-sidebar] .sidebar-slot { display: none !important; }
        .layout-header { display: none !important; }
        .layout-content-main { height: 100% !important; }
        html, body, .app, .main, .layout-container, .layout-content, .home-page, .chat-box {
          background-color: light-dark(#fff, #151517) !important;
        }
        .home-page { scrollbar-width: none; }
        .home-page::-webkit-scrollbar { width: 0; height: 0; }
        .home-top { padding-top: var(--camellia-web-home-offset) !important; }
        .chat-content-list {
          box-sizing: border-box !important;
          width: 100% !important;
          max-width: var(--camellia-web-column-width) !important;
          margin-left: auto !important;
          margin-right: auto !important;
          padding-left: 24px !important;
          padding-right: 24px !important;
          padding-top: 24px !important;
          padding-bottom: 32px !important;
        }
        .chat-editor-wrap {
          width: 100% !important;
          max-width: var(--camellia-chat-content-width, 768px) !important;
          margin-left: auto !important;
          margin-right: auto !important;
        }
        .chat-editor-content {
          min-height: 126px !important;
          border-radius: 22px !important;
          background-color: light-dark(#fff, #2c2c2e) !important;
          border-color: light-dark(#0000001a, #ffffff1f) !important;
          box-shadow: 0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a !important;
        }
        .chat-editor-content:focus-within { border-color: #d3e2ff !important; }
        .app.has-sidebar .main {
          width: 100% !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 0 !important;
        }
        .layout-container {
          scrollbar-width: none !important;
          scrollbar-gutter: auto !important;
        }
        .layout-container::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
        .app.has-sidebar.enable-layout-animation .main { transition: none !important; }
        html, body { overscroll-behavior: none; }
      `,
    }),
  }),
});

const PROVIDER_LIST = Object.freeze(Object.values(PROVIDERS));

function providerFor(id) {
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

function publicProviders() {
  return PROVIDER_LIST.map(provider => ({
    id: provider.id,
    label: provider.label,
    shortLabel: provider.shortLabel,
    brand: provider.brand,
  }));
}

function parseHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function hostAllowed(provider, hostname) {
  const host = String(hostname || '').toLowerCase();
  return provider.navigationHosts.some(allowed => host === allowed || host.endsWith('.' + allowed));
}

function navigationAllowed(provider, value) {
  const url = parseHttpsUrl(value);
  return Boolean(url && hostAllowed(provider, url.hostname));
}

function canonicalSessionUrl(provider, value) {
  const url = parseHttpsUrl(value);
  if (!url || !hostAllowed(provider, url.hostname)) return null;
  url.search = '';
  url.hash = '';
  return url.href;
}

function sessionIdFor(provider, value) {
  const url = parseHttpsUrl(value);
  if (!url) return null;
  const match = new RegExp(provider.history.idPattern).exec(url.pathname);
  return match && match[1] ? match[1] : null;
}

function cleanTitle(value, fallback = '') {
  return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
    || String(fallback || '');
}

function normalizeSessions(provider, rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set(), sessions = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const url = canonicalSessionUrl(provider, row.url);
    const id = sessionIdFor(provider, url);
    if (!id || seen.has(id)) continue;
    const title = cleanTitle(row.title, provider.shortLabel);
    seen.add(id);
    sessions.push({ id, title, url });
  }
  return sessions;
}

function activeSessionId(provider, value) {
  const url = parseHttpsUrl(value);
  return url ? sessionIdFor(provider, url.href) : null;
}

function normalizeProfile(provider, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const anchorSelector = String(value.historyAnchorSelector || '').trim();
  const titleSelector = String(value.titleSelector || '').trim();
  const css = String(value.css || '');
  if (!anchorSelector || anchorSelector.length > 300 || titleSelector.length > 300) return null;
  if (css.length > 20000 || /@import|@font-face|url\s*\(|javascript\s*:|expression\s*\(/i.test(css)) return null;
  return {
    provider: provider.id,
    version: Math.max(1, Math.min(999, Number(value.version) || 1)),
    historyAnchorSelector: anchorSelector,
    titleSelector,
    css,
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

module.exports = {
  PROVIDERS,
  PROVIDER_LIST,
  activeSessionId,
  canonicalSessionUrl,
  cleanTitle,
  navigationAllowed,
  normalizeProfile,
  normalizeSessions,
  providerFor,
  publicProviders,
  sessionIdFor,
};
