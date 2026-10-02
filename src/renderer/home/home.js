'use strict';

const status = document.getElementById('homeStatus');
let activeButton, progressTimer, started, runtimeMessage = '';
function showProgress() {
  if (!activeButton) return;
  const seconds = Math.floor((Date.now() - started) / 1000);
  const name = { dsh: 'DSH', claude: 'Claude Code', codex: 'Codex CLI', kimi: 'Kimi Code', antigravity: 'Antigravity', pi: 'Pi' }[activeButton.dataset.mode];
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
document.getElementById('openCliDevices').addEventListener('click', async () => {
  try { const result = await window.dshDesktop.openCliDevices(); if (!result.ok) throw new Error(result.error); }
  catch (error) { status.textContent = error.message; status.className = 'error'; }
});
document.getElementById('openBenchmark').addEventListener('click', () => window.dshDesktop.switchMode('benchmark'));
document.getElementById('openDiscussions').addEventListener('click', async () => {
  try { const result = await window.dshDesktop.switchMode('discussions'); if (!result.ok) throw new Error(result.error); }
  catch (error) { status.textContent = error.message; status.className = 'error'; }
});
let loadingServers = false;
async function renderServers() {
  if (loadingServers) return;
  loadingServers = true;
  try {
    const result = await window.dshDesktop.listCliServers();
    if (!result.ok) throw new Error(result.error);
    const english = result.language === 'en';
    const anchor = document.querySelector('.home-tools');
    const names = { codex: 'Codex CLI', claude: 'Claude Code', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity', pi: 'Pi' };
    document.getElementById('cliDivider').hidden = result.devices.length === 0;
    for (const entry of document.querySelectorAll('[data-server]')) entry.remove();
    document.querySelector('#openCliDevices .config-title').textContent = english ? 'Server connections' : '服务器连接';
    document.getElementById('openCliDevices').setAttribute('aria-label', english ? 'Server connections' : '服务器连接');
    document.querySelector('#openCliDevices .entry-description').textContent = english ? 'Pair servers and choose a default harness' : '配对服务器、设置默认 Harness';
    for (const device of result.devices) {
      const button = document.createElement('button'); button.className = 'agent-entry server-entry'; button.dataset.server = device.id;
      const symbol = document.createElement('span'); symbol.className = 'agent-symbol server-symbol'; symbol.textContent = '>_'; symbol.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span'); title.className = 'entry-title'; title.textContent = device.name;
      const description = document.createElement('span'); description.className = 'entry-description'; description.textContent = `CLI SERVER · ${names[device.defaultHarness] || (english ? 'Server harness' : '服务器 Harness')}`;
      const address = document.createElement('span'); address.className = 'server-address'; address.textContent = device.address;
      const action = document.createElement('span'); action.className = 'entry-action'; action.textContent = english ? 'Open server' : '打开服务器';
      button.append(symbol, title, description, address, action);
      button.onclick = async () => {
        button.disabled = true;
        try { const opened = await window.dshDesktop.openCliServer(device.id); if (!opened.ok) throw new Error(opened.error); }
        catch (error) { status.textContent = error.message; status.className = 'error'; }
        finally { button.disabled = false; }
      };
      anchor.before(button);
    }
  } catch (error) { status.textContent = error.message; status.className = 'error'; }
  finally { loadingServers = false; }
}
window.addEventListener('focus', () => void renderServers());
void renderServers();
const runtimeRows = new Map();
let runtimeUpdates = [], checkingRuntimeUpdates = false, runtimeCheckedAt = 0;
const runtimeCheckInterval = 5 * 60 * 1000;
function renderRuntimeUpdates() {
  const t = text => window.CamelliaI18n?.t(text) || text;
  for (const button of document.querySelectorAll('[data-runtime-update]')) {
    const info = runtimeUpdates.find(row => row.id === button.dataset.runtimeUpdate);
    const row = runtimeRows.get(button.dataset.runtimeUpdate);
    // A check can finish after an install, path change, or removal. Never show
    // a result for a different installation or an app-managed runtime.
    const available = info?.updateAvailable && info.checkable && !info.error && info.installed && info.latest
      && row?.status === 'ready' && !row.external && !(row.id === 'antigravity' && row.mode === 'subscription') && row.version === info.installed;
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
    const name = { dsh: 'DSH', claude: 'Claude', codex: 'Codex', kimi: 'Kimi', antigravity: 'Antigravity', pi: 'Pi' }[row.id];
    const action = row.status === 'ready' ? `Open ${name}` : row.status === 'installing' ? `Downloading ${name}…`
      : row.status === 'error' ? `Retry download & open ${name}` : `Download & open ${name}`;
    button.querySelector('.entry-action').firstChild.textContent = action + ' ';
    button.setAttribute('aria-label', action);
    button.dataset.runtimeState = row.status;
    button.disabled = row.status === 'installing' || (button === activeButton && row.status !== 'error');
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
