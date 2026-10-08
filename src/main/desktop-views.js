'use strict';
const fs = require('node:fs');
const path = require('node:path');
// The error page is loaded as a data URL, so its shared styles are embedded.
const desktopStyles = ['ui-theme.css', 'desktop-views.css'].map(file => fs.readFileSync(path.join(__dirname, '../renderer/shared', file), 'utf8')).join('\n');

function createDesktopViews({ appName: APP_NAME, isDark }) {
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function errorHtml(err) {
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

return { errorHtml };
}

module.exports = { createDesktopViews };
