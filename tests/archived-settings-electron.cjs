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

  // With nothing left archived, Delete all stays disabled; re-archive and clear everything.
  assert.equal(await run("document.querySelector('#deleteAllArchived').disabled"), true, 'delete-all disabled when empty');
  await run(`window.dshDesktop.claudeArchiveSession(${JSON.stringify({ id: legacyId, archived: true })})`);
  await homeWindow.webContents.executeJavaScript("window.dshDesktop.openSettingsWindow({ page: 'archived' })");
  await wait(async () => (await run("document.querySelectorAll('#archivedList .archived-row').length")) === 1, 're-archived row appears');
  assert.equal(await run("document.querySelector('#deleteAllArchived').disabled"), false, 'delete-all enabled with rows');
  await run("document.querySelector('#deleteAllArchived').click()");
  await wait(() => run("document.querySelector('#deleteAllArchivedDialog').open"), 'delete-all dialog opens');
  assert.equal(await run("document.querySelector('#deleteAllArchivedCount').textContent"), 'All 1 archived conversations will be deleted.');
  await run("document.querySelector('#confirmDeleteAllArchived').click()");
  await wait(() => run("!!document.querySelector('#archivedList .empty')"), 'empty state after delete-all');
  assert.equal(fs.existsSync(legacyFile), false);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(userData, 'desktop-config.json'), 'utf8')).claudeMeta?.archived?.[legacyId]);

  const attachmentDir = path.join(userData, 'clipboard-attachments');
  fs.mkdirSync(attachmentDir, { recursive: true });
  const orphanAttachment = path.join(attachmentDir, 'pasted-text-123-11111111-1111-4111-8111-111111111111.txt');
  const draftAttachment = path.join(attachmentDir, 'pasted-text-123-22222222-2222-4222-8222-222222222222.txt');
  const recentAttachment = path.join(attachmentDir, 'pasted-text-123-33333333-3333-4333-8333-333333333333.txt');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const file of [orphanAttachment, draftAttachment, recentAttachment]) {
    fs.writeFileSync(file, 'attachment data');
    if (file !== recentAttachment) fs.utimesSync(file, old, old);
  }
  await run(`localStorage.setItem('camellia-chat-draft:new:standalone', JSON.stringify({ attachments: [{path: ${JSON.stringify(draftAttachment)}}] }))`);
  await run("document.querySelector('[data-view=storage]').click()");
  assert.equal(await run("document.querySelector('#storagePage').hidden"), false);
  assert.equal(await run("document.querySelector('#storageStatus').textContent"), 'No scan yet.');
  assert.equal(await run("document.querySelector('#cleanStorage').disabled"), true);
  await run("document.querySelector('#scanStorage').click()");
  await wait(() => run("!document.querySelector('#scanStorage').disabled"), 'manual storage scan');
  assert.equal(await run("document.querySelectorAll('#storageFiles .storage-file').length"), 1);
  assert.ok(fs.existsSync(orphanAttachment));
  await run("document.querySelector('#cleanStorage').click()");
  assert.equal(await run("document.querySelector('#cleanStorageDialog').open"), true);
  await run("document.querySelector('#cleanStorageDialog').close()");
  assert.ok(fs.existsSync(orphanAttachment));
  await run("document.querySelector('#cleanStorage').click(); document.querySelector('#confirmCleanStorage').click()");
  await wait(() => run("!document.querySelector('#scanStorage').disabled"), 'manual storage cleanup');
  assert.match(await run("document.querySelector('#storageStatus').textContent"), /Removed 1 files/);
  assert.equal(fs.existsSync(orphanAttachment), false);
  assert.ok(fs.existsSync(draftAttachment)); assert.ok(fs.existsSync(recentAttachment));
  await run("window.CamelliaI18n.setLanguage('zh-CN')");
  assert.equal(await run("document.querySelector('#scanStorage').textContent"), '扫描可清理文件');
  await homeWindow.loadFile(path.join(__dirname, '../src/renderer/chat/claude.html'), { query: { harness: 'claude' } });
  await wait(() => homeWindow.webContents.executeJavaScript('uiReady'), 'chat initialized');
  const queuedAttachment = path.join(attachmentDir, 'pasted-text-123-44444444-4444-4444-8444-444444444444.txt');
  fs.writeFileSync(queuedAttachment, 'queued attachment'); fs.utimesSync(queuedAttachment, old, old);
  await homeWindow.webContents.executeJavaScript(`messageQueue.push({ text: 'queued', attachments: [{ path: ${JSON.stringify(queuedAttachment)} }] })`);
  await run("document.querySelector('#scanStorage').click()");
  await wait(() => run("!document.querySelector('#scanStorage').disabled"), 'scan with live chat queue');
  assert.equal(await run("document.querySelector('#storageStatus').textContent"), '未发现可安全清理的文件。');
  assert.ok(fs.existsSync(queuedAttachment));
  await homeWindow.webContents.executeJavaScript('sending = true');
  const busyOrphan = path.join(conversationsDir, 'busy-orphan.jsonl');
  fs.writeFileSync(busyOrphan, '{}\n'); fs.utimesSync(busyOrphan, old, old);
  fs.writeFileSync(orphanAttachment, 'unused shared attachment'); fs.utimesSync(orphanAttachment, old, old);
  const busyScan = await run('window.dshDesktop.storageScan()');
  assert.equal(busyScan.ok, true);
  assert.equal(busyScan.active, true);
  assert.deepEqual(busyScan.candidates.map(entry => entry.path), [path.relative(userData, busyOrphan)]);
  const busyClean = await run(`window.dshDesktop.storageClean(${JSON.stringify(busyScan.token)})`);
  assert.equal(busyClean.ok, true);
  assert.equal(busyClean.files, 1);
  assert.equal(fs.existsSync(busyOrphan), false);
  for (const file of [queuedAttachment, draftAttachment, orphanAttachment]) assert.ok(fs.existsSync(file));
  await run("document.querySelector('#scanStorage').click()");
  await wait(() => run("!document.querySelector('#scanStorage').disabled"), 'scan during sending');
  assert.match(await run("document.querySelector('#storageSummary').textContent"), /会话正在工作/);
  await homeWindow.webContents.executeJavaScript('sending = false');
  const idleScan = await run('window.dshDesktop.storageScan()');
  assert.equal(idleScan.ok, true);
  assert.equal(idleScan.active, false);
  assert.deepEqual(idleScan.candidates.map(entry => entry.path), [path.relative(userData, orphanAttachment)]);

  await run("document.querySelector('[data-view=mobile]').click()");
  await wait(() => run("!document.querySelector('#mobile-toggle').disabled"), 'embedded mobile access state');
  const mobileState = await run("window.dshDesktop.remoteControl('state')");
  assert.equal(mobileState.ok, true);
  assert.equal(mobileState.result.running, false);
  assert.equal(mobileState.result.address, null);
  assert.equal(await run("document.querySelector('#mobile-status').textContent"), '已关闭');
  assert.equal(await run("document.querySelector('#mobile-error').textContent"), '');
  assert.equal(await run("document.querySelector('#mobile-toggle').textContent"), '开启手机访问');
  assert.equal(await run("document.querySelector('#mobile-allowAll').disabled"), false);
  assert.equal(await run("document.querySelector('#mobile-invite').disabled"), true);
  assert.equal(await run("document.querySelectorAll('#mobile-workspaces input').length"), mobileState.result.workspaces.length);
  assert.equal(await run("document.querySelector('#mobile-openPanel').hidden"), true);
  assert.equal(BrowserWindow.getAllWindows().some(window => window.webContents.getURL().endsWith('/remote/remote.html')), false);

  assert.deepEqual(errors, []);
  console.log('PASS: archived settings and manual space cleanup; saved drafts, recent files and confirmation protected');
  app.exit(0);
}
main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
