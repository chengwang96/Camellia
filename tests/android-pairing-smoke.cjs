'use strict';

// Uses the production gateway and access store against a disposable emulator.
// Only transport and desktop approval are fixtures; no user gateway is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteGateway } = require('../src/main/remote/gateway');

async function main() {
  const adb = process.env.ADB || 'adb', serial = process.env.ANDROID_SERIAL;
  assert.match(serial || '', /^emulator-\d+$/, 'Select a disposable emulator explicitly');
  function command(args) {
    const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  }
  assert.match(command(['shell', 'id']), /uid=0/, 'The disposable emulator must run adb root');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-pairing-'));
  const timers = [], counts = new Map();
  const access = new RemoteAccess({ file: path.join(root, 'devices.json') });
  const request = access.request.bind(access);
  access.request = payload => {
    assert.equal(payload.code, '00112233445566778899aabb');
    assert.ok(['Pairing scan fixture', 'Pairing retry fixture'].includes(payload.name));
    const count = (counts.get(payload.name) || 0) + 1; counts.set(payload.name, count);
    if (payload.name === 'Pairing retry fixture' && count === 1) throw Object.assign(new Error('Fixture temporary failure'), { status: 503 });
    const invitation = access.invite([], { allWorkspaces: true, includeUnassigned: true, computerName: 'Pairing test desktop' });
    const pending = request({ ...payload, code: invitation.code });
    timers.push(setTimeout(() => access.approve(pending.id), 900));
    return pending;
  };
  const reader = { manager: { remoteEngines: [] }, workspaces: () => [],
    list: () => ({ conversations: [], nextOffset: null }), listSnapshot: () => ({ listVersion: 'pairing-fixture', conversations: [] }) };
  const gateway = new RemoteGateway({ access, reader, commands: null, validateHost: host => host === '127.0.0.1' });
  const rule = ['-t', 'nat', '-A', 'OUTPUT', '-d', '100.64.0.1', '-p', 'tcp', '--dport', '43129', '-j', 'DNAT', '--to-destination', '127.0.0.1:43129'];
  let added = false;
  try {
    await gateway.start('127.0.0.1', 43129); gateway.authority = '100.64.0.1:43129'; gateway.url = 'http://' + gateway.authority;
    command(['reverse', 'tcp:43129', 'tcp:43129']); command(['shell', 'iptables', ...rule]); added = true;
    command(['install', '-r', path.resolve('android/app/build/outputs/apk/debug/app-debug.apk')]);
    command(['install', '-r', path.resolve('android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
    command(['shell', 'pm', 'grant', 'app.camellia.mobile', 'android.permission.CAMERA']);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class', 'app.camellia.mobile.PairingFlowTest,app.camellia.mobile.QrScannerTest',
        '-e', 'pairingIntegration', 'true', 'app.camellia.mobile.test/android.test.InstrumentationTestRunner'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += data; process.stdout.write(data); }); child.stderr.on('data', data => { output += data; process.stderr.write(data); });
      const timeout = setTimeout(() => child.kill(), 90000);
      child.on('error', reject); child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output); assert.match(result.output, /OK \(\d+ tests\)/);
    assert.equal(counts.get('Pairing scan fixture'), 1, 'Returning from the scanner must submit exactly once');
    assert.equal(counts.get('Pairing retry fixture'), 2, 'Only the explicit retry may submit again');
    assert.equal(access.devices.length, 2, 'Both flows must claim real gateway credentials');
    console.log('PASS: scan lifecycle, normalized address, duplicate guard, HTTP failure/retry, desktop approval, camera lifecycle and pairing layout');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    try {
      if (added) { const undo = [...rule]; undo[2] = '-D'; command(['shell', 'iptables', ...undo]); }
      command(['reverse', '--remove', 'tcp:43129']);
    } catch (error) { console.error('ADB cleanup failed: ' + error.message); }
    await gateway.stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
