'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RemoteGuard, PROTOCOL_VERSION } = require('../src/main/remote/guard');
const { removeTree } = require('./test-fs.cjs');

function harness(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-guard-'));
  context.after(() => removeTree(root));
  const executable = path.join(root, 'camellia-remote-guard.exe');
  const app = path.join(root, 'Camellia.exe');
  fs.writeFileSync(executable, 'guard');
  fs.writeFileSync(app, 'app');
  const spawns = [];
  let autoStart = false;
  let clock = 1_800_000_000_000;
  const blocker = {
    id: 0,
    start() { this.id++; return this.id; },
    stop() {},
    isStarted() { return true; },
  };
  const guard = new RemoteGuard({
    directory: path.join(root, 'guard'),
    executable,
    appCommand: { executable: app, args: ['--background'], cwd: root },
    setAutoStart: value => { autoStart = value; },
    getAutoStart: () => autoStart,
    powerSaveBlocker: blocker,
    now: () => clock,
    spawnProcess(executablePath, args, options) {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; };
      child.unref = () => { child.unreferenced = true; };
      spawns.push({ executable: executablePath, args, options, child });
      return child;
    },
  });
  context.after(() => guard.close());
  return {
    guard, root, executable, app, spawns, blocker,
    advance(ms) { clock += ms; },
    autoStart: () => autoStart,
  };
}

test('enabling the guard writes launch state, starts login recovery and pauses explicitly', async context => {
  const state = harness(context);
  assert.equal(state.guard.enable(), true);
  await state.guard.ensureStarted();
  await state.guard.heartbeatWrite;
  assert.equal(state.autoStart(), true);
  assert.equal(state.blocker.id, 1);
  assert.equal(state.spawns.length, 1);
  assert.equal(state.spawns[0].executable, state.executable);
  assert.deepEqual(state.spawns[0].args, [state.guard.specFile]);
  assert.equal(state.spawns[0].options.detached, true);
  assert.equal(state.spawns[0].options.windowsHide, true);
  assert.equal(state.spawns[0].child.unreferenced, true);

  const spec = JSON.parse(fs.readFileSync(state.guard.specFile, 'utf8'));
  assert.equal(spec.version, PROTOCOL_VERSION);
  assert.equal(spec.app, state.app);
  assert.deepEqual(spec.args, ['--background']);
  assert.equal(spec.cwd, state.root);
  assert.equal(spec.heartbeat, state.guard.heartbeatFile);
  assert.equal(spec.stop, state.guard.stopFile);
  assert.equal(spec.status, state.guard.statusFile);

  const heartbeat = JSON.parse(fs.readFileSync(state.guard.heartbeatFile, 'utf8'));
  assert.deepEqual(heartbeat, { version: PROTOCOL_VERSION, pid: process.pid, at: 1_800_000_000_000 });

  fs.writeFileSync(state.guard.statusFile, JSON.stringify({
    product: 'camellia-remote-guard', version: PROTOCOL_VERSION, pid: 4242,
    at: 1_800_000_000_000, state: 'monitoring', launches: 0,
  }));
  state.advance(1000);
  assert.equal(state.guard.view().running, true);

  state.guard.disable();
  assert.equal(state.autoStart(), false);
  assert.equal(state.guard.enabled(), false);
  assert.equal(state.blocker.id, 1);
  assert.equal(fs.existsSync(state.guard.stopFile), true);
  assert.equal(fs.existsSync(state.guard.heartbeatFile), false);
  assert.equal(state.spawns[0].child.killed, true);
});

test('a missing helper or launch command is rejected without enabling the preference', async context => {
  const state = harness(context);
  fs.unlinkSync(state.executable);
  assert.throws(() => state.guard.enable(), /helper is missing/);
  assert.equal(fs.existsSync(state.guard.settingsFile), false);

  fs.writeFileSync(state.executable, 'guard');
  state.guard.appCommand = { executable: state.app, args: [1], cwd: state.root };
  assert.throws(() => state.guard.enable(), /launch details are unavailable/);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.guard.settingsFile, 'utf8')),
    { version: PROTOCOL_VERSION, enabled: false });
});

test('an explicit pause is idempotent and does not rewrite the stop marker', async context => {
  const state = harness(context);
  state.guard.enable();
  await state.guard.ensureStarted();
  state.guard.pause();
  const marker = fs.statSync(state.guard.stopFile).mtimeMs;
  state.advance(10_000);
  state.guard.pause();
  assert.equal(fs.statSync(state.guard.stopFile).mtimeMs, marker);
  assert.equal(state.spawns.length, 1);
});
