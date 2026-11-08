'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchKimiHistory, prepareKimiHistory } = require('../src/engines/kimi-native-history');
const { patchDshHistory, prepareDshHistory } = require('../src/engines/dsh-native-history');
const { nativeHistoryModule } = require('../src/engines/native-history-module');
const { removeTree } = require('./test-fs.cjs');

// Minimal native ACP contracts. Tests drive the injected bridge against an
// engine seam; native fork/undo implementations stay owned by the runtime.
const source = `
function createAcpAgentApp(getServer) {
  const prompt = ctx => getServer().prompt(ctx.params, ctx.signal);
  return agent({ name: "kimi-code-acp" });
}
function precheckUndo(history, count) { return check(history, count); }
class NativeSession {
  async undoHistory(count = 1) {}
  async unstable_forkSession(params) {}
  driveTurn(input) {
    return this.driveLaunch(this.agent.prompt({ input }));
  }
  driveLaunch(launch) {
    const driver = {
      settled: false,
\t\t\t\t\tearly: []
    };
    launch.then(launched => {
      if (launched === void 0) {
\t\t\t\t\t\tthis.settleDriver(driver, () => {});
        return;
      }
      driver.turnId = launched.turn_id;
    });
  }
  bindEvents() {
    const events = this.agent.events;
\t\t\tthis.subscriptions.push();
  }
  dispatchTurnEvent(event) {
    const driver = this.driver;
    driver.early.push({ event });
  }
  /** The active driver, but only for events of ITS turn. */
  driverFor(turnId) { return this.driver; }
  onTurnEnded(event) {
    driver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });
  }
  cancel() {
    const driver = this.driver;
    driver.cancelRequested = true;
\t\t\t\tthis.agent.cancel();
  }
}
function runNative() {
\tlet closePromise;
\tconst close = async () => {};
}
`;

async function bridge(check = () => ({ ok: true })) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const RequestError = { invalidParams: (_params, text) => Object.assign(new Error(text), { code: -32602 }) };
  const patched = patchKimiHistory(source);
  assert.ok(patched, 'The native fixture must satisfy both history and queued-prompt contracts');
  const api = await new AsyncFunction('check', 'RequestError$1', 'isUndoAnchor', patched
    + '\nreturn { boundary: camelliaHistoryState, fork: camelliaForkUndo, title: camelliaGenerateTitle };')(
    check, RequestError, message => message.role === 'user');
  api.titleCalls = [];
  return api;
}

function engine() {
  const calls = [], history = [{ role: 'user', content: [{ type: 'text', text: 'Earlier task' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'Instructions\n\n修改请求\u2028🧪' }] },
    { role: 'tool', content: [{ type: 'text', text: 'Discarded output' }] }];
  const server = { calls, history, ensureAuthed: async () => {}, getSession: () => ({}),
    klient: { session: () => ({ agent: () => ({ getContext: async () => ({ history }) }) }) },
    unstable_forkSession: async params => { calls.push(['fork', params.sessionId]); return { sessionId: 'child', configOptions: [] }; },
    camelliaUndo: async id => { calls.push(['undo', id]); },
    closeSession: async params => { calls.push(['close', params.sessionId]); },
    resumeSession: async params => { calls.push(['resume', params]); return { modes: {} }; } };
  return server;
}

test('Kimi bridge forks before native undo, rebinds only child tools, and preserves source history', async () => {
  const api = await bridge(), server = engine(), original = JSON.stringify(server.history);
  const boundary = await api.boundary(server, { sessionId: 'source' });
  assert.equal(boundary.text, 'Instructions\n\n修改请求\u2028🧪');
  const mcpServers = [{ name: 'child-tools' }];
  const result = await api.fork(server, { sessionId: 'source', ...boundary, mcpServers });
  assert.equal(result.sessionId, 'child');
  assert.deepEqual(server.calls, [['fork', 'source'], ['undo', 'child'], ['close', 'child'],
    ['resume', { sessionId: 'child', mcpServers }]]);
  assert.equal(JSON.stringify(server.history), original);
});

test('Kimi bridge delegates compaction refusal before creating or changing a native branch', async () => {
  const api = await bridge(() => ({ ok: false, reason: 'compaction_boundary' })), server = engine();
  assert.deepEqual(await api.boundary(server, { sessionId: 'source' }), { unavailable: 'compaction_boundary' });
  await assert.rejects(api.fork(server, { sessionId: 'source', undoCount: 1, undoDigest: 'a'.repeat(64) }), /compaction/);
  assert.deepEqual(server.calls, []);
});

