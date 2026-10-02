'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { prepareWindowsJob, recoverWindowsJob } = require('../src/engines/discussions/windows-job');
const { WindowsJobJournal } = require('../src/engines/discussions/windows-job-journal');
const { NativeDiscussionAdapter } = require('../src/engines/discussions/native-adapter');
const { NativeSessionOwnership } = require('../src/engines/discussions/native-ownership');
const { bindingFingerprint } = require('../src/engines/discussions/capabilities');
const { getDiscussionLaunch, buildDiscussionSpec } = require('../src/engines/discussions/native-launch');
const { SessionPool } = require('../src/engines/session-pool');
const { createCodex } = require('../src/engines/codex');
const { removeTree } = require('./test-fs.cjs');

const windows = { skip: process.platform !== 'win32', timeout: 60000 };
const identity = () => ({ runtimeId: randomUUID(), deliveryId: randomUUID(), generation: 2 });
function journalFor(t, dir) {
  if (!dir) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-job-records-')); t.after(() => removeTree(dir)); }
  return new WindowsJobJournal({ dir: path.join(dir, 'jobs') });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(predicate) {
  const end = Date.now() + 10000;
  while (!predicate()) { if (Date.now() >= end) throw new Error('Condition did not become true'); await delay(20); }
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-job-'));
  let supervisor;
  t.after(async () => { await supervisor?.stop().catch(() => {}); removeTree(dir); });
  const journal = journalFor(t, dir);
  supervisor = await prepareWindowsJob({ identity: identity(), journal, ...options });
  const opts = { cwd: dir, env: { SystemRoot: process.env.SystemRoot }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  return { dir, supervisor, opts, journal };
}
function treeScript(dir) {
  const file = path.join(dir, 'tree.cjs');
  fs.writeFileSync(file, `const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const depth = Number(process.argv[2] || 0);
fs.writeFileSync(path.join(__dirname, 'pid-' + depth), String(process.pid));
if (depth < 2) spawn(process.execPath, [__filename, String(depth + 1)], { detached: true, stdio: 'ignore', windowsHide: true });
if (!depth) { process.stdin.resume(); process.stdin.on('data', () => process.exit(0)); }
setInterval(() => fs.writeFileSync(path.join(__dirname, 'beat-' + depth), String(Date.now())), 25);
`);
  return file;
}
async function treePids(dir) {
  await until(() => [0, 1, 2].every(depth => fs.existsSync(path.join(dir, 'beat-' + depth))));
  return [0, 1, 2].map(depth => Number(fs.readFileSync(path.join(dir, 'pid-' + depth), 'utf8')));
}

test('Windows job preserves scoped arguments, environment and protocol output without accepting forged control data', windows, async t => {
  const { supervisor, opts } = await fixture(t);
  const args = ['', 'plain', 'space value', 'slash\\', 'quote"value', 'many\\\\"slashes', '中文 $(not-a-shell)'];
  const source = `let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => { console.log(JSON.stringify({ args: process.argv.slice(1), env: process.env.TASK_JOB_VALUE, data }));
console.log(JSON.stringify({ type: 'stopped', sealed: true, activeProcesses: 0 })); console.error('separate stderr'); });`;
  const proc = supervisor.spawn(process.execPath, ['-e', source, ...args], { ...opts, env: { ...opts.env, TASK_JOB_VALUE: '本轮' } });
  let output = '', errors = ''; proc.stdout.on('data', chunk => output += chunk); proc.stderr.on('data', chunk => errors += chunk);
  const closed = once(proc, 'close'); proc.stdin.end('输入\n' + 'x'.repeat(100000)); await closed;
  const rows = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0], { args, env: '本轮', data: '输入\n' + 'x'.repeat(100000) });
  assert.equal(rows[1].type, 'stopped'); assert.match(errors, /separate stderr/);
  const proof = await supervisor.stop();
  assert.deepEqual({ runtimeId: proof.runtimeId, deliveryId: proof.deliveryId, generation: proof.generation }, supervisor.identity);
  // Windows can add a conhost process to the job. It is contained as well;
  // the proof is zero active processes, not an assumed cumulative count.
  assert.equal(proof.stopped, true); assert.equal(proof.activeProcesses, 0); assert.ok(proof.totalProcesses >= 1);
  assert.equal(proc.exitCode, 0); assert.equal(alive(proof.rootPid), false);
  assert.throws(() => supervisor.spawn(process.execPath, [], opts), /stopped|already used/);
});

