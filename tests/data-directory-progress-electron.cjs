'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  // Local regression runs must not put a simulated migration on the desktop.
  // CI and explicit visual checks still exercise the real window visibility.
  const showWindow = process.argv.includes('--show-window') || process.env.CAMELLIA_DIRECTORY_PROGRESS_TEST_VISIBLE === '1';
  if (process.versions.electron) {
    const { app } = require('electron');
    const { showDirectoryMigrationProgress } = require('../src/main/data-directory-progress');
    const window = await showDirectoryMigrationProgress();
    assert.equal(window.isVisible(), showWindow, showWindow
      ? 'The migration window must be visible during an explicit visual check'
      : 'A local regression must keep the simulated migration window hidden');
    const root = process.argv[process.argv.indexOf('--camellia-directory-progress') + 1];
    assert.equal(app.getPath('userData'), path.join(root, 'profile'));
    assert.equal(app.getPath('sessionData'), path.join(root, 'profile'));
    const state = () => window.webContents.executeJavaScript(`({title:document.getElementById('title').textContent,
      stage:document.getElementById('stage').textContent, value:document.getElementById('progress').getAttribute('value'),
      count:document.getElementById('count').textContent, elapsed:document.getElementById('elapsed').textContent,
      step:document.getElementById('step').textContent,
      disabled:document.getElementById('cancel').disabled})`);
    const first = await state();
    assert.equal(first.title, '正在迁移 Camellia 数据');
    assert.equal(first.value, null, 'Initial scan must not invent a percentage');
    process.send({ type: 'ready' });
    // This runs in the helper while the owner is blocked on synchronous I/O.
    const deadline = Date.now() + 10_000;
    while ((await state()).stage !== '复制数据') {
      if (Date.now() > deadline) throw new Error('The progress window did not update');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const copying = await state();
    assert.equal(Number(copying.value), 50);
    assert.match(copying.count, /2 \/ 4/);
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.notEqual((await state()).elapsed, copying.elapsed, 'Elapsed time advances while the owner is blocked');
    fs.writeFileSync(path.join(root, 'responsive'), 'yes');
    process.send({ type: 'responsive' });
    await new Promise(resolve => process.once('message', resolve));
    await window.webContents.executeJavaScript("document.getElementById('cancel').click()");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(path.join(root, 'cancel'), 'utf8'), 'cancel');
    assert.equal((await state()).disabled, true);
    const fast = { startedAt: Date.now(), language: 'zh-CN', source: 'C:/old/dsh-desktop', destination: 'C:/new/camellia',
      stage: 'move', method: 'rename', cancellable: false, phases: ['inventory', 'prepare', 'verify-prepared', 'move', 'verify-updates', 'activate'],
      processedEntries: 2, totalEntries: 4 };
    fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify(fast));
    // A canceled window retains its canceling label; phase and progress must
    // still follow the new strategy's independent six-step plan.
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal((await state()).step, '4 / 6');
    assert.equal(Number((await state()).value), 50);
    assert.equal((await state()).disabled, true);
    const failed = { startedAt: Date.now(), language: 'zh-CN', source: 'C:/old/dsh-desktop', destination: 'C:/new/camellia',
      stage: 'error', error: 'EPERM: symlink ' + 'C:/very-long/dependency/path/'.repeat(15), cancellable: false };
    fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify(failed));
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(window.isDestroyed(), false, 'A failure must remain available until acknowledged');
    assert.equal((await state()).title, '迁移已停止');
    assert.equal((await state()).disabled, false, 'The error can be dismissed');
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('cancel').getBoundingClientRect().bottom <= innerHeight"), true,
      'Long errors must not push the close button outside the window');
    console.log('PASS: independent migration window, isolated profile, truthful progress, responsive elapsed time, cancellation and persistent failure');
    app.exit(0);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-directory-progress-'));
  let child;
  try {
    const state = { startedAt: Date.now(), language: 'zh-CN', source: 'C:/old/dsh-desktop', destination: 'C:/new/camellia',
      stage: 'scan', processedEntries: 0, processedBytes: 0, cancellable: true };
    const write = update => fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify({ ...state, ...update }));
    write({});
    const env = { ...process.env, CAMELLIA_DIRECTORY_PROGRESS_HIDDEN: showWindow ? '0' : '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [__filename, '--camellia-directory-progress', root, ...(showWindow ? ['--show-window'] : [])],
      { env, windowsHide: !showWindow, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    const ready = new Promise(resolve => child.once('message', resolve));
    const timeout = setTimeout(() => child.kill(), 25_000);
    try {
      const first = await Promise.race([ready, closed.then(code => {
        throw new Error('Progress window exited before becoming ready: ' + code + '\n' + output + '\n' + errors);
      })]);
      assert.equal(first.type, 'ready');
      write({ stage: 'copy', processedEntries: 2, totalEntries: 4, processedBytes: 1024, totalBytes: 2048 });
      // The helper must keep updating while its owner's event loop is blocked.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
      assert.equal(fs.readFileSync(path.join(root, 'responsive'), 'utf8'), 'yes');
      child.send('cancel');
      assert.equal(await closed, 0, output + '\n' + errors);
      assert.match(output, /PASS: independent migration window/);
      console.log(output.trim());
    } finally { clearTimeout(timeout); }
  } finally {
    if (child && child.exitCode === null) child.kill();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-directory-progress-'));
    removeTree(root);
  }
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
