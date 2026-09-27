'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { removeTree } = require('./test-fs.cjs');
const runFile = promisify(execFile);

async function inspectExplorer(target, close = false) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$target = $env:CAMELLIA_REVEAL_TARGET
$shellApp = New-Object -ComObject Shell.Application
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  foreach ($window in @($shellApp.Windows())) {
    try {
      $folder = $window.Document.Folder.Self.Path
      if ($env:CAMELLIA_REVEAL_CLOSE -eq '1') {
        if ($folder.StartsWith($target + '\\', [StringComparison]::OrdinalIgnoreCase)) { $window.Quit() }
      } elseif ($folder -eq [IO.Path]::GetDirectoryName($target)) {
        $selected = @($window.Document.SelectedItems() | ForEach-Object { $_.Path })
        if ($selected -contains $target) {
          @{ folder = $folder; selected = $selected } | ConvertTo-Json -Compress
          exit 0
        }
      }
    } catch {}
  }
  if ($env:CAMELLIA_REVEAL_CLOSE -eq '1') { exit 0 }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)
throw "Explorer did not select the requested file: $target"
`;
  const { stdout } = await runFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    windowsHide: true, timeout: 20000, encoding: 'utf8',
    env: { ...process.env, CAMELLIA_REVEAL_TARGET: target, CAMELLIA_REVEAL_CLOSE: close ? '1' : '0' },
  });
  return close ? null : JSON.parse(stdout.trim());
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
  const root = process.env.CAMELLIA_REVEAL_ROOT;
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('camellia-reveal-native-'));
  app.setPath('userData', path.join(root, 'profile'));
  await app.whenReady();
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('dsh:reveal-file'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  assert.ok(end > start);
  vm.runInNewContext(source.slice(start, end + 6), {
    ipcMain, shell, revealInFileManager: require('../src/main/reveal-file').revealInFileManager,
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL('data:text/html,<title>File reveal verification</title>');
    const reveal = target => window.webContents.executeJavaScript(`window.dshDesktop.revealFile(${JSON.stringify(target)})`);
    const cases = [
      ['plain', 'report.txt'],
      ['folder with spaces', 'report final.txt'],
      ['中文目录', '实验报告.txt'],
      ['outputs, v2 & (draft)', '报告 final, #100% & (draft).txt'],
    ];
    const targets = cases.map(([folder, name]) => {
      const directory = path.join(root, folder);
      fs.mkdirSync(directory);
      const target = path.join(directory, name);
      fs.writeFileSync(target, 'Native file reveal fixture');
      fs.writeFileSync(path.join(directory, 'other.txt'), 'Selection must distinguish this file');
      return target;
    });
    for (let round = 0; round < 2; round++) {
      for (const target of targets) {
        const other = path.join(path.dirname(target), 'other.txt');
        assert.deepEqual(await reveal(other), { ok: true });
        await inspectExplorer(other);
        const input = round === 0 ? target : target.replace(/\\/g, '/');
        assert.deepEqual(await reveal(input), { ok: true });
        const actual = await inspectExplorer(target);
        assert.equal(actual.folder.toLowerCase(), path.dirname(target).toLowerCase());
        assert.deepEqual(actual.selected.map(file => file.toLowerCase()), [target.toLowerCase()]);
        console.log(`PASS native selection round ${round + 1}: ${path.relative(root, target)}`);
      }
    }
    for (const target of [path.join(root, 'missing.txt'), '', null]) {
      const result = await reveal(target);
      assert.equal(result.ok, false);
      assert.match(result.error, /ENOENT|A file path is required/);
    }
    console.log('PASS real preload → IPC → native shell → Explorer folder and selected file; invalid paths return errors');
  } finally {
    await inspectExplorer(root, true);
    window.destroy();
  }
  app.quit();
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP Windows Explorer integration check');
    return;
  }
  if (process.versions.electron) return runElectron();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-native-'));
  const env = { ...process.env, CAMELLIA_REVEAL_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 180000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally { clearTimeout(timer); }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-reveal-native-'));
    await inspectExplorer(root, true);
    removeTree(root);
  }
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