test('root exit drains detached children and grandchildren before a stopped proof is returned', windows, async t => {
  const { supervisor, opts, dir } = await fixture(t);
  const proc = supervisor.spawn(process.execPath, [treeScript(dir)], opts);
  const closed = once(proc, 'close'), pids = await treePids(dir);
  assert.ok(pids.every(alive));
  proc.stdin.write('exit-root'); await closed;
  const proof = await supervisor.stop();
  assert.ok(proof.totalProcesses >= 3); assert.equal(proof.activeProcesses, 0);
  assert.ok(pids.every(pid => !alive(pid)));
  const before = [0, 1, 2].map(depth => fs.readFileSync(path.join(dir, 'beat-' + depth), 'utf8'));
  await delay(80);
  assert.deepEqual([0, 1, 2].map(depth => fs.readFileSync(path.join(dir, 'beat-' + depth), 'utf8')), before);
});

test('cancellation terminates an active tree and never permits another process in the same delivery', windows, async t => {
  const controller = new AbortController();
  const { supervisor, opts, dir } = await fixture(t, { signal: controller.signal });
  const proc = supervisor.spawn(process.execPath, [treeScript(dir)], opts);
  proc.on('error', () => {});
  const pids = await treePids(dir);
  controller.abort(); const proof = await supervisor.stop();
  assert.ok(proof.totalProcesses >= 3); assert.ok(pids.every(pid => !alive(pid)));
  assert.strictEqual(await supervisor.stop(), proof);
  assert.throws(() => supervisor.spawn(process.execPath, [], opts), /stopped/);
});

test('failed native creation still seals and confirms the empty job', windows, async t => {
  const { supervisor, opts, dir } = await fixture(t);
  const proc = supervisor.spawn(path.join(dir, 'missing-engine.exe'), [], opts);
  const [error] = await once(proc, 'error'); assert.match(error.message, /supervisor/i);
  const proof = await supervisor.stop();
  assert.equal(proof.activeProcesses, 0); assert.equal(proof.totalProcesses, 0); assert.equal(proof.rootPid, null);
});

test('unexpected supervisor loss kills its tree but cannot be claimed as verified stop', windows, async t => {
  const { supervisor, opts, dir } = await fixture(t);
  const proc = supervisor.spawn(process.execPath, [treeScript(dir)], opts);
  const failure = once(proc, 'error'), pids = await treePids(dir);
  process.kill(supervisor.supervisorPid);
  const [error] = await failure; assert.match(error.message, /without verified stop/);
  await assert.rejects(supervisor.stop(), /without verified stop/);
  await until(() => pids.every(pid => !alive(pid)));
});

test('unused launchers can be stopped and reject ambiguous environments or shell options before spawning', windows, async t => {
  const { supervisor, opts } = await fixture(t);
  for (const patch of [{ shell: true }, { detached: true }, { env: { Path: 'one', PATH: 'two' } },
    { env: { BAD: 'nul\0value' } }, { stdio: 'inherit' }, { cwd: 'relative' }]) {
    assert.throws(() => supervisor.spawn(process.execPath, [], { ...opts, ...patch }), /Invalid/);
  }
  const proof = await supervisor.stop(); assert.equal(proof.totalProcesses, 0);
  assert.throws(() => supervisor.spawn(process.execPath, [], opts), /stopped/);
});

test('preparation refuses an already cancelled delivery', windows, async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareWindowsJob({ identity: identity(), signal: controller.signal }), { name: 'AbortError' });
});

test('stop remains responsive when the engine never reads its full input pipe', windows, async t => {
  const { supervisor, opts } = await fixture(t);
  const proc = supervisor.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], opts);
  await once(proc, 'spawn');
  proc.stdin.on('error', () => {}); proc.stdin.write(Buffer.alloc(1024 * 1024, 120));
  const proof = await supervisor.stop(); assert.equal(proof.activeProcesses, 0); assert.equal(alive(proc.pid), false);
});

test('cancellation while the supervisor is being prepared never returns a reusable launcher', windows, async t => {
  const controller = new AbortController();
  const preparing = prepareWindowsJob({ identity: identity(), journal: journalFor(t), signal: controller.signal });
  controller.abort();
  await assert.rejects(preparing, { name: 'AbortError' });
});

