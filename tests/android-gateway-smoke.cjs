'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteReadModel } = require('../src/main/remote/read-model');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { RemoteCommands } = require('../src/main/remote/commands');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  const adb = process.env.ADB || 'adb';
  const serial = process.env.ANDROID_SERIAL;
  assert.ok(/^emulator-\d+$/.test(serial || ''), 'Use an explicitly selected, rooted, disposable emulator');
  function command(args) {
    const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  }
  assert.match(command(['shell', 'id']), /uid=0/, 'Run adb root on the disposable emulator first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-android-gateway-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  let config = { sharedMeta: { workspaces: [{ id: 'fixture', name: 'Android fixture', path: root }] } }, gateway;
  const timers = [];
  const manager = new SharedConversations({ dir: path.join(root, 'conversations'), loadConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; }, onEvent: () => gateway?.publish(),
    drivers: Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model: 'fixture' }), ensure() { throw new Error('No real engines in this test'); } }])) });
  const access = new RemoteAccess({ file: path.join(root, 'devices.json'), onRevoke: id => gateway.revoke(id) });
  const reader = new RemoteReadModel(manager);
  const commands = new RemoteCommands({ file: path.join(root, 'commands.json'), access, reader, publish: () => gateway.publish() });
  gateway = new RemoteGateway({ access, reader, commands, validateHost: host => host === '127.0.0.1' });
  const invitation = access.invite(['fixture']);
  const requestPairing = access.request.bind(access);
  access.request = payload => {
    assert.equal(payload.code, 'integration-fixture-only');
    const pending = requestPairing({ ...payload, code: invitation.code });
    access.approve(pending.id);
    return pending;
  };
  const conversation = manager.create('codex', 'fixture', 'Android integration');
  manager.append(conversation, { role: 'user', text: 'Fixture question' });
  manager.append(conversation, { role: 'assistant', text: 'Fixture answer' });
  let sent = 0, answered = 0, stopped = 0;
  manager.drivers.codex.ensure = () => ({ gen: 72, sendUserMessage() {
    sent++;
    manager.active.get(conversation.id).permissions.set('fixture-approval', { requestId: 'fixture-approval', toolName: 'Test shell', input: { command: 'echo fixture' } });
    return true;
  }, answerPermission() { answered++; return true; }, interrupt() { stopped++; } });
  const subscribe = gateway.subscribe.bind(gateway);
  let listSubscriptions = 0;
  gateway.subscribe = (response, device, id) => {
    if (!id && ++listSubscriptions >= 3) {
      gateway.json(response, 404, { error: 'Endpoint not found' });
      if (listSubscriptions === 3) timers.push(setTimeout(() => manager.create('codex', 'fixture', 'Legacy desktop conversation'), 200));
      return;
    }
    subscribe(response, device, id);
    if (!id) {
      let added;
      timers.push(setTimeout(() => { added = manager.create('codex', 'fixture', 'Desktop-created conversation'); }, 200));
      timers.push(setTimeout(() => { manager.purge(added.id); }, 1000));
      return;
    }
    timers.push(setTimeout(() => { manager.append(conversation, { role: 'assistant', text: 'Live update from desktop' }); gateway.publish(); }, 200));
    timers.push(setTimeout(() => access.revoke(device.id), 1200));
  };
  const rule = ['-t', 'nat', '-A', 'OUTPUT', '-d', '100.64.0.1', '-p', 'tcp', '--dport', '43128', '-j', 'DNAT', '--to-destination', '127.0.0.1:43128'];
  let ruleAdded = false;
  try {
    await gateway.start('127.0.0.1', 43128);
    gateway.authority = '100.64.0.1:43128'; gateway.url = 'http://' + gateway.authority;
    command(['reverse', 'tcp:43128', 'tcp:43128']);
    command(['shell', 'iptables', ...rule]); ruleAdded = true;
    command(['install', '-r', path.resolve('android/app/build/outputs/apk/debug/app-debug.apk')]);
    command(['install', '-r', path.resolve('android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
    const result = await new Promise((resolve, reject) => {
      const process = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class', 'app.camellia.mobile.GatewayIntegrationTest', '-e', 'gatewayIntegration', 'true',
        'app.camellia.mobile.test/android.test.InstrumentationTestRunner'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      process.stdout.on('data', chunk => { output += chunk; }); process.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => process.kill(), 60_000);
      process.on('error', reject); process.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /OK \(1 test\)/, result.output);
    assert.equal(sent, 1); assert.equal(answered, 1); assert.equal(stopped, 1);
    assert.equal(listSubscriptions, 3, 'Unsupported list streams must not be retried during polling');
    console.log('PASS Android ↔ desktop gateway: live list sync, legacy 404 polling fallback, send deduplication, approval, stop, history, SSE and revocation');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (ruleAdded) { const undo = [...rule]; undo[2] = '-D'; command(['shell', 'iptables', ...undo]); }
    command(['reverse', '--remove', 'tcp:43128']);
    await gateway.stop(); manager.closeGoalTools(); manager.pauseGoals(); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
