'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { RemoteAccess } = require('../src/main/remote/access');
const { RemoteGateway } = require('../src/main/remote/gateway');
const { RemoteDiscussions } = require('../src/main/remote/discussions');
const { DiscussionService } = require('../src/engines/discussions/service');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const { removeTree } = require('./test-fs.cjs');

async function main() {
  const adb = process.env.ADB || 'adb', serial = process.env.ANDROID_SERIAL;
  assert.match(serial || '', /^emulator-\d+$/, 'Select an explicitly disposable emulator');
  const command = args => {
    const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  };
  assert.match(command(['shell', 'id']), /uid=0/, 'Run adb root on the disposable emulator first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-discussions-'));
  let gateway;
  const calls = [], richAnswers = []; let nativeRun = 0;
  const binding = { engine: 'codex', connection: 'subscription', model: 'fixture-model', accountRef: 'fixture-account', thinking: '', contextWindow: 32000 };
  const adapter = { runtime: { version: 'test', policyVersion: 'test' }, evidence: value => ({ kind: 'real', reference: 'synthetic-test-only',
    bindingFingerprint: bindingFingerprint(value), runtimeVersion: 'test', policyVersion: 'test', mode: 'native-tools', supportsImages: true,
    checks: Object.fromEntries(['isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'permissionsRouted', 'workspaceQueue'].map(key => [key, true])) }),
    create(identity) { let respond, release; const runId = ++nativeRun; return { async execute({ plan, onEvent, signal }) {
      calls.push(plan); onEvent({ ...identity, type: 'started', nativeId: randomUUID() });
      if (plan.prompt.includes('RICH_REQUEST')) {
        assert.equal(plan.attachments.length, 2); assert.equal(fs.readFileSync(plan.attachments[1].path, 'utf8'), 'Mobile document bytes');
        const response = await new Promise(resolve => {
          respond = answer => { richAnswers.push(answer); resolve(answer); return true; }; release = () => resolve({ allow: false });
          signal.addEventListener('abort', release, { once: true });
          onEvent({ ...identity, type: 'permission', permission: { runId, requestId: 'rich-question', toolName: 'Ask', questions: [
            { id: 'single', question: 'Choose a role', options: [{ label: 'Scientist' }, { label: 'Developer' }] },
            { id: 'multi', question: 'Choose formats', multiSelect: true, options: [{ label: 'Text' }, { label: 'Image' }] },
            { id: 'notes', question: 'Add a note' }] } });
        });
        signal.removeEventListener('abort', release); if (!response.allow) return { text: 'Skipped' };
        assert.equal(response.input.single, 'Scientist'); assert.deepEqual(response.input.multi, ['Text', 'Image']); assert.equal(response.input.notes, 'Mobile answer');
        const target = path.join(plan.cwd || identity.cwd || service.manager.get(identity.discussionId).cwd, 'mobile-result.txt');
        fs.writeFileSync(target, 'Confirmed from phone');
        onEvent({ ...identity, type: 'tool', tool: { id: 'write', name: 'Write', input: { path: target }, output: 'Saved', status: 'completed' } });
        return { text: 'Created [mobile-result.txt](mobile-result.txt)' };
      }
      onEvent({ ...identity, type: 'answer', text: 'Reviewing the design…' });
      await new Promise(resolve => setTimeout(resolve, 500));
      return { text: 'A shared host keeps the discussion, member identities and replies in sync.' };
    }, respond(answer) { return respond?.(answer) || false; }, async stop() { release?.(); return { ...identity, stopped: true, released: true }; }, cancel() { release?.(); } }; } };
  const service = new DiscussionService({ dataDir: root, platform: 'win32', getCatalog: () => [{ binding, label: 'Fixture model' }],
    adapters: { codex: adapter }, onEvent: () => gateway?.publish() });
  const access = new RemoteAccess({ file: path.join(root, 'devices.json'), onRevoke: id => gateway?.revoke(id) });
  access.invite([], { allWorkspaces: true }); access.invitation.digest = createHash('sha256').update('discussion-fixture-only').digest('hex');
  const pair = access.request.bind(access);
  access.request = payload => { const pending = pair(payload); access.approve(pending.id); return pending; };
  const remote = new RemoteDiscussions({ file: path.join(root, 'receipts.json'), access, getService: () => service, publish: () => gateway?.publish() });
  gateway = new RemoteGateway({ access, reader: { manager: {}, workspaces: () => [] }, discussions: remote, validateHost: host => host === '127.0.0.1' });
  let droppedReply = false;
  const json = gateway.json.bind(gateway);
  gateway.json = (response, status, payload) => {
    if (!droppedReply && payload.requestId && payload.state === 'pending') { droppedReply = true; response.destroy(); return; }
    json(response, status, payload);
  };
  const rule = ['-t', 'nat', '-A', 'OUTPUT', '-d', '100.64.0.1', '-p', 'tcp', '--dport', '43129', '-j', 'DNAT', '--to-destination', '127.0.0.1:43129'];
  let ruleAdded = false;
  try {
    await gateway.start('127.0.0.1', 43129); gateway.authority = '100.64.0.1:43129'; gateway.url = 'http://' + gateway.authority;
    command(['reverse', 'tcp:43129', 'tcp:43129']); command(['shell', 'iptables', ...rule]); ruleAdded = true;
    command(['install', '-r', path.resolve('android/app/build/outputs/apk/debug/app-debug.apk')]);
    command(['install', '-r', path.resolve('android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class', 'app.camellia.mobile.RemoteDiscussionsTest',
        '-e', 'discussionTheme', process.env.DISCUSSION_THEME || 'light', '-e', 'discussionLanguage', process.env.DISCUSSION_LANGUAGE || 'en',
        '-e', 'discussionIntegration', 'true', 'app.camellia.mobile.test/android.test.InstrumentationTestRunner'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
      const timer = setTimeout(() => child.kill(), 150000);
      child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    console.log(result.output);
    assert.equal(result.code, 0); assert.match(result.output, /OK \(11 tests\)/);
    assert.equal(calls.length, 3); assert.match(calls[0].prompt, /You are a scientist/); assert.doesNotMatch(calls[1].prompt, /You are a scientist/); assert.equal(richAnswers.length, 1);
    assert.equal(droppedReply, true, 'Creation acknowledgement was deliberately lost and recovered by receipt lookup');
    assert.equal(service.list().length, 0);
    console.log('PASS Android UI ↔ production gateway/service: group CRUD, catalog, identity, serial replies, SSE, lost-ack recovery, image/document upload, question answers, and artifact download. Model execution uses isolated fixtures; no subscription calls.');
  } finally {
    try {
      if (ruleAdded) { const undo = [...rule]; undo[2] = '-D'; command(['shell', 'iptables', ...undo]); }
      command(['reverse', '--remove', 'tcp:43129']);
    } catch (error) { console.error('ADB cleanup failed: ' + error.message); }
    await gateway.stop(); await service.shutdown(); removeTree(root);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
