'use strict';

const status = document.getElementById('homeStatus');
let activeButton, progressTimer, started, runtimeMessage = '';
function showProgress() {
  if (!activeButton) return;
  const seconds = Math.floor((Date.now() - started) / 1000);
  const name = { dsh: 'DSH', claude: 'Claude Code', codex: 'Codex CLI', kimi: 'Kimi Code', antigravity: 'Antigravity' }[activeButton.dataset.mode];
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
document.getElementById('openBenchmark').addEventListener('click', () => window.dshDesktop.switchMode('benchmark'));
function renderRuntimes(rows) {
  for (const row of rows) {
    const button = document.querySelector(`[data-mode="${row.id}"]`);
    if (!button) continue;
    const name = { dsh: 'DSH', claude: 'Claude', codex: 'Codex', kimi: 'Kimi', antigravity: 'Antigravity' }[row.id];
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
      status.textContent = `${row.name} could not be prepared. Retry in Settings → Runtime.`;
      status.className = 'error';
      activeButton = null;
    }
  }
}
window.dshDesktop.onRuntimeState(renderRuntimes);
window.dshDesktop.runtimeState().then(result => {
  if (!result.ok) throw new Error(result.error);
  renderRuntimes(result.engines);
}).catch(error => { status.textContent = error.message; status.className = 'error'; });
