'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('camelliaWindowChrome', {
  getState: () => ipcRenderer.invoke('camellia:window-chrome-state'),
  openMenu: payload => ipcRenderer.invoke('camellia:window-chrome-menu', payload),
  onState: callback => subscribe('camellia:window-chrome', callback),
  onFocus: callback => subscribe('camellia:window-chrome-focus', callback),
});

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  nativeSettingsView: true,
  settingsEmbedded: process.argv.includes('--workbench-settings'),
  settingsWindow: process.argv.includes('--camellia-settings-window'),
  showNativeSettings: (payload) => ipcRenderer.invoke('dsh:show-native-settings', payload),
  nativeSettingsReady: () => ipcRenderer.invoke('dsh:native-settings-ready'),
  onNativeSettingsReady: (callback) => subscribe('dsh:native-settings-ready', callback),
  getState: () => ipcRenderer.invoke('dsh:get-state'),
  openLogs: () => ipcRenderer.invoke('dsh:open-logs'),
  openSettingsWindow: (target) => ipcRenderer.invoke('dsh:open-settings-window', target),
  closeSettingsWindow: () => ipcRenderer.invoke('dsh:close-settings-window'),
  settingsOverlay: () => ipcRenderer.invoke('dsh:settings-overlay'),
  onSettingsOverlay: callback => subscribe('dsh:settings-overlay', callback),
  openMobileAccess: () => ipcRenderer.invoke('dsh:open-mobile-access'),
  openCliDevices: () => ipcRenderer.invoke('camellia:open-devices'),
  listCliServers: () => ipcRenderer.invoke('camellia:list-servers'),
  openCliServer: deviceId => ipcRenderer.invoke('camellia:open-server', { deviceId }),
  camelliaDevices: {
    call: (action, payload) => ipcRenderer.invoke('camellia:devices', { action, payload }),
    onEvent: callback => subscribe('camellia:device-event', callback),
    onTransfer: callback => subscribe('camellia:device-transfer', callback),
  },
  remoteControl: (action, payload) => ipcRenderer.invoke('dsh:remote-control', { action, payload }),
  engineSettingsGet: (payload) => ipcRenderer.invoke('dsh:engine-settings-get', payload),
  subscriptionPreferencesGet: payload => ipcRenderer.invoke('dsh:subscription-preferences-get', payload),
  subscriptionPreferencesSave: payload => ipcRenderer.invoke('dsh:subscription-preferences-save', payload),
  engineSettingsSave: (payload) => ipcRenderer.invoke('dsh:engine-settings-save', payload),
  runtimeState: () => ipcRenderer.invoke('dsh:runtime-state'),
  runtimeSetPath: (payload) => ipcRenderer.invoke('dsh:runtime-set-path', payload),
  runtimeSetPython: (payload) => ipcRenderer.invoke('dsh:runtime-set-python', payload),
  runtimePythonState: () => ipcRenderer.invoke('dsh:runtime-python-state'),
  appUpdateCheck: () => ipcRenderer.invoke('dsh:app-update-check'),
  appUpdateInstall: () => ipcRenderer.invoke('dsh:app-update-install'),
  runtimeEnsure: (payload) => ipcRenderer.invoke('dsh:runtime-ensure', payload),
  runtimeCheckUpdates: () => ipcRenderer.invoke('dsh:runtime-check-updates'),
  runtimeUpdate: (payload) => ipcRenderer.invoke('dsh:runtime-update', payload),
  runtimeReinstall: (payload) => ipcRenderer.invoke('dsh:runtime-reinstall', payload),
  runtimeReinstallPreview: (payload) => ipcRenderer.invoke('dsh:runtime-reinstall-preview', payload),
  runtimeUninstall: (payload) => ipcRenderer.invoke('dsh:runtime-uninstall', payload),
  runtimeUninstallPreview: (payload) => ipcRenderer.invoke('dsh:runtime-uninstall-preview', payload),
  downloadSettings: () => ipcRenderer.invoke('dsh:download-settings'),
  networkSettings: () => ipcRenderer.invoke('dsh:network-settings'),
  networkTest: () => ipcRenderer.invoke('dsh:network-test'),
  networkSaveSettings: payload => ipcRenderer.invoke('dsh:network-save-settings', payload),
  onNetworkHealth: callback => subscribe('dsh:network-health', callback),
  downloadSaveSettings: (payload) => ipcRenderer.invoke('dsh:download-save-settings', payload),
  onRuntimeState: (callback) => subscribe('dsh:runtime-state', callback),
  onRuntimePythonState: (callback) => subscribe('dsh:runtime-python-state', callback),
  onAppUpdateState: (callback) => subscribe('dsh:app-update-state', callback),
  discussion: (action, payload = {}) => ipcRenderer.invoke('dsh:discussion', { action, payload }),
  onDiscussionEvent: callback => subscribe('dsh:discussion-event', callback),
  onDiscussionNavigate: callback => subscribe('dsh:discussion-navigate', callback),
  onSettingsNavigate: (callback) => subscribe('dsh:settings-navigate', callback),
  onEngineSettingsChanged: (callback) => subscribe('dsh:engine-settings-changed', callback),
  onChatContentWidthChanged: (callback) => subscribe('dsh:chat-content-width-changed', callback),
  // Settings
  getSettings: () => ipcRenderer.invoke('dsh:get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('dsh:save-settings', payload),
  pickFile: (payload) => ipcRenderer.invoke('dsh:pick-file', payload),
  testRuntime: (payload) => ipcRenderer.invoke('dsh:test-runtime', payload),
  applySettings: () => ipcRenderer.invoke('dsh:apply-settings'),
  // Shared API pool (only masked credentials leave the main process).
  openApiSettingsWindow: () => ipcRenderer.invoke('dsh:open-api-settings-window'),
  apiRouterGetState: () => ipcRenderer.invoke('dsh:api-router-get-state'),
  subscriptionPricesRefresh: () => ipcRenderer.invoke('dsh:subscription-prices-refresh'),
  apiRouterSaveConfig: (payload) => ipcRenderer.invoke('dsh:api-router-save-config', payload),
  apiRouterRotate: (model) => ipcRenderer.invoke('dsh:api-router-rotate', model),
  apiRouterReset: (payload) => ipcRenderer.invoke('dsh:api-router-reset', payload),
  onApiRouterState: (callback) => subscribe('dsh:api-router-state', callback),
  ollamaProxyGetState: () => ipcRenderer.invoke('dsh:ollama-proxy-get-state'),
  providerInsights: () => ipcRenderer.invoke('dsh:provider-insights'),
  providerRefresh: (payload) => ipcRenderer.invoke('dsh:provider-refresh', payload),
  providerModels: (payload) => ipcRenderer.invoke('dsh:provider-models', payload),
  providerVerify: (payload) => ipcRenderer.invoke('dsh:provider-verify', payload),
  onProviderInsights: (callback) => subscribe('dsh:provider-insights', callback),
  workbenchSettings: () => ipcRenderer.invoke('dsh:workbench-settings'),
  onLanguageChanged: (callback) => subscribe('dsh:language-changed', callback),
  workbenchSaveSettings: (payload) => ipcRenderer.invoke('dsh:workbench-save-settings', payload),
  archivedSessionsList: () => ipcRenderer.invoke('dsh:archived-sessions-list'),
  archivedSessionAction: (payload) => ipcRenderer.invoke('dsh:archived-session-action', payload),
  onArchivedDeleteProgress: (callback) => subscribe('dsh:archived-delete-progress', callback),
  storageScan: () => ipcRenderer.invoke('dsh:storage-scan'),
  storageReferencesChanged: () => ipcRenderer.invoke('dsh:storage-references-changed'),
  storageClean: (token) => ipcRenderer.invoke('dsh:storage-clean', { token }),
  dataDirectoryMigrate: () => ipcRenderer.invoke('dsh:data-directory-migrate'),
  pluginCacheMaintain: () => ipcRenderer.invoke('dsh:plugin-cache-maintain'),
  dataExport: (scope) => ipcRenderer.invoke('dsh:data-export', { scope }),
  dataImport: (file, scope) => ipcRenderer.invoke('dsh:data-import', { file, scope }),
  onDataMigrationProgress: (callback) => subscribe('dsh:data-migration-progress', callback),
  onArchivedChanged: (callback) => subscribe('dsh:archived-changed', callback),
  codexDesktopSessions: () => ipcRenderer.invoke('dsh:codex-desktop-sessions'),
  codexDesktopImport: (ids) => ipcRenderer.invoke('dsh:codex-desktop-import', { ids }),
  codexDesktopSync: (id) => ipcRenderer.invoke('dsh:codex-desktop-sync', { id }),
  switchMode: (mode) => ipcRenderer.invoke('dsh:switch-mode', mode),
  onHarnessNavigate: callback => subscribe('dsh:harness-navigate', callback),
  conversationCommand: payload => ipcRenderer.invoke('dsh:conversation-command', payload),
  conversationSwitch: payload => ipcRenderer.invoke('dsh:conversation-switch', payload),
  conversationHandoff: payload => ipcRenderer.invoke('dsh:conversation-handoff', payload),
  conversationOpenHandoff: payload => ipcRenderer.invoke('dsh:conversation-open-handoff', payload),
  onConversationEvent: callback => subscribe('dsh:conversation-event', callback),
  onConversationGoal: callback => subscribe('dsh:conversation-goal', callback),
  onConversationStatus: callback => subscribe('dsh:conversation-status', callback),
  // Attachments: pick via native dialog / resolve dropped File objects
  pickAttachments: () => ipcRenderer.invoke('dsh:pick-attachments'),
  attachmentPath: (file) => webUtils.getPathForFile(file),
  saveClipboardImage: (payload) => ipcRenderer.invoke('dsh:save-clipboard-image', payload),
  savePastedText: (payload) => ipcRenderer.invoke('dsh:save-pasted-text', payload),
  previewFile: (filePath) => ipcRenderer.invoke('dsh:preview-file', filePath),
  resolveArtifacts: (payload) => ipcRenderer.invoke('dsh:resolve-artifacts', payload),
  openFileExternally: (filePath) => ipcRenderer.invoke('dsh:open-file-externally', filePath),
  revealFile: (filePath) => ipcRenderer.invoke('dsh:reveal-file', filePath),
  onCodexAccount: callback => subscribe('dsh:codex-account', callback),
  codexAccountState: payload => ipcRenderer.invoke('dsh:codex-account-state', payload),
  codexAccountRefresh: id => ipcRenderer.invoke('dsh:codex-account-refresh', { id }),
  codexAccountResetPreview: id => ipcRenderer.invoke('dsh:codex-account-reset-preview', { id }),
  codexAccountResetConsume: payload => ipcRenderer.invoke('dsh:codex-account-reset-consume', payload),
  codexAccountWake: id => ipcRenderer.invoke('dsh:codex-account-wake', { id }),
  codexSignIn: () => ipcRenderer.invoke('dsh:codex-sign-in'),
  codexAccountSelect: id => ipcRenderer.invoke('dsh:codex-account-select', { id }),
  codexAccountAdd: label => ipcRenderer.invoke('dsh:codex-account-add', { label }),
  codexAccountRemove: id => ipcRenderer.invoke('dsh:codex-account-remove', { id }),
  codexAccountLabel: (id, label) => ipcRenderer.invoke('dsh:codex-account-label', { id, label }),
  kimiAccountState: payload => ipcRenderer.invoke('dsh:kimi-account-state', payload),
  kimiAccountRefresh: id => ipcRenderer.invoke('dsh:kimi-account-refresh', { id }),
  kimiAccountWake: id => ipcRenderer.invoke('dsh:kimi-account-wake', { id }),
  kimiSignIn: () => ipcRenderer.invoke('dsh:kimi-sign-in'),
  kimiCancelLogin: () => ipcRenderer.invoke('dsh:kimi-cancel-login'),
  kimiOpenLogin: () => ipcRenderer.invoke('dsh:kimi-open-login'),
  kimiSignOut: () => ipcRenderer.invoke('dsh:kimi-sign-out'),
  kimiAccountSelect: id => ipcRenderer.invoke('dsh:kimi-account-select', { id }),
  kimiAccountAdd: label => ipcRenderer.invoke('dsh:kimi-account-add', { label }),
  kimiAccountRemove: id => ipcRenderer.invoke('dsh:kimi-account-remove', { id }),
  kimiAccountLabel: (id, label) => ipcRenderer.invoke('dsh:kimi-account-label', { id, label }),
  onKimiAccount: callback => subscribe('dsh:kimi-account', callback),
  grokAccountState: payload => ipcRenderer.invoke('dsh:grok-account-state', payload),
  grokAccountRefresh: id => ipcRenderer.invoke('dsh:grok-account-refresh', { id }),
  grokSignIn: () => ipcRenderer.invoke('dsh:grok-sign-in'),
  grokCancelLogin: () => ipcRenderer.invoke('dsh:grok-cancel-login'),
  grokOpenLogin: () => ipcRenderer.invoke('dsh:grok-open-login'),
  grokSignOut: id => ipcRenderer.invoke('dsh:grok-sign-out', { id }),
  grokAccountSelect: id => ipcRenderer.invoke('dsh:grok-account-select', { id }),
  grokAccountAdd: label => ipcRenderer.invoke('dsh:grok-account-add', { label }),
  grokAccountRemove: id => ipcRenderer.invoke('dsh:grok-account-remove', { id }),
  grokAccountLabel: (id, label) => ipcRenderer.invoke('dsh:grok-account-label', { id, label }),
  onGrokAccount: callback => subscribe('dsh:grok-account', callback),
  codexSignOut: () => ipcRenderer.invoke('dsh:codex-sign-out'),
  codexCancelLogin: () => ipcRenderer.invoke('dsh:codex-cancel-login'),
  antigravityAccountState: () => ipcRenderer.invoke('dsh:antigravity-account-state'),
  antigravityAccountRefresh: () => ipcRenderer.invoke('dsh:antigravity-account-refresh'),
  antigravityAccountRefreshUsage: () => ipcRenderer.invoke('dsh:antigravity-account-refresh-usage'),
  antigravityAccountLabel: label => ipcRenderer.invoke('dsh:antigravity-account-label', { label }),
  onAntigravityAccount: callback => subscribe('dsh:antigravity-account', callback),
  antigravitySignIn: () => ipcRenderer.invoke('dsh:antigravity-sign-in'),
  antigravitySignOut: () => ipcRenderer.invoke('dsh:antigravity-sign-out'),
});

