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

test('background launches keep Windows paths and arguments literal without a shell', async t => {
  const spec = fixture(t), calls = [];
  spec.args = ['space value', '中文 & %TEMP% ^', 'a"b', 'C:\\folder with spaces\\', ''];
  spec.env = { CAMELLIA_LAUNCH_FIXTURE: 'literal & % value' };
  let unrefed = false;
  const result = await startBackgroundProcess(spec, { platform: 'win32', spawnProcess(file, args, options) {
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
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.CAMELLIA_LAUNCH_FIXTURE, spec.env.CAMELLIA_LAUNCH_FIXTURE);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(calls[0].options.stdio[1], calls[0].options.stdio[2]);
  assert.equal(unrefed, true);
  assert.throws(() => fs.fstatSync(calls[0].options.stdio[1]), { code: 'EBADF' });
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
  await assert.rejects(startBackgroundProcess(spec, { spawnProcess(file, args, options) {
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

test('Windows instructions point to a shipped direct launcher and omit other platforms', () => {
  assert.equal(windowsExecutionInstructions('darwin'), '');
  assert.equal(windowsExecutionInstructions('linux'), '');
  const instruction = windowsExecutionInstructions('win32');
  assert.match(instruction, /Never use cmd \/c start/);
  assert.match(instruction, /args as a string array/);
  assert.match(instruction, /check the log or service readiness/);
  assert.ok(instruction.includes(JSON.stringify(path.resolve(__dirname, '../src/engines/background-process.cjs'))));
  assert.ok(require('../package.json').build.asarUnpack.includes('src/engines/background-process.cjs'));
});
