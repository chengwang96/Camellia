'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { execFileSync, spawnSync } = require('node:child_process');
const { startBackgroundProcess } = require('../src/engines/background-process.cjs');
const { windowsExecutionInstructions } = require('../src/engines/windows-execution');
const { removeTree } = require('./test-fs.cjs');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia launch 中文 & % '));
  t.after(() => removeTree(cwd));
  const file = path.join(cwd, 'helper.exe');
  fs.writeFileSync(file, 'not an executable');
  return { file, cwd, logFile: path.join(cwd, 'helper.log'), args: [] };
}

test('Windows targets inherit the hidden worker console with literal paths and arguments', async t => {
  const spec = fixture(t), calls = [];
  spec.args = ['space value', '中文 & %TEMP% ^', 'a"b', 'C:\\folder with spaces\\', ''];
  spec.env = { CAMELLIA_LAUNCH_FIXTURE: 'literal & % value' };
  let unrefed = false;
  const result = await startBackgroundProcess(spec, { platform: 'win32', windowsWorker: true, spawnProcess(file, args, options) {
    calls.push({ file, args, options });
    const child = new EventEmitter(); child.pid = 42; child.unref = () => { unrefed = true; };
    queueMicrotask(() => child.emit('spawn')); return child;
  } });
  assert.deepEqual(result, { pid: 42, logFile: spec.logFile });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, spec.file); assert.deepEqual(calls[0].args, spec.args);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.env.CAMELLIA_LAUNCH_FIXTURE, spec.env.CAMELLIA_LAUNCH_FIXTURE);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(calls[0].options.stdio[1], calls[0].options.stdio[2]);
  assert.equal(unrefed, false);
  assert.throws(() => fs.fstatSync(calls[0].options.stdio[1]), { code: 'EBADF' });
});

test('Windows bootstrap reports the target PID and detaches only the hidden worker', async t => {
  const spec = fixture(t); let called, sent, disconnected = false, unrefed = false;
  const result = await startBackgroundProcess(spec, { platform: 'win32', spawnProcess(file, args, options) {
    called = { file, args, options };
    const worker = new EventEmitter(); worker.pid = 17; worker.connected = true;
    worker.kill = () => assert.fail('A successful worker must remain alive with its target');
    worker.disconnect = () => { disconnected = true; worker.connected = false; };
    worker.unref = () => { unrefed = true; };
    worker.send = (value, callback) => { sent = value; callback(); queueMicrotask(() => worker.emit('message', { pid: 42 })); };
    queueMicrotask(() => worker.emit('spawn')); return worker;
  } });
  assert.deepEqual(result, { pid: 42, logFile: spec.logFile });
  assert.equal(called.file, process.execPath);
  assert.deepEqual(called.args, [path.resolve(__dirname, '../src/engines/background-process.cjs'), '--windows-worker']);
  assert.deepEqual(sent, spec);
  assert.equal(called.options.shell, false); assert.equal(called.options.windowsHide, true);
  assert.equal(called.options.detached, true); assert.equal(called.options.stdio[3], 'ipc');
  assert.equal(disconnected, true); assert.equal(unrefed, true);
  assert.throws(() => fs.fstatSync(called.options.stdio[1]), { code: 'EBADF' });
});

test('Windows worker creation and target errors fail once without returning a bootstrap PID', async t => {
  for (const failure of ['worker', 'target', 'early-exit', 'invalid-pid']) {
    const spec = fixture(t); let calls = 0, killed = false, fd;
    await assert.rejects(startBackgroundProcess(spec, { platform: 'win32', spawnProcess(file, args, options) {
      calls++; fd = options.stdio[1];
      const worker = new EventEmitter(); worker.pid = 17; worker.connected = true;
      worker.kill = () => { killed = true; }; worker.disconnect = () => { worker.connected = false; };
      worker.unref = () => assert.fail('Failed workers cannot detach');
      worker.send = (_spec, callback) => {
        callback(); queueMicrotask(() => worker.emit('message', failure === 'target'
          ? { error: { message: 'invalid executable', code: 'ENOEXEC' } } : { pid: worker.pid }));
      };
      queueMicrotask(() => worker.emit(failure === 'worker' ? 'error' : failure === 'early-exit' ? 'exit' : 'spawn',
        failure === 'worker' ? new Error('worker creation failed') : 1));
      return worker;
    } }), /worker creation failed|invalid executable|exited before startup|Invalid background process PID/);
    assert.equal(calls, 1); assert.equal(killed, true);
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  }
});

test('invalid background launch specs fail before starting a process', async t => {
  const spec = fixture(t);
  for (const patch of [
    { file: '\\\\' }, { file: 'relative.exe' }, { file: path.join(spec.cwd, 'missing.exe') },
    { file: spec.cwd }, { file: path.join(spec.cwd, 'helper.bat') },
    { cwd: spec.file }, { cwd: 'relative' }, { logFile: spec.file },
    { args: 'one command string' }, { args: ['invalid\0argument'] }, { env: { FLAG: 1 } },
  ]) await assert.rejects(startBackgroundProcess({ ...spec, ...patch }, {
    platform: 'win32', spawnProcess() { assert.fail('Invalid specs must never start a process'); },
  }));
  assert.equal(fs.existsSync(spec.logFile), false);
});