function createZoomIndicator({ top = 16, hideAfter = 1400 }) {
  let host, shadow, sheet, label, hideTimer, pendingFactor;

  function updateMetrics(factor) {
    const px = value => value / factor + 'px';
    sheet.replaceSync(`
      :host {
        position: fixed; z-index: 2147483647; top: ${px(top)}; left: 50%;
        pointer-events: none; opacity: 0; visibility: hidden;
        transform: translate(-50%, ${px(-4)});
        transition: opacity 140ms ease, transform 140ms ease, visibility 140ms;
      }
      :host([data-visible]) { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
      .zoom-panel {
        display: flex; align-items: center; gap: ${px(7)}; box-sizing: border-box;
        padding: ${px(7)} ${px(12)}; border: 1px solid light-dark(#0f11151a, #ffffff1f);
        border-radius: ${px(12)}; background: light-dark(#ffffffd9, #232324d9);
        box-shadow: 0 ${px(4)} ${px(18)} #0000001f;
        backdrop-filter: blur(${px(18)}) saturate(140%);
        color: light-dark(#0f1115, #f9fafb);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: ${px(13)}; font-weight: 600; line-height: ${px(18)};
        font-variant-numeric: tabular-nums; white-space: nowrap; user-select: none;
      }
      svg { width: ${px(16)}; height: ${px(16)}; flex: none; opacity: .72; }
      @media (prefers-reduced-motion: reduce) { :host { transition: none; } }
    `);
  }

  function mount() {
    host = document.createElement('div');
    host.id = 'camellia-zoom-indicator';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'true');
    shadow = host.attachShadow({ mode: 'open' });
    sheet = new window.CSSStyleSheet();
    shadow.adoptedStyleSheets = [sheet];
    const panel = document.createElement('div');
    panel.className = 'zoom-panel';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.8');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '10.5'); circle.setAttribute('cy', '10.5'); circle.setAttribute('r', '6.5');
    const handle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    handle.setAttribute('d', 'm16 16 4 4M7.5 10.5h6M10.5 7.5v6');
    label = document.createElement('span');
    icon.append(circle, handle); panel.append(icon, label); shadow.append(panel);
    document.body.append(host);
  }

  function show(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (!document.body) { pendingFactor = factor; return; }
    if (!host) mount();
    window.clearTimeout(hideTimer);
    updateMetrics(factor);
    label.textContent = Math.round(factor * 100) + '%';
    host.setAttribute('data-visible', '');
    hideTimer = window.setTimeout(() => host.removeAttribute('data-visible'), hideAfter);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (pendingFactor) { const factor = pendingFactor; pendingFactor = undefined; show(factor); }
  }, { once: true });
  return show;
}

let showZoomIndicator;
ipcRenderer.on('dsh:zoom-changed', (_event, state) => {
  showZoomIndicator ||= createZoomIndicator({
    top: process.platform === 'win32' && !['--camellia-settings-window', '--workbench-settings'].some(flag => process.argv.includes(flag)) ? 52 : 16 });
  showZoomIndicator(state?.zoomFactor);
});

// Ctrl + mouse wheel zoom (zoom by font/page size from any page).
window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  void ipcRenderer.invoke('dsh:zoom-by-wheel', direction);
}, { passive: false });
