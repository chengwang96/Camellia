'use strict';
const { removeTree } = require('./test-fs.cjs');
// Real Electron main + preload + renderer, isolated storage, hidden windows.
// Verifies the Archived settings page: archived conversations from native
// engine histories and shared conversations are listed, restored and deleted.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

async function main() {
  if (!process.versions.electron) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archived-qa-'));
    try {
      const env = { ...process.env, ARCHIVED_QA_ROOT: root, DSH_HOME: path.join(root, 'dsh'), USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home') };
      delete env.ELECTRON_RUN_AS_NODE;
      const proc = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'pipe' });
      let stdout = '', stderr = '';
      proc.stdout.on('data', chunk => { stdout += chunk; });
      proc.stderr.on('data', chunk => { stderr += chunk; });
      const timeout = setTimeout(() => proc.kill(), 120000);
      const code = await new Promise((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, stderr + '\n' + stdout);
      assert.match(stdout, /PASS: archived settings/);
      console.log(stdout.trim());
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      removeTree(root);
    }
    return;
  }

  const { app, BrowserWindow } = require('electron');
  const root = process.env.ARCHIVED_QA_ROOT;
  const home = path.join(root, 'home');
  const userData = path.join(root, 'app');
  app.setPath('userData', userData);
  app.disableHardwareAcceleration();
  const errors = [];
  app.on('web-contents-created', (_event, wc) => {
    wc.on('preload-error', (_event2, _file, error) => errors.push(error.message));
    wc.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  });
  app.on('browser-window-created', (_event, window) => { window.show = () => {}; window.hide(); });

  // Seed one archived legacy Claude session and one archived shared conversation.
  const legacyId = 'legacy-archived-1';
  const projectDir = path.join(home, '.claude', 'projects', 'qa-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const legacyFile = path.join(projectDir, legacyId + '.jsonl');
  fs.writeFileSync(legacyFile, JSON.stringify({ type: 'user', cwd: root, message: { role: 'user', content: 'Legacy archived chat' } }) + '\n');
  const sharedId = 'shared-archived-1';
  const conversationsDir = path.join(userData, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  const sharedJson = path.join(conversationsDir, sharedId + '.json');
  const sharedLog = path.join(conversationsDir, sharedId + '.jsonl');
  fs.writeFileSync(sharedJson, JSON.stringify({ id: sharedId, origin: 'kimi', currentEngine: 'kimi', title: 'Shared archived chat',
    cwd: root, workspaceId: null, createdAt: Date.now(), updatedAt: Date.now(), seq: 1, segments: {}, handoffs: [], engineSettings: {} }));
  fs.writeFileSync(sharedLog, JSON.stringify({ role: 'user', engine: 'kimi', text: 'hello', seq: 1, at: Date.now() }) + '\n');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'desktop-config.json'), JSON.stringify({
    firstRunComplete: true, mode: 'claude', dshHome: process.env.DSH_HOME, port: 0,
    claudeMeta: { archived: { [legacyId]: Date.now() } },
    sharedMeta: { archived: { [sharedId]: Date.now() } },
  }));

  require('../src/main/main');
  await app.whenReady();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait(check, label) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(150); }
    throw new Error('Timed out: ' + label + '\n' + errors.join('\n'));
  }
  const homeWindow = await wait(async () => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#enterDsh')")) return window;
  }, 'home window');
  await homeWindow.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({ page: 'archived' })");
  const settings = await wait(async () => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('#archivedPage')")) return window;
  }, 'settings window');
  const run = js => settings.webContents.executeJavaScript(js);

  await wait(() => run("document.querySelectorAll('#archivedList .archived-row').length"), 'two archived rows');
  const rows = await run("[...document.querySelectorAll('#archivedList .archived-row')].map(r => r.querySelector('h2').textContent + '|' + r.querySelector('.hint').textContent)");
  assert.equal(rows.length, 2);
  assert.ok(rows.some(r => r.startsWith('Legacy archived chat|Claude Code')), JSON.stringify(rows));
  assert.ok(rows.some(r => r.startsWith('Shared archived chat|Kimi Code')), JSON.stringify(rows));
  assert.equal(await run(`(() => { const row = document.querySelector('#archivedList .archived-row'), actions = row.querySelector('.archived-actions');
    return row.getBoundingClientRect().right - actions.getBoundingClientRect().right < 40; })()`), true, 'action buttons stay at the right edge of the row');

  // Restore the legacy session: row disappears, transcript file kept.
  await run(`document.querySelector('[data-restore="claude:${legacyId}"]').click()`);
  await wait(async () => (await run("document.querySelectorAll('#archivedList .archived-row').length")) === 1, 'restore removes the row');
  assert.equal(fs.existsSync(legacyFile), true);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(userData, 'desktop-config.json'), 'utf8')).claudeMeta?.archived?.[legacyId]);

  // Delete the shared conversation through the confirmation dialog.
  await run(`document.querySelector('[data-delete="shared:${sharedId}"]').click()`);
  await wait(() => run("document.querySelector('#deleteArchivedDialog').open"), 'delete dialog opens');
  assert.equal(await run("document.querySelector('#deleteArchivedTitle').textContent"), 'Shared archived chat');
  await run("document.querySelector('#confirmDeleteArchived').click()");
  await wait(() => run("!!document.querySelector('#archivedList .empty')"), 'empty state after delete');
  assert.equal(fs.existsSync(sharedJson), false);
  assert.equal(fs.existsSync(sharedLog), false);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(userData, 'desktop-config.json'), 'utf8')).sharedMeta?.archived?.[sharedId]);

  assert.deepEqual(errors, []);
  console.log('PASS: archived settings page lists, restores and deletes archived conversations');
  app.exit(0);
}
main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