test('an app process disappearing closes the control channel and leaves no supervised descendants', windows, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-job-crash-'));
  const target = treeScript(dir), file = path.join(dir, 'app.cjs'), launchIdentity = identity();
  fs.writeFileSync(file, `const fs = require('node:fs'), path = require('node:path');
const { prepareWindowsJob } = require(${JSON.stringify(require.resolve('../src/engines/discussions/windows-job'))});
const { WindowsJobJournal } = require(${JSON.stringify(require.resolve('../src/engines/discussions/windows-job-journal'))});
(async () => {
  const supervisor = await prepareWindowsJob({ identity: ${JSON.stringify(launchIdentity)}, journal: new WindowsJobJournal({ dir: path.join(__dirname, 'jobs') }) });
  supervisor.spawn(process.execPath, [${JSON.stringify(target)}], { cwd: __dirname, env: { SystemRoot: process.env.SystemRoot }, stdio: ['pipe','pipe','pipe'] }).on('error', () => {});
  fs.writeFileSync(path.join(__dirname, 'helper'), String(supervisor.supervisorPid));
  const timer = setInterval(() => {
    if ([0,1,2].every(depth => fs.existsSync(path.join(__dirname, 'beat-' + depth)))) { clearInterval(timer); process.exit(0); }
  }, 20);
})().catch(error => { console.error(error); process.exit(1); });
`);
  const app = spawn(process.execPath, [file], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; app.stderr.on('data', chunk => errors += chunk);
  t.after(async () => {
    if (app.exitCode === null) app.kill();
    const helper = path.join(dir, 'helper');
    if (fs.existsSync(helper)) { const pid = Number(fs.readFileSync(helper, 'utf8')); if (alive(pid)) process.kill(pid); }
    removeTree(dir);
  });
  const [code] = await once(app, 'close'); assert.equal(code, 0, errors);
  const pids = await treePids(dir), supervisorPid = Number(fs.readFileSync(path.join(dir, 'helper'), 'utf8'));
  await until(() => [...pids, supervisorPid].every(pid => !alive(pid)));
  const proof = await recoverWindowsJob({ identity: launchIdentity, journal: journalFor(t, dir) });
  assert.equal(proof.stopped, true); assert.equal(proof.jobAbsent, true);
});

