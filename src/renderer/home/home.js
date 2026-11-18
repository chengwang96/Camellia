'use strict';

const status = document.getElementById('homeStatus');
let activeButton, progressTimer, started, runtimeMessage = '';
function showProgress() {
  if (!activeButton) return;
  const seconds = Math.floor((Date.now() - started) / 1000);
  const name = { dsh: 'DSH', claude: 'Claude Code', codex: 'Codex CLI', kimi: 'Kimi Code', antigravity: 'Antigravity', grok: 'Grok Build' }[activeButton.dataset.mode];
  status.textContent = runtimeMessage || `Starting ${name}…${seconds ? ` (waiting ${seconds} seconds)` : ''}`;
}
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', async () => {
    clearInterval(progressTimer);
    if (activeButton) activeButton.disabled = false;
    activeButton = button;
    started = Date.now();
    runtimeMessage = '';
    button.disabled = true;
    status.className = '';
    showProgress();
    progressTimer = setInterval(showProgress, 1000);
    try {
      const result = await window.dshDesktop.switchMode(button.dataset.mode);
      if (!result.ok) throw new Error(result.error);
      if (result.canceled && activeButton === button) {
        clearInterval(progressTimer);
        activeButton = null;
        button.disabled = false;
        status.textContent = '';
      }
    } catch (error) {
      if (activeButton !== button) return;
      clearInterval(progressTimer);
      status.textContent = error.message;
      status.className = 'error';
      button.disabled = false;
    }
  });
}
document.getElementById('openConfig').addEventListener('click', () => window.dshDesktop.openSettingsWindow());
document.getElementById('openMobileAccess').addEventListener('click', async () => {
  try { const result = await window.dshDesktop.openMobileAccess(); if (!result.ok) throw new Error(result.error); }
  catch (error) { status.textContent = error.message; status.className = 'error'; }
});
document.getElementById('openDiscussions').addEventListener('click', async () => {
  try { const result = await window.dshDesktop.switchMode('discussions'); if (!result.ok) throw new Error(result.error); }
  catch (error) { status.textContent = error.message; status.className = 'error'; }
});
const runtimeRows = new Map();
let runtimeUpdates = [], checkingRuntimeUpdates = false, runtimeCheckedAt = 0;
const runtimeCheckInterval = 5 * 60 * 1000;
function renderRuntimeUpdates() {
  const t = text => window.CamelliaI18n?.t(text) || text;
  for (const button of document.querySelectorAll('[data-runtime-update]')) {
    const info = runtimeUpdates.find(row => row.id === button.dataset.runtimeUpdate);
    const row = runtimeRows.get(button.dataset.runtimeUpdate);
    // A check can finish after an install, path change, or removal. Never show
    // a result for a different installation or Antigravity connection mode.
    const available = info?.updateAvailable && info.checkable && !info.error && info.installed && info.latest
      && row?.status === 'ready' && !row.updating && !row.external && row.version === info.installed
      && (row.id !== 'antigravity' || info.mode === row.mode);
    button.hidden = !available;
    if (!available) continue;
    const label = t('{0} runtime: v{1} → v{2}. View update')
      .replace('{0}', () => row.name).replace('{1}', () => info.installed).replace('{2}', () => info.latest);
    button.title = label;
    button.setAttribute('aria-label', label);
  }
}
async function checkRuntimeUpdates() {
  if (!window.dshDesktop.runtimeCheckUpdates || checkingRuntimeUpdates || Date.now() - runtimeCheckedAt < runtimeCheckInterval) return;
  checkingRuntimeUpdates = true;
  runtimeCheckedAt = Date.now();
  try {
    const result = await window.dshDesktop.runtimeCheckUpdates();
    runtimeUpdates = result.ok && Array.isArray(result.engines) ? result.engines : [];
  } catch {
    // A background registry failure should not replace launch progress/errors.
    runtimeUpdates = [];
  } finally {
    checkingRuntimeUpdates = false;
    renderRuntimeUpdates();
  }
}
for (const button of document.querySelectorAll('[data-runtime-update]')) {
  button.addEventListener('click', async () => {
    try {
      const result = await window.dshDesktop.openSettingsWindow({ page: 'engines', engine: button.dataset.runtimeUpdate, focus: 'updates' });
      if (result?.ok === false) throw new Error(result.error);
    } catch (error) { status.textContent = error.message; status.className = 'error'; }
  });
}
window.addEventListener('camellia:language', renderRuntimeUpdates);
function renderRuntimes(rows) {
  for (const row of rows) {
    const previous = runtimeRows.get(row.id);
    if (!previous || ['version', 'status', 'external', 'mode', 'file'].some(key => previous[key] !== row[key])) runtimeCheckedAt = 0;
    runtimeRows.set(row.id, row);
    const button = document.querySelector(`[data-mode="${row.id}"]`);
    if (!button) continue;
    const name = { dsh: 'DSH', claude: 'Claude', codex: 'Codex', kimi: 'Kimi', antigravity: 'Antigravity', grok: 'Grok Build' }[row.id];
    const action = row.updating ? `Updating ${name}…` : row.status === 'ready' ? `Open ${name}` : row.status === 'installing' ? `Downloading ${name}…`
      : row.status === 'error' ? `Retry download & open ${name}` : `Download & open ${name}`;
    button.querySelector('.entry-action').firstChild.textContent = action + ' ';
    button.setAttribute('aria-label', action);
    button.dataset.runtimeState = row.status;
    button.disabled = row.updating || row.status === 'installing' || (button === activeButton && row.status !== 'error');
    if (row.id !== activeButton?.dataset.mode) continue;
    if (row.status === 'installing') {
      runtimeMessage = `${row.name}: ${row.message || "Preparing runtime…"}`;
      showProgress();
    }
    if (row.status === 'ready') { runtimeMessage = ''; showProgress(); }
    if (row.status === 'error') {
      clearInterval(progressTimer);
      status.textContent = `${row.name} could not be prepared. Retry in Settings → Engine Settings.`;
      status.className = 'error';
      activeButton = null;
    }
  }
  renderRuntimeUpdates();
}
window.dshDesktop.onRuntimeState(rows => { renderRuntimes(rows); void checkRuntimeUpdates(); });
window.dshDesktop.onNetworkHealth(payload => window.CamelliaNetworkNotice?.sync(payload));
async function refreshRuntimes(background = false) {
  try {
    const result = await window.dshDesktop.runtimeState();
    if (!result.ok) throw new Error(result.error);
    renderRuntimes(result.engines);
    void checkRuntimeUpdates();
  } catch (error) {
    if (!background) { status.textContent = error.message; status.className = 'error'; }
  }
}
window.addEventListener('focus', () => void refreshRuntimes(true));
void refreshRuntimes();
