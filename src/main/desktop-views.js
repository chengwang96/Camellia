'use strict';
const fs = require('node:fs');
const path = require('node:path');
// These pages are loaded as data URLs, so their shared styles are embedded.
const desktopStyles = ['ui-theme.css', 'desktop-views.css'].map(file => fs.readFileSync(path.join(__dirname, '../renderer/shared', file), 'utf8')).join('\n');

function createDesktopViews({ appName: APP_NAME, isDark }) {
function welcomeHtml() {
  const dark = isDark();
  return `<!doctype html>
<html lang="en" data-theme="${dark ? 'dark' : 'light'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(APP_NAME)} — Initial setup</title>
<style>${desktopStyles}</style>
</head>
<body class="setup-page">
<main>
  <h1>Connect your AI services</h1>
  <p class="sub">Add providers, keys, and models in settings. DSH, Claude, and Kimi share these connections. You can also continue with an existing engine configuration.</p>
  <div id="status"></div>
  <div class="actions">
    <button id="skip" type="button">Continue to engine</button>
    <button id="setupConnections" class="primary" type="button">Configure connections</button>
  </div>
</main>
<script>
  const statusEl = document.getElementById('status');
  function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.className = err ? 'err' : ''; }
  document.getElementById('setupConnections').addEventListener('click', async () => {
    try {
      await window.dshDesktop.openSettingsWindow();
      setStatus('Save your connections, then choose Continue to engine.');
    } catch (e) { setStatus(String(e && e.message || e), true); }
  });
  document.getElementById('skip').addEventListener('click', async () => {
    setStatus('Opening…');
    await window.dshDesktop.finishOnboarding();
  });
</script>
</body>
</html>`;
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function errorHtml(err, backendUrlInfo) {
  const dark = isDark();
  const message = escapeHtml(String(err && (err.stack || err.message) ? (err.stack || err.message) : err));
  return `<!doctype html><html lang="en" data-theme="${dark ? 'dark' : 'light'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"><title>${escapeHtml(APP_NAME)} Failed to start</title><style>${desktopStyles}</style></head><body class="error-page"><main><h1>${escapeHtml(APP_NAME)} Failed to start</h1><pre>${message}</pre>
  <div class="actions"><button class="primary" id="openSettings">Open settings</button><button id="retry">Retry</button></div>
  </main>
  <script>
  document.getElementById('openSettings').addEventListener('click', () => window.dshDesktop.openSettingsWindow());
  document.getElementById('retry').addEventListener('click', () => window.dshDesktop.applySettings());
  </script>
  </body></html>`;
}

return { welcomeHtml, errorHtml };
}

module.exports = { createDesktopViews };
