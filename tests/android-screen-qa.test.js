'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

const script = path.resolve(__dirname, '../scripts/check-android-modern-screens.ps1');
const initial = {
  size: '900x2100', density: '420', font: '1.15',
  overlays: { gestural: false, threebutton: true }, commands: [],
};
const fake = `param([string]$s, [Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArguments)
$state = Get-Content -LiteralPath $env:CAMELLIA_ADB_FIXTURE -Raw | ConvertFrom-Json
$command = $CommandArguments -join ' '
$state.commands = @($state.commands) + $command
$global:LASTEXITCODE = 0
if ($env:CAMELLIA_ADB_FAIL -and $command -match $env:CAMELLIA_ADB_FAIL) {
  $global:LASTEXITCODE = 1
  Write-Output 'fixture: rejected configuration'
} else {
  switch -Regex ($command) {
    '^shell getprop ro.kernel.qemu$' { '1'; break }
    '^shell wm size$' { 'Physical size: 1080x2400'; if ($state.size -ne 'reset') { "Override size: $($state.size)" }; break }
    '^shell wm density$' { 'Physical density: 480'; if ($state.density -ne 'reset') { "Override density: $($state.density)" }; break }
    '^shell wm size (.+)$' { $state.size = $Matches[1]; break }
    '^shell wm density (.+)$' { $state.density = $Matches[1]; break }
    '^shell settings get system font_scale$' { $state.font; break }
    '^shell settings put system font_scale (.+)$' { $state.font = $Matches[1]; break }
    '^shell settings delete system font_scale$' { $state.font = 'null'; break }
    '^shell cmd overlay list$' {
      foreach ($mode in @('gestural', 'threebutton')) {
        $mark = if ($state.overlays.$mode) { 'x' } else { ' ' }
        "[$mark] com.android.internal.systemui.navbar.$mode"
      }
      break
    }
    '^shell cmd overlay enable-exclusive --category --user 0 com.android.internal.systemui.navbar.(.+)$' {
      $state.overlays.gestural = $false; $state.overlays.threebutton = $false
      $state.overlays.($Matches[1]) = $true
      break
    }
    '^shell cmd overlay (enable|disable) --user 0 com.android.internal.systemui.navbar.(.+)$' {
      $state.overlays.($Matches[2]) = $Matches[1] -eq 'enable'
      break
    }
    '^shell am instrument ' {
      if ($state.overlays.gestural -eq $state.overlays.threebutton) { $global:LASTEXITCODE = 1; 'Invalid navigation mode' }
      elseif ($env:CAMELLIA_ADB_BAD_TEST) { 'FAILURES!!!' } else { 'OK (1 test)' }
      break
    }
    '^pull ' { 'fixture: screenshots collected'; break }
    default { $global:LASTEXITCODE = 2; "Unexpected command: $command" }
  }
}
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:CAMELLIA_ADB_FIXTURE -Encoding utf8
`;

function run(t, { fail = '', badTest = false, original = initial } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-screen-qa-'));
  t.after(() => removeTree(root));
  const adb = path.join(root, 'fake-adb.ps1'), state = path.join(root, 'state.json'), output = path.join(root, 'results');
  fs.writeFileSync(adb, fake);
  fs.writeFileSync(state, JSON.stringify(original));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Serial', 'emulator-5584', '-Profiles', 'modern-20-9', '-FontScales', '1.3',
    '-NavigationModes', 'gestural', '-OutputDirectory', output, '-AdbPath', adb], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, CAMELLIA_ADB_FIXTURE: state, CAMELLIA_ADB_FAIL: fail, CAMELLIA_ADB_BAD_TEST: badTest ? '1' : '' },
  });
  assert.ifError(result.error);
  const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return { ...result, state: json(state), records: fs.existsSync(path.join(output, 'results.json')) ? json(path.join(output, 'results.json')) : [] };
}

function restored(state, original = initial) {
  for (const key of ['size', 'density', 'font', 'overlays']) assert.deepEqual(state[key], original[key], key);
}

test('Android screen QA selects one navigation mode and restores existing display overrides', { skip: process.platform !== 'win32' }, t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.records.passed ?? result.records[0]?.passed, true);
  assert.ok(result.state.commands.some(command => command.includes('overlay enable-exclusive --category')));
  restored(result.state);
});

test('Android screen QA fails on rejected ADB configuration before instrumentation and restores state', { skip: process.platform !== 'win32' }, t => {
  const result = run(t, { fail: '^shell wm density 480$' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /ADB failed/);
  assert.equal(result.state.commands.some(command => command.startsWith('shell am instrument')), false);
  assert.deepEqual(result.records, []);
  restored(result.state);
});

test('Android screen QA does not report successful verification when screenshots cannot be collected', { skip: process.platform !== 'win32' }, t => {
  const result = run(t, { fail: '^pull ' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.records, []);
  restored(result.state);
});

test('Android screen QA records instrumentation failures and restores unset display preferences', { skip: process.platform !== 'win32' }, t => {
  const original = { ...initial, size: 'reset', density: 'reset', font: 'null' };
  const result = run(t, { badTest: true, original });
  assert.notEqual(result.status, 0);
  assert.equal(result.records.passed ?? result.records[0]?.passed, false);
  assert.equal(result.state.commands.some(command => command.startsWith('pull ')), false);
  restored(result.state, original);
});
