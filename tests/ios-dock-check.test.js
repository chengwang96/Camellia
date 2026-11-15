'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeTree } = require('./test-fs.cjs');

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 });
const pythonFile = python.status === 0 ? python.stdout.trim() : null;
const shellPath = file => file.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
const passed = { version: 1, verdict: 'PASS', checks: 140, failures: [] };

for (const scenario of [
  { name: 'fresh complete verdict survives truncated stdout', payload: passed, status: 0, write: true, pass: true },
  { name: 'old PASS and a console PASS cannot replace a fresh result', payload: passed, status: 0, write: false, pass: false },
  { name: 'incomplete checks fail', payload: { ...passed, checks: 139 }, status: 0, write: true, pass: false },
  { name: 'recorded assertion failures fail', payload: { ...passed, failures: ['layout mismatch'] }, status: 0, write: true, pass: false },
  { name: 'malformed result fails', payload: '{partial', status: 0, write: true, pass: false },
  { name: 'nonzero app exit cannot be hidden by a PASS file', payload: passed, status: 1, write: true, pass: false },
  { name: 'launch timeout cannot be hidden by a PASS file', payload: passed, status: 142, write: true, pass: false },
]) {
  test('iOS dock result protocol: ' + scenario.name, t => {
    if (!fs.existsSync(bash) || !pythonFile) return t.skip('Bash and Python 3 are required');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-dock-protocol-'));
    t.after(() => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('camellia-dock-protocol-'));
      removeTree(root);
    });
    const ios = path.join(root, 'ios'), bin = path.join(root, 'bin');
    const container = path.join(root, 'container'), temporary = path.join(root, 'temporary');
    for (const dir of [path.join(ios, 'DockCheck'), bin, path.join(container, 'Documents'), temporary]) fs.mkdirSync(dir, { recursive: true });
    const script = path.join(ios, 'check-dock.sh'), payload = path.join(root, 'payload.json');
    const bashEnvironment = path.join(root, 'bash-env.sh');
    fs.copyFileSync(path.join(__dirname, '../ios/check-dock.sh'), script);
    fs.writeFileSync(path.join(ios, 'DockCheck/Info.plist'), '<plist/>');
    fs.writeFileSync(payload, typeof scenario.payload === 'string' ? scenario.payload : JSON.stringify(scenario.payload));
    // A previous successful launch is always present before the real script.
    fs.writeFileSync(path.join(container, 'Documents/dock-result.json'), JSON.stringify(passed));
    // Advance the bounded polling loop without forking a fake sleep process
    // one hundred times on Windows. This changes no verdict/launch behavior.
    fs.writeFileSync(bashEnvironment, 'sleep() { :; }\n');
    const command = (name, source) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + source + '\n', { mode: 0o755 });
    for (const name of ['swiftc', 'codesign']) command(name, 'exit 0');
    command('perl', 'shift 3; exec "$@"');
    command('python3', 'exec "$FIXTURE_PYTHON" "$@"');
    command('xcrun', `
      case "$1:$2" in
        --sdk:iphonesimulator) printf '/fixture-sdk\\n' ;;
        simctl:install) exit 0 ;;
        simctl:get_app_container) printf '%s\\n' "$FIXTURE_CONTAINER" ;;
        simctl:launch)
          if [ "$FIXTURE_WRITE" = 1 ]; then cp "$FIXTURE_PAYLOAD" "$FIXTURE_CONTAINER/Documents/dock-result.json"; fi
          if [ "$FIXTURE_WRITE" = 0 ]; then
            echo 'PASS: 140 chat-dock layout/pixel assertions; controlled hosting, not touch input'
          else echo 'DOCK FRAME: console detached before final verdict'; fi
          exit "$FIXTURE_STATUS" ;;
        simctl:io|simctl:spawn) exit 0 ;;
        *) echo 'Unexpected xcrun call' >&2; exit 2 ;;
      esac
    `);
    const tools = process.platform === 'win32' ? ['C:/Program Files/Git/usr/bin', 'C:/Program Files/Git/mingw64/bin'] : ['/usr/bin', '/bin'];
    const result = spawnSync(bash, [script], { windowsHide: true, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, BASH_ENV: shellPath(bashEnvironment), PATH: [bin, ...tools, process.env.PATH].join(path.delimiter),
        TMPDIR: shellPath(temporary), CAMELLIA_DOCK_UDID: 'fixture-simulator', FIXTURE_CONTAINER: shellPath(container),
        FIXTURE_PYTHON: shellPath(pythonFile), FIXTURE_PAYLOAD: shellPath(payload),
        FIXTURE_WRITE: scenario.write ? '1' : '0', FIXTURE_STATUS: String(scenario.status) } });
    assert.ifError(result.error);
    assert.equal(result.status === 0, scenario.pass, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, new RegExp('verdict: ' + (scenario.pass ? 'PASS' : 'FAIL')));
    if (!scenario.write) assert.equal(fs.existsSync(path.join(container, 'Documents/dock-result.json')), false);
  });
}