async function adapterFixture(t, lostHandle = false, badBinding = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-job-adapter-'));
  let supervisor, adapter, proof, root;
  const journal = journalFor(t, dir);
  t.after(async () => { await supervisor?.stop().catch(() => {}); removeTree(dir); });
  const profile = { engine: 'codex', connection: 'api', model: 'fixture-model', thinking: '', contextWindow: 12000 };
  const input = { ...identity(), discussionId: randomUUID(), participantId: randomUUID(), threadId: randomUUID(),
    requestId: 'fixture', nativeId: null, cwd: dir, profile, bindingFingerprint: bindingFingerprint(profile) };
  const file = path.join(dir, 'protocol.cjs'), child = treeScript(dir), nativeId = randomUUID();
  fs.writeFileSync(file, `const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  let result = {};
  if (message.method === 'thread/start') result = { thread: { id: ${JSON.stringify(nativeId)} } };
  if (message.method === 'turn/start') {
    result = { turn: { id: 'turn-1' } };
    spawn(process.execPath, [${JSON.stringify(child)}, '1'], { detached: true, stdio: 'ignore', windowsHide: true });
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(__dirname, 'beat-2'))) return;
      clearInterval(timer);
      send({ method: 'item/completed', params: { threadId: ${JSON.stringify(nativeId)}, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Fixture answer' } } });
      send({ method: 'turn/completed', params: { threadId: ${JSON.stringify(nativeId)}, turn: { id: 'turn-1', status: 'completed' } } });
    }, 20);
  }
  send({ id: message.id, result });
});
process.stdin.on('end', () => process.exit(0));
`);
  const state = {};
  const codex = createCodex({ dataDir: dir, loadConfig: () => state, saveConfig: patch => Object.assign(state, patch),
    getModels: () => [profile.model], runtimes: () => ({ locate: () => ({ file: process.execPath }) }),
    onEvent: event => adapter.capture('codex', event), onGoal() {}, log() {} });
  const driver = lostHandle ? { sessions: new SessionPool(), ensure(opts) {
    const scope = getDiscussionLaunch(opts, 'codex'), spec = buildDiscussionSpec(scope, {}, opts.settings);
    root = scope.spawn(spec.exe, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    throw new Error('Lost native handle after process launch');
  } } : { sessions: codex.sessions, ensure: codex.ensureSession };
  const policy = {
    async prepare({ identity: value, signal }) {
      supervisor = await prepareWindowsJob({ identity: value, journal, signal });
      return { settings: { model: badBinding ? 'wrong-model' : profile.model, connection: 'api', permissionMode: 'plan', thinkingBudget: '', proxyUrl: '', contextWindow: 12000 },
        launch: { spawn: supervisor.spawn, buildSpec: () => ({ exe: process.execPath, args: [file], env: { SystemRoot: process.env.SystemRoot }, cwd: dir }) } };
    },
    async verify() { return true; }, // Protocol fixture only; NOT read-only policy evidence.
    async confirmStopped({ session, identity: value }) {
      assert.equal(value.deliveryId, input.deliveryId);
      if (lostHandle) assert.equal(session, null);
      else assert.strictEqual(driver.sessions.get({ conversationId: input.runtimeId }), session);
      proof = await supervisor.stop(); assert.equal(proof.activeProcesses, 0); return proof;
    },
  };
  adapter = new NativeDiscussionAdapter({ engine: 'codex', driver, policy,
    runtime: { version: 'fixture', policyVersion: 'fixture' }, ownership: new NativeSessionOwnership({ readOwners: () => [] }),
    evidence: () => ({ kind: 'real', reference: 'synthetic-policy-local-process-fixture-only', bindingFingerprint: bindingFingerprint(profile),
      runtimeVersion: 'fixture', policyVersion: 'fixture', mode: 'tool-free', checks: Object.fromEntries([
        'isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'shellRestricted', 'mcpRestricted', 'subagentsRestricted',
        'escalationDisabled', 'conversationControlDisabled', 'toolsDisabled'].map(key => [key, true])) }),
  });
  const handle = adapter.create(input);
  const done = handle.execute({ plan: { prompt: 'Fixture request' }, signal: new AbortController().signal, onEvent: () => true });
  done.catch(() => {});
  return { input, dir, driver, handle, done, get proof() { return proof; }, get root() { return root; }, get supervisor() { return supervisor; } };
}

test('the real driver and native adapter release their pool only after Windows job verification', windows, async t => {
  const h = await adapterFixture(t);
  assert.deepEqual(await h.done, { text: 'Fixture answer' });
  const session = h.driver.sessions.get({ conversationId: h.input.runtimeId });
  const pids = [session.client.proc.pid, ...[1, 2].map(depth => Number(fs.readFileSync(path.join(h.dir, 'pid-' + depth), 'utf8')))];
  assert.ok(pids.every(alive));
  const proof = await h.handle.stop();
  assert.equal(proof.released, true); assert.equal(h.proof.kind, 'windows-job');
  assert.ok(pids.every(pid => !alive(pid))); assert.equal(h.driver.sessions.sessions.size, 0);
});

test('a driver throwing after spawn without returning a handle still drains the supervised job', windows, async t => {
  const h = await adapterFixture(t, true);
  await assert.rejects(h.done, /Lost native handle/);
  const proof = await h.handle.stop();
  assert.equal(proof.released, true); assert.equal(h.proof.kind, 'windows-job'); assert.ok(h.proof.totalProcesses >= 1);
  assert.equal(alive(h.root.pid), false);
});

test('preparation allocating a supervisor must be drained even when its returned binding is rejected', windows, async t => {
  const h = await adapterFixture(t, false, true);
  await assert.rejects(h.done, /changed the member binding/);
  assert.equal(alive(h.supervisor.supervisorPid), true);
  await h.handle.stop();
  assert.equal(h.proof.totalProcesses, 0); assert.equal(alive(h.supervisor.supervisorPid), false);
});

test('fresh recovery state stops an existing tree using OS membership rather than root PID observations', windows, async t => {
  const { supervisor, opts, dir, journal } = await fixture(t);
  const proc = supervisor.spawn(process.execPath, [treeScript(dir)], opts);
  const closed = once(proc, 'close'), pids = await treePids(dir);
  const recovered = await recoverWindowsJob({ identity: supervisor.identity, journal: new WindowsJobJournal({ dir: journal.dir }) });
  await closed;
  assert.equal(recovered.jobAbsent, false); assert.ok(recovered.totalProcesses >= 3);
  assert.equal(recovered.activeProcesses, 0); assert.ok(pids.every(pid => !alive(pid)));
  assert.equal(recovered.released, undefined); // Only the owning coordinator may release its pool.
});

test('recovery permanently seals a prepared delivery before reporting an empty job', windows, async t => {
  const { supervisor, opts, dir, journal } = await fixture(t);
  const proof = await recoverWindowsJob({ identity: supervisor.identity, journal });
  assert.equal(proof.jobAbsent, false); assert.equal(proof.totalProcesses, 0);
  const marker = path.join(dir, 'should-not-run');
  const proc = supervisor.spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker], opts);
  const [error] = await once(proc, 'error'); assert.match(error.message, /sealed/);
  await supervisor.stop(); assert.equal(fs.existsSync(marker), false);
  await assert.rejects(prepareWindowsJob({ identity: supervisor.identity, journal }), /EEXIST/);
  const repeated = await recoverWindowsJob({ identity: supervisor.identity, journal });
  assert.equal(repeated.jobAbsent, true); assert.equal(repeated.activeProcesses, 0);
});

