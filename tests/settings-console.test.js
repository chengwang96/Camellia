'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settingsSession, terminalText, header, runSettings } = require('../src/cli/settings-console');
const { options } = require('../scripts/camellia-server.cjs');

function fixture(answers, overrides = {}) {
  const calls = [], output = [], prompts = [];
  const state = { language: 'en', dataDir: '/home/user/.local/share/camellia-server', network: { state: 'Running' }, address: 'http://100.80.1.2:43127',
    pending: [{ id: 'pending-id', name: 'My GUI' }], devices: [{ id: 'device-id', name: 'Trusted GUI' }],
    api: { enabled: false, providers: 1, keys: 2, models: ['model-a'] }, engines: [{ id: 'dsh', model: '', permissionMode: 'ask' }], conversationCount: 1, busy: false, ...overrides };
  const request = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'settings') return { ok: true, result: state };
    if (action === 'set-language') state.language = payload.language;
    if (action === 'workspaces') return { ok: true, result: [{ id: 'workspace-id', name: 'Project', path: '/srv/project' }] };
    if (action === 'conversations') return { ok: true, result: [{ title: 'Server conversation', engine: 'dsh', workspaceName: 'Project' }] };
    if (action === 'invite') return { ok: true, result: { address: state.address, code: 'a'.repeat(24), expiresAt: 1800000000000 } };
    if (action === 'start') state.network = { state: 'NeedsLogin', loginUrl: 'https://login.tailscale.com/a/test' };
    return { ok: true };
  };
  const run = () => settingsSession({ request, ask: async prompt => { prompts.push(prompt); return answers.length ? answers.shift() : null; }, write: text => output.push(text), ascii: true });
  return { run, calls, output, prompts, state };
}

test('live console exits without stopping service or enabling networking', async () => {
  const harness = fixture(['q']); await harness.run();
  assert.deepEqual(harness.calls.map(call => call.action), ['settings']);
  assert.match(harness.output.join(''), /Camellia/);
  assert.match(harness.output.join(''), /Live data/);
  assert.match(harness.output.join(''), /server keeps running/);
  assert.doesNotMatch(harness.output.join(''), /DESIGN PREVIEW|demo data/i);
});

test('pairing approval requires an explicit confirmation and is bound to the displayed request', async () => {
  const cancelled = fixture(['1', '5', '1', 'no', 'q']); await cancelled.run();
  assert.ok(!cancelled.calls.some(call => call.action === 'approve'));
  const approved = fixture(['1', '5', '1', 'YES', 'q']); await approved.run();
  assert.deepEqual(approved.calls.find(call => call.action === 'approve').payload, { id: 'pending-id' });
  assert.match(approved.output.join(''), /full control.*future/);
  assert.match(approved.output.join(''), /My GUI \[pending-id\]/);
});

test('network menu starts login and displays the returned link, invitation is explicit', async () => {
  const harness = fixture(['1', '2', '1', '4', 'YES', 'q']); await harness.run();
  assert.equal(harness.calls.filter(call => call.action === 'start').length, 1);
  assert.equal(harness.calls.filter(call => call.action === 'invite').length, 1);
  assert.match(harness.output.join(''), /https:\/\/login.tailscale.com\/a\/test/);
  assert.match(harness.output.join(''), /Single-use code/);
  assert.match(harness.output.join(''), /a{24}/);
});

test('API menu applies only confirmed settings and never displays raw configuration', async () => {
  const harness = fixture(['2', '1', 'YES', '2', '2', '1', '1', 'YES', 'q'], {
    api: { enabled: false, providers: 1, keys: 2, models: ['model-a'], secret: 'NEVER-PRINT-RAW-KEY' },
  });
  await harness.run();
  assert.deepEqual(harness.calls.find(call => call.action === 'set-api-enabled').payload, { enabled: true });
  assert.deepEqual(harness.calls.find(call => call.action === 'set-model').payload, { engine: 'dsh', model: 'model-a' });
  assert.doesNotMatch(harness.output.join(''), /NEVER-PRINT-RAW-KEY/);
  assert.match(harness.output.join(''), /Subscription identity stays on this server/);
});

test('workspace removal describes file preservation and only sends selected workspace ID', async () => {
  const harness = fixture(['3', '2', '1', 'YES', 'q']); await harness.run();
  assert.deepEqual(harness.calls.find(call => call.action === 'delete-workspace').payload, { id: 'workspace-id' });
  assert.match(harness.output.join(''), /Keep project files/);
  assert.match(harness.output.join(''), /\/srv\/project/);
});

test('EOF during confirmation never submits a destructive command', async () => {
  const harness = fixture(['1', '7', '1']); await harness.run();
  assert.ok(!harness.calls.some(call => call.action === 'revoke'));
});

test('language preference updates the next rendered menu', async () => {
  const harness = fixture(['4', '1', 'q']); await harness.run();
  assert.deepEqual(harness.calls.find(call => call.action === 'set-language').payload, { language: 'zh-CN' });
  assert.match(harness.output.join(''), /服务器实时设置/);
});

test('server-controlled terminal text cannot inject escapes or bidirectional overrides', async () => {
  assert.equal(terminalText('\x1b[2J\x07\u202eunsafe'), ' [2J  unsafe');
  const harness = fixture(['1', '', 'q'], { devices: [{ id: 'bad\x1b', name: 'bad\u202e\x1b[2J' }] });
  await harness.run();
  assert.doesNotMatch(harness.output.join(''), /\x1b|\u202e/);
  assert.match(header({ color: true }), /\x1b\[38;2;103;158;254m/);
  assert.doesNotMatch(header({ ascii: true, language: 'en' }), /[^\x20-\x7e\n]/);
});

test('live settings requires a TTY and command line parsing validates language', async () => {
  await assert.rejects(runSettings({ input: { isTTY: false }, output: { isTTY: true } }), /interactive terminal/);
  assert.equal(options(['menu', '--lang', 'en', '--ascii']).language, 'en');
  assert.equal(options(['menu', '--ascii']).ascii, true);
  assert.throws(() => options(['menu', '--lang', 'invalid']), /Language/);
  assert.equal(options(['serve', '--hostname', 'gpu-lab-01']).hostname, 'gpu-lab-01');
  assert.throws(() => options(['serve', '--hostname', 'invalid.name']), /hostname/);
});
