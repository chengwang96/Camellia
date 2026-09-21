'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const manifest = require('../package.json');

assert.equal(process.platform, 'win32', 'Run the portable smoke test on Windows');
const root = path.resolve(__dirname, '..');
const artifact = path.resolve(process.argv[2] || path.join(root, 'dist', `${manifest.build.productName}-${manifest.version}-win-x64.zip`));
assert.ok(fs.existsSync(artifact), 'Build the portable ZIP before testing');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-portable-'));
const application = path.join(temporary, 'application');
const script = path.join(temporary, 'smoke.cjs');
const marker = path.join(temporary, 'result.json');

try {
  const extraction = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:CAMELLIA_TEST_ARCHIVE, $env:CAMELLIA_TEST_DIRECTORY)",
  ], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, CAMELLIA_TEST_ARCHIVE: artifact, CAMELLIA_TEST_DIRECTORY: application },
  });
  if (extraction.error) throw extraction.error;
  assert.equal(extraction.status, 0, extraction.stderr || extraction.stdout);
  fs.writeFileSync(script, `
    process.argv[2] = require('node:path').dirname(process.execPath);
    require(${JSON.stringify(path.join(__dirname, 'verify-package.cjs'))});
    require('node:fs').writeFileSync(process.env.CAMELLIA_PORTABLE_TEST_RESULT, JSON.stringify({
      electron: process.versions.electron,
      executable: process.execPath,
    }));
  `);
  const started = Date.now();
  const result = spawnSync(path.join(application, manifest.build.productName + '.exe'), [script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CAMELLIA_PORTABLE_TEST_RESULT: marker },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(report.electron, require('electron/package.json').version);
  assert.equal(path.dirname(report.executable), application);
  console.log(`PASS: portable ZIP extracted; bundled sources verified and Electron started in ${((Date.now() - started) / 1000).toFixed(1)}s after extraction.`);
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('cml-portable-'));
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