test('native creation errors are returned once, close logs, and never fall back to a shell', async t => {
  const spec = fixture(t); let calls = 0, fd;
  await assert.rejects(startBackgroundProcess(spec, { windowsWorker: true, spawnProcess(file, args, options) {
    calls++; fd = options.stdio[1];
    const child = new EventEmitter(); child.unref = () => assert.fail('Failed children cannot detach');
    queueMicrotask(() => child.emit('error', Object.assign(new Error('invalid executable'), { code: 'ENOEXEC' })));
    return child;
  } }), { code: 'ENOEXEC' });
  assert.equal(calls, 1);
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

test('the real Windows CLI reports missing and invalid executables as text', { skip: process.platform !== 'win32' }, t => {
  const spec = fixture(t), launcher = path.resolve(__dirname, '../src/engines/background-process.cjs');
  const specFile = path.join(spec.cwd, 'launch.json');
  for (const file of [path.join(spec.cwd, 'missing.exe'), spec.file]) {
    fs.writeFileSync(specFile, JSON.stringify({ ...spec, file }));
    const result = spawnSync(process.execPath, [launcher, specFile], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Background process failed:/);
    assert.equal(result.stdout, '');
  }
});

test('real background process receives exact argv, writes both log streams and exits', async t => {
  const spec = fixture(t), launcher = path.resolve(__dirname, '../src/engines/background-process.cjs');
  const script = path.join(spec.cwd, 'child.cjs'), resultFile = path.join(spec.cwd, 'argv.json');
  const args = ['space value', '中文 & %TEMP% ^', 'a"b', 'C:\\trailing space\\', ''];
  fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); console.log('stdout captured'); console.error('stderr captured');");
  Object.assign(spec, { file: process.execPath, args: [script, resultFile, ...args] });
  const specFile = path.join(spec.cwd, 'launch.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const result = JSON.parse(execFileSync(process.execPath, [launcher, specFile], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  assert.ok(result.pid > 0);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile) && fs.readFileSync(spec.logFile, 'utf8').includes('stderr captured')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), args);
  const output = fs.readFileSync(spec.logFile, 'utf8');
  assert.match(output, /stdout captured/); assert.match(output, /stderr captured/);
});

test('real Windows grandchildren share a hidden console after the caller exits and the worker cleans up',
  { skip: process.platform !== 'win32' }, async t => {
  const spec = fixture(t), resultFile = path.join(spec.cwd, 'console.json');
  const script = path.join(spec.cwd, 'console-child.cjs');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const probe = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
    public class ConsoleProbe {
      [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
      [DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] ids, uint length);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    }';
    $window = [ConsoleProbe]::GetConsoleWindow(); $ids = New-Object uint32[] 64;
    $count = [ConsoleProbe]::GetConsoleProcessList($ids, 64);
    @{ window = $window.ToInt64(); visible = [ConsoleProbe]::IsWindowVisible($window);
       clients = @($ids | Select-Object -First $count) } | ConvertTo-Json -Compress`;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')];
  // Ordinary grandchildren do not request windowsHide. Waiting until the
  // caller has exited also catches a target attached to a short-lived console.
  fs.writeFileSync(script, `setTimeout(() => {
    const { execFileSync } = require('node:child_process');
    const probe = JSON.parse(execFileSync(${JSON.stringify(powershell)}, ${JSON.stringify(args)},
      { encoding: 'utf8', windowsHide: false, timeout: 10000 }));
    require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ ...probe, pid: process.pid, workerPid: process.ppid }));
    console.log('grandchild completed');
  }, 500);`);
  Object.assign(spec, { file: process.execPath, args: [script, resultFile] });
  const specFile = path.join(spec.cwd, 'launch.json'); fs.writeFileSync(specFile, JSON.stringify(spec));
  const launcher = path.resolve(__dirname, '../src/engines/background-process.cjs');
  const launched = JSON.parse(execFileSync(process.execPath, [launcher, specFile], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  let result, stopped = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      result ||= JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      try { process.kill(result.workerPid, 0); }
      catch (error) { if (error.code !== 'ESRCH') throw error; stopped = true; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(result, 'The target must survive its caller and complete its grandchild');
  assert.equal(result.pid, launched.pid);
  assert.ok(result.window > 0, 'A hidden console must exist for descendants to inherit');
  assert.equal(result.visible, false);
  assert.ok(result.clients.includes(result.pid), 'The ordinary grandchild must share the target console');
  assert.equal(stopped, true, 'The hidden worker must exit when its target exits');
  assert.match(fs.readFileSync(spec.logFile, 'utf8'), /grandchild completed/);
});

test('Windows instructions point to a shipped direct launcher and omit other platforms', () => {
  assert.equal(windowsExecutionInstructions('darwin'), '');
  assert.equal(windowsExecutionInstructions('linux'), '');
  const instruction = windowsExecutionInstructions('win32');
  assert.match(instruction, /Never use cmd \/c start/);
  assert.match(instruction, /args as a string array/);
  assert.match(instruction, /check the log or service readiness/);
  assert.match(instruction, /hidden worker for console inheritance/);
  assert.ok(instruction.includes(JSON.stringify(path.resolve(__dirname, '../src/engines/background-process.cjs'))));
  assert.ok(require('../package.json').build.asarUnpack.includes('src/engines/background-process.cjs'));
});
