'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { launchSession, runLaunch } = require('../src/cli/launch');

test('one terminal guides login, invitation and approval without trusting device names', async () => {
  const calls = [], output = [];
  let running = false, pending = false, approved = false;
  const state = () => ({ running, address: 'http://100.80.1.2:43127', network: { state: running ? 'Running' : 'NeedsLogin', loginUrl: 'https://login.tailscale.com/a/test' }, devices: approved ? [{ name: 'HP' }] : [], pending: pending && !approved ? [{ id: 'request-1', name: 'HP\x1b[31m' }] : [] });
  const answers = ['', '', '1', 'NO', '1', 'YES', 'q'];
  await launchSession({ owned: true, write: value => output.push(value),
    ask: async () => { const answer = answers.shift(); if (!running) running = true; else pending = true; return answer; },
    request: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'approve') approved = true;
      return { ok: true, result: action === 'invite' ? { code: 'a'.repeat(24) } : state() };
    },
  });
  assert.equal(calls.filter(call => call.action === 'start').length, 1);
  assert.equal(calls.filter(call => call.action === 'invite').length, 1);
  assert.deepEqual(calls.filter(call => call.action === 'approve').map(call => call.payload), [{ id: 'request-1' }]);
  assert.ok(output.join('').includes('https://login.tailscale.com/a/test'));
  assert.ok(output.join('').includes('名称不是身份证明'));
  assert.ok(output.join('').includes('检查授权'));
  assert.equal(output.join('').includes('\x1b'), false);
});

test('paired server does not rotate invites and EOF never approves a pending request', async () => {
  const calls = [];
  await launchSession({ owned: false, language: 'en', ask: async () => null, write: () => {}, request: async action => {
    calls.push(action); return { ok: true, result: { running: true, network: { state: 'Running' }, devices: [{ name: 'HP' }], pending: [{ id: 'untrusted', name: 'HP' }] } };
  } });
  assert.deepEqual(calls, ['state']);
});

function streams() {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true;
  output.resume(); return { input, output, signals: new EventEmitter() };
}

test('launch owns exactly one host and control socket and closes both on return', async () => {
  const calls = [], io = streams();
  await runLaunch({ dataDir: '/test' }, { ...io,
    connect: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    createHost: () => { calls.push('host'); return { command: async () => ({ ok: true }), close: async () => calls.push('close-host') }; },
    listen: async () => { calls.push('listen'); return { close: async () => calls.push('close-control') }; },
    session: async ({ owned, request }) => { assert.equal(owned, true); assert.equal((await request()).ok, true); },
  });
  assert.deepEqual(calls, ['host', 'listen', 'close-control', 'close-host']);
  assert.equal(io.signals.listenerCount('SIGTERM'), 0);
});

test('launch attaches to an existing service without acquiring a second host or stopping it', async () => {
  const io = streams();
  await runLaunch({ dataDir: '/test' }, { ...io, connect: async () => ({ ok: true }),
    createHost: () => assert.fail('Must not create another host'), listen: () => assert.fail('Must not replace socket'),
    session: async ({ owned }) => assert.equal(owned, false),
  });
});

test('launch leaves unreachable or busy services alone and cleans up failed new hosts', async () => {
  for (const reply of [Object.assign(new Error('Access denied'), { code: 'EACCES' }), { ok: false, error: 'Busy' }]) {
    await assert.rejects(runLaunch({ dataDir: '/test' }, { ...streams(), connect: async () => { if (reply instanceof Error) throw reply; return reply; }, createHost: () => assert.fail('Must not start another service') }), /Access denied|Busy/);
  }
  let closed = false;
  await assert.rejects(runLaunch({ dataDir: '/test' }, { ...streams(), connect: async () => { throw Object.assign(new Error('missing'), { code: 'ECONNREFUSED' }); },
    createHost: () => ({ command: () => {}, close: async () => { closed = true; } }), listen: async () => { throw new Error('Socket failed'); },
  }), /Socket failed/);
  assert.equal(closed, true);
});

test('noninteractive launch fails before touching server storage', async () => {
  await assert.rejects(runLaunch({}, { input: {}, output: {}, createHost: () => assert.fail('No host') }), /interactive terminal/);
});

test('interrupting the initial state read prevents a late network startup', async () => {
  let stopped = false;
  const calls = [];
  await launchSession({ isClosed: () => stopped, write: () => {}, ask: () => assert.fail('Closed terminal must not prompt'), request: async action => {
    calls.push(action); stopped = true; return { ok: true, result: { running: false, network: { state: 'Stopped' } } };
  } });
  assert.deepEqual(calls, ['state']);
});

test('launch uses the real host and socket, and releases the data lock after exiting', async context => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { requestControl, socketPath } = require('../src/cli/local-control');
  const { removeTree } = require('./test-fs.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-host-'));
  context.after(() => removeTree(root));
  const network = { snapshot: { state: 'Stopped' }, async stop() {} };
  const options = { dataDir: root, networkFactory: () => network, driverFactory: () => ({ dsh: { settings: () => ({}), async shutdown() {} } }) };
  for (let attempt = 0; attempt < 2; attempt++) {
    await runLaunch(options, { ...streams(), session: async ({ request, owned }) => {
      assert.equal(owned, true);
      assert.equal((await request('state')).ok, true);
      assert.equal((await requestControl(root, 'state')).result.running, false);
      assert.equal(fs.existsSync(path.join(root, 'server.lock')), true);
    } });
    assert.equal(fs.existsSync(path.join(root, 'server.lock')), false);
    assert.equal(fs.existsSync(socketPath(root)), false);
  }
});

test('SIGTERM during the wizard cancels the question and closes only the owned host', async () => {
  const io = streams(); let closed = false;
  await runLaunch({ dataDir: '/test' }, { ...io, connect: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    createHost: () => ({ command: async () => ({}), close: async () => { closed = true; } }), listen: async () => ({ close: async () => {} }),
    session: async ({ ask }) => { const answer = ask('Test'); io.signals.emit('SIGTERM'); assert.equal(await answer, null); },
  });
  assert.equal(closed, true);
});