test('Kimi bridge rejects a stale native boundary and closes a failed undo child without touching its source', async () => {
  const api = await bridge(), server = engine();
  const boundary = await api.boundary(server, { sessionId: 'source' });
  server.history.push({ role: 'user', content: [{ type: 'text', text: 'Newer native turn' }] });
  await assert.rejects(api.fork(server, { sessionId: 'source', ...boundary }), /history changed/);
  assert.deepEqual(server.calls, []);
  const fresh = await api.boundary(server, { sessionId: 'source' });
  server.camelliaUndo = async () => { throw new Error('Native checkpoint unavailable'); };
  await assert.rejects(api.fork(server, { sessionId: 'source', ...fresh }), /checkpoint unavailable/);
  assert.deepEqual(server.calls, [['fork', 'source'], ['close', 'child']]);
});

test('Kimi bridge names an active turn from only the visible user request', async () => {
  const api = await bridge(), server = engine();
  const prompt = '如果机器比较繁忙，点开设置页面可能会卡在这里一段时间，尤其是右上角几个按钮没被半透明灰色遮挡，看起来很有问题';
  server.camelliaTitle = async (_sessionId, visible, force) => {
    api.titleCalls.push({ input: 'user: ' + visible, force }); return '设置页面卡顿与按钮遮挡';
  };
  assert.deepEqual(await api.title(server, { sessionId: 'source', prompt, force: false }), { title: '设置页面卡顿与按钮遮挡' });
  assert.deepEqual(api.titleCalls, [{ input: 'user: ' + prompt, force: false }]);
});

test('unknown native layouts and runtimes retain the compatible path', t => {
  assert.equal(patchKimiHistory(source.replace('function createAcpAgentApp', 'function renamed')), null);
  assert.equal(patchDshHistory('unknown ACP contract', '/host.js'), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-history-bridge-'));
  t.after(() => removeTree(root));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@moonshot-ai/kimi-code', version: '2.1.1' }));
  const runtime = path.join(root, 'dist', 'main.mjs'); fs.writeFileSync(runtime, source);
  assert.equal(prepareKimiHistory(runtime), null);
  assert.equal(prepareDshHistory({ file: path.join(root, 'not-installed.js') }), null);
  for (const version of ['2.4.0', '2.4.1', '2.5.1', '2.5.2']) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@moonshot-ai/kimi-code', version }));
    const patched = prepareKimiHistory(runtime);
    assert.ok(patched, `Kimi ${version} must load the verified ACP bridge`);
    assert.equal(path.dirname(patched), path.dirname(runtime));
    assert.equal(fs.readFileSync(runtime, 'utf8'), source);
    assert.match(fs.readFileSync(patched, 'utf8'), /session\/camellia_fork_undo/);
  }
});

test('native bridge materialization publishes complete files and survives a failed publication', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-history-module-'));
  t.after(() => removeTree(root));
  const original = path.join(root, 'main.mjs'), content = 'export const history = ' + JSON.stringify('🧪'.repeat(40000));
  const file = nativeHistoryModule(original, content);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(nativeHistoryModule(original, content), file);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Directory is read only'), { code: 'EACCES' }); });
  assert.throws(() => nativeHistoryModule(original, 'another complete module'), /read only/);
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

test('pinned DSH history bridge materializes against the installed ACP contract', t => {
  const installed = path.resolve(__dirname, '../runtimes/dsh/node_modules/@deepseek-ai');
  const packages = ['dsh-acp', 'dsh-api-session-controller'];
  if (!packages.every(name => fs.existsSync(path.join(installed, name, 'lib/index.js')))) return t.skip('DSH runtime is not installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-dsh-history-'));
  t.after(() => removeTree(root));
  for (const name of packages) {
    const source = path.join(installed, name), target = path.join(root, 'node_modules/@deepseek-ai', name);
    fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
    fs.copyFileSync(path.join(source, 'lib/index.js'), path.join(target, 'lib/index.js'));
  }
  const runtime = path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, '');
  const acp = path.join(root, 'node_modules/@deepseek-ai/dsh-acp/lib/index.js');
  const original = fs.readFileSync(acp, 'utf8');
  const patched = prepareDshHistory({ file: runtime });
  assert.ok(patched, 'The pinned DSH ACP and Host versions must support native history');
  assert.match(fs.readFileSync(patched, 'utf8'), /session\/camellia_fork/);
  assert.equal(fs.readFileSync(acp, 'utf8'), original, 'The upstream ACP module remains unchanged');
});
