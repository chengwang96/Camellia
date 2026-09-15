'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('dshDesktop', {
  nativeSettingsView: true,
  settingsEmbedded: process.argv.includes('--workbench-settings'),
  showNativeSettings: (payload) => ipcRenderer.invoke('dsh:show-native-settings', payload),
  nativeSettingsReady: () => ipcRenderer.invoke('dsh:native-settings-ready'),
  onNativeSettingsReady: (callback) => subscribe('dsh:native-settings-ready', callback),
  saveCredentials: (payload) => ipcRenderer.invoke('dsh:save-credentials', payload),
  finishOnboarding: () => ipcRenderer.invoke('dsh:finish-onboarding'),
  getState: () => ipcRenderer.invoke('dsh:get-state'),
  openLogs: () => ipcRenderer.invoke('dsh:open-logs'),
  openSettingsWindow: (target) => ipcRenderer.invoke('dsh:open-settings-window', target),
  engineSettingsGet: (payload) => ipcRenderer.invoke('dsh:engine-settings-get', payload),
  engineSettingsSave: (payload) => ipcRenderer.invoke('dsh:engine-settings-save', payload),
  runtimeState: () => ipcRenderer.invoke('dsh:runtime-state'),
  runtimeEnsure: (payload) => ipcRenderer.invoke('dsh:runtime-ensure', payload),
  onRuntimeState: (callback) => subscribe('dsh:runtime-state', callback),
  onSettingsNavigate: (callback) => subscribe('dsh:settings-navigate', callback),
  onEngineSettingsChanged: (callback) => subscribe('dsh:engine-settings-changed', callback),
  // Settings
  getSettings: () => ipcRenderer.invoke('dsh:get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('dsh:save-settings', payload),
  pickFile: (payload) => ipcRenderer.invoke('dsh:pick-file', payload),
  testRuntime: (payload) => ipcRenderer.invoke('dsh:test-runtime', payload),
  applySettings: () => ipcRenderer.invoke('dsh:apply-settings'),
  // Shared API pool (only masked credentials leave the main process).
  openApiSettingsWindow: () => ipcRenderer.invoke('dsh:open-api-settings-window'),
  apiRouterGetState: () => ipcRenderer.invoke('dsh:api-router-get-state'),
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
  workbenchSaveSettings: (payload) => ipcRenderer.invoke('dsh:workbench-save-settings', payload),
  // Claude Code GUI
  claudeSend: (payload) => ipcRenderer.invoke('dsh:claude-send', payload),
  claudeCancel: (runId) => ipcRenderer.invoke('dsh:claude-cancel', runId),
  claudeGetSettings: () => ipcRenderer.invoke('dsh:claude-get-settings'),
  claudeSaveSettings: (payload) => ipcRenderer.invoke('dsh:claude-save-settings', payload),
  claudeControlRespond: (payload) => ipcRenderer.invoke('dsh:claude-control-respond', payload),
  claudeListSessions: (options) => ipcRenderer.invoke('dsh:claude-list-sessions', options),
  claudeLoadSession: (id) => ipcRenderer.invoke('dsh:claude-load-session', id),
  claudeRenameSession: (payload) => ipcRenderer.invoke('dsh:claude-rename-session', payload),
  claudeArchiveSession: (payload) => ipcRenderer.invoke('dsh:claude-archive-session', payload),
  claudeGoalGet: () => ipcRenderer.invoke('dsh:claude-goal-get'),
  claudeGoalStart: (payload) => ipcRenderer.invoke('dsh:claude-goal-start', payload),
  claudeGoalPause: () => ipcRenderer.invoke('dsh:claude-goal-pause'),
  claudeGoalResume: () => ipcRenderer.invoke('dsh:claude-goal-resume'),
  claudeGoalComplete: () => ipcRenderer.invoke('dsh:claude-goal-complete'),
  claudeGoalClear: () => ipcRenderer.invoke('dsh:claude-goal-clear'),
  claudeMetaOp: (payload) => ipcRenderer.invoke('dsh:claude-meta-op', payload),
  switchMode: (mode) => ipcRenderer.invoke('dsh:switch-mode', mode),
  // Attachments: pick via native dialog / resolve dropped File objects
  pickAttachments: () => ipcRenderer.invoke('dsh:pick-attachments'),
  attachmentPath: (file) => webUtils.getPathForFile(file),
  onClaudeEvent: (callback) => subscribe('dsh:claude-event', callback),
  onClaudeGoal: (callback) => subscribe('dsh:claude-goal', callback),
  // Same narrow conversation API for Kimi; no arbitrary IPC forwarding.
  ...Object.fromEntries(['Send', 'Cancel', 'GetLive', 'GetSettings', 'SaveSettings', 'ControlRespond',
    'ListSessions', 'LoadSession', 'RenameSession', 'ArchiveSession', 'MetaOp',
    'GoalGet', 'GoalStart', 'GoalPause', 'GoalResume', 'GoalComplete', 'GoalClear'].map(action => [
    'kimi' + action, payload => ipcRenderer.invoke('dsh:kimi-' + action.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()), payload),
  ])),
  onKimiEvent: callback => subscribe('dsh:kimi-event', callback),
  onKimiGoal: callback => subscribe('dsh:kimi-goal', callback),
});

// Ctrl + mouse wheel zoom (zoom by font/page size from any page).
window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  void ipcRenderer.invoke('dsh:zoom-by-wheel', direction);
}, { passive: false });