test('recovery of a reservation without a started helper still seals against late initialization', windows, async t => {
  const journal = journalFor(t), input = identity(); journal.reserve(input);
  const proof = await recoverWindowsJob({ identity: input, journal });
  assert.equal(proof.jobAbsent, true); assert.equal(proof.stopped, true);
  assert.equal(fs.readFileSync(journal.read(input).sealFile, 'utf8'), 'sealed\n');
  await assert.rejects(prepareWindowsJob({ identity: input, journal }), /EEXIST/);
});

test('missing or mismatched records cannot release another delivery', windows, async t => {
  const { supervisor, journal } = await fixture(t);
  await assert.rejects(recoverWindowsJob({ identity: { ...supervisor.identity, generation: 99 }, journal }), /does not match/);
  await assert.rejects(recoverWindowsJob({ identity: { ...supervisor.identity, runtimeId: randomUUID() }, journal }), /does not match/);
  await assert.rejects(recoverWindowsJob({ identity: identity(), journal }), /missing|does not match/);
  assert.equal(fs.existsSync(journal.read(supervisor.identity).sealFile), false);
  await supervisor.stop();
});

test('a helper still awaiting initialization cannot launch after another process has sealed recovery', windows, async t => {
  const journal = journalFor(t), input = identity(), record = journal.reserve(input), nonce = randomUUID();
  const bootstrap = "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))) -ReferencedAssemblies System.Web.Extensions; [Camellia.Discussions.WindowsJob]::Run()";
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const helper = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (helper.exitCode === null) helper.kill(); });
  let output = '', errors = ''; helper.stdout.on('data', chunk => output += chunk); helper.stderr.on('data', chunk => errors += chunk);
  helper.stdin.write(fs.readFileSync(require.resolve('../src/engines/discussions/windows-job.cs')).toString('base64') + '\n');
  const proof = await recoverWindowsJob({ identity: input, journal }); assert.equal(proof.jobAbsent, true);
  const marker = path.join(journal.dir, 'late-launch'), closed = once(helper, 'close');
  helper.stdin.end(JSON.stringify({ type: 'initialize', nonce, ...record }) + '\n' + JSON.stringify({ type: 'spawn', nonce,
    exe: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker],
    cwd: journal.dir, env: { SystemRoot: process.env.SystemRoot } }) + '\n');
  const [code] = await closed; assert.equal(code, 0, errors);
  const events = output.trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.type === 'failure' && /sealed/.test(event.message)));
  assert.equal(events.some(event => ['spawned', 'ready'].includes(event.type)), false); assert.equal(fs.existsSync(marker), false);
});

test('damaged launch records fail closed and cannot be replaced with an unrelated reservation', windows, async t => {
  const journal = journalFor(t), input = identity(); journal.reserve(input);
  const paths = journal.paths(input);
  fs.writeFileSync(paths.recordFile, '{ damaged');
  await assert.rejects(recoverWindowsJob({ identity: input, journal }), /Invalid JSON/);
  assert.throws(() => journal.reserve(input), /EEXIST/);
  fs.writeFileSync(paths.recordFile, JSON.stringify({ version: 1, ...input, stopped: true }));
  await assert.rejects(recoverWindowsJob({ identity: input, journal }), /missing|does not match/);
  fs.writeFileSync(paths.recordFile, 'x'.repeat(4097));
  await assert.rejects(recoverWindowsJob({ identity: input, journal }), /invalid/);
  assert.equal(fs.existsSync(paths.sealFile), false);
});
