'use strict';

const status = document.getElementById('homeStatus');
let activeButton, progressTimer, started, runtimeMessage = '';
function showProgress() {
  const seconds = Math.floor((Date.now() - started) / 1000);
  const name = { dsh: 'DSH', claude: 'Claude Code', kimi: 'Kimi Code' }[activeButton.dataset.mode];
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
window.dshDesktop.onRuntimeState(rows => {
  for (const row of rows) {
    if (row.id !== activeButton?.dataset.mode) continue;
    if (row.status === 'installing') {
      runtimeMessage = `Preparing ${row.name}. The first download may take a few minutes…`;
      showProgress();
    }
    if (row.status === 'ready') { runtimeMessage = ''; showProgress(); }
    if (row.status === 'error') {
      clearInterval(progressTimer);
      status.textContent = `${row.name} could not be prepared. Retry in Settings → Runtime.`;
      status.className = 'error';
      document.querySelector(`[data-mode="${row.id}"]`).disabled = false;
    }
  }
});
