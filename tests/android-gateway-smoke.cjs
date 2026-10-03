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
    createGoalBridge: async options => ({ call: options.call, close() {} }),
    drivers: Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model: 'fixture' }), ensure() { throw new Error('No real engines in this test'); } }])) });
  const access = new RemoteAccess({ file: path.join(root, 'devices.json'), onRevoke: id => gateway.revoke(id) });
  const reader = new RemoteReadModel(manager);
  const commands = new RemoteCommands({ file: path.join(root, 'commands.json'), access, reader, publish: () => gateway.publish() });
  // The phone must hold full-device control to read the desktop API keys, so
  // the fixture pairs the same way the production panel does.
  const apiKeys = { format: 'camellia-api-routes', version: 2, exportedAt: new Date().toISOString(),
    config: { enabled: true, port: 8788, providers: [{ id: 'fixture', type: 'custom', name: 'Fixture provider', baseUrl: 'https://api.example.com/v1',
      protocol: 'openai', models: [{ id: 'fixture-model', upstream: 'fixture-model' }], keys: [{ id: 'key-1', name: 'Fixture', key: 'fixture-secret', enabled: true }] }] } };
  gateway = new RemoteGateway({ access, reader, commands, apiRoutes: () => structuredClone(apiKeys), validateHost: host => host === '127.0.0.1' });
  const invitation = access.invite(['fixture'], { allWorkspaces: true, includeUnassigned: true });
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
  const artifactBytes = Buffer.alloc(192 * 1024);
  for (let index = 0; index < artifactBytes.length; index++) artifactBytes[index] = index % 251;
  fs.writeFileSync(path.join(root, '手机产物.pdf'), artifactBytes);
  manager.append(conversation, { role: 'assistant', text: '`手机产物.pdf`' });
  fs.writeFileSync(path.join(root, '手机搜索结果.txt'), 'remoteautomationneedle: verified on the desktop');
  // Exercise the production control state machine without letting this fixture
  // start a model. The goal timer is controlled; remote resume must arm it once.
  const goal = manager.goalFor(conversation.id);
  let goalSchedules = 0;
  goal.setTimer = () => { goalSchedules++; return {}; }; goal.clearTimer = () => {};
  assert.equal((await manager.command('codex', 'goal-start', { sessionId: conversation.id, objective: 'Android automation fixture' })).ok, true);
  goal.setPhase('paused');
  const task = manager.tasks.create(conversation.id, 'codex', { instruction: 'Inspect fixture logs', intervalMinutes: 1440 });
  manager.tasks.action(task.id, conversation.id, 'pause');
  const download = gateway.download.bind(gateway);
  let downloads = 0;
  gateway.download = async (...args) => {
    if (++downloads >= 2) await new Promise(resolve => setTimeout(resolve, 1800));
    return download(...args);
  };
  let sent = 0, answered = 0, stopped = 0;
  manager.drivers.codex.ensure = () => ({ gen: 72, sendUserMessage() {
    sent++;
    manager.active.get(conversation.id).permissions.set('fixture-approval', { requestId: 'fixture-approval', toolName: 'Test shell', input: { command: 'echo fixture' } });
    return true;
  }, answerPermission() { answered++; return true; }, interrupt() { stopped++; } });
  const subscribe = gateway.subscribe.bind(gateway);
  let listSubscriptions = 0;
  let addedConversation, listChanges = 0;
  const handle = gateway.handle.bind(gateway);
  gateway.handle = async (request, response) => {
    // The phone acknowledges each observed list before advancing the fixture.
    // Fixed timers race SSE delivery, HTTP reads and UI rendering on CI hosts.
    if (request.method === 'POST' && ['/fixture/list/add', '/fixture/list/remove'].includes(request.url)) {
      access.authenticate(String(request.headers.authorization || '').slice(7));
      request.resume();
      if (request.url.endsWith('/add')) {
        assert.equal(addedConversation, undefined);
        addedConversation = manager.create('codex', 'fixture', listSubscriptions >= 3 ? 'Legacy desktop conversation' : 'Desktop-created conversation');
      } else {
        assert.ok(addedConversation);
        manager.purge(addedConversation.id); addedConversation = undefined;
      }
      listChanges++;
      gateway.json(response, 200, { ok: true });
      return;
    }
    return handle(request, response);
  };
  gateway.subscribe = (response, device, id) => {
    if (!id && ++listSubscriptions >= 3) {
      gateway.json(response, 404, { error: 'Endpoint not found' });
      return;
    }
    subscribe(response, device, id);
    if (!id) return;
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
      // Includes background downloads, UI transitions and a 22s legacy poll;
      // leave headroom for the same bounded phases on shared CI runners.
      const timeout = setTimeout(() => process.kill(), 120_000);
      process.on('error', reject); process.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /OK \(1 test\)/, result.output);
    assert.equal(sent, 1); assert.equal(answered, 1); assert.equal(stopped, 1);
    assert.equal(goalSchedules, 2, 'Initial goal plus one deduplicated remote resume');
    assert.equal(goal.view(), null, 'Remote clear must clear the goal');
    assert.equal(manager.tasks.get(task.id, conversation.id).status, 'cancelled');
    assert.equal(listSubscriptions, 3, 'Unsupported list streams must not be retried during polling');
    assert.equal(listChanges, 5, 'Stream, list UI and legacy polling must observe each desktop change');
    console.log('PASS Android ↔ desktop gateway: goal/task pause, resume and cancellation; content search/download and retry deduplication; rename/pin/batch delete with stale-state rejection; artifact downloads, live list sync, legacy polling, send deduplication, approval, stop, history, SSE and revocation');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    // A crashed emulator must not prevent closing the host server, or the
    // original test failure leaves Node (and the CI job) alive indefinitely.
    try {
      if (ruleAdded) { const undo = [...rule]; undo[2] = '-D'; command(['shell', 'iptables', ...undo]); }
      command(['reverse', '--remove', 'tcp:43128']);
    } catch (error) { console.error('ADB cleanup failed: ' + error.message); }
    await gateway.stop(); manager.closeGoalTools(); manager.pauseGoals(); removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
