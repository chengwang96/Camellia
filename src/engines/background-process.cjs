'use strict';

// Run with: node background-process.cjs <absolute JSON spec path>
// A JSON spec keeps Windows arguments out of Bash/CMD quoting layers. Never
// fall back to a shell or ShellExecute: missing executables must fail in text.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function absolutePath(value, name) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/u.test(value) || !path.isAbsolute(value))
    throw new Error(name + ' must be an absolute path');
  return value;
}

function startWindowsWorker(spec, fd, spawnProcess) {
  // DETACHED_PROCESS is needed only for this bootstrap. Detaching the target
  // itself leaves it without a console, so descendants such as Android QEMU
  // can allocate a visible one. Keep the target attached to this hidden worker
  // until it exits. IPC reports the target PID, never the bootstrap PID.
  const worker = spawnProcess(process.execPath, [__filename, '--windows-worker'], {
    cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false,
    windowsVerbatimArguments: false, windowsHide: true, detached: true,
    stdio: ['ignore', fd, fd, 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let settled = false, started;
    const timer = setTimeout(() => fail(new Error('Hidden background worker did not report startup')), 15000);
    const fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (worker.connected) worker.disconnect();
      worker.kill();
      reject(error);
    };
    worker.once('error', fail);
    worker.once('exit', code => fail(new Error('Hidden background worker exited before startup: ' + code)));
    worker.once('spawn', () => {
      try { worker.send(spec, error => { if (error) fail(error); }); }
      catch (error) { fail(error); }
    });
    worker.on('message', message => {
      if (settled) return;
      if (message?.error) return fail(Object.assign(new Error(message.error.message), { code: message.error.code }));
      if (started) {
        if (message?.pid !== started.pid || !Object.hasOwn(message, 'exitCode'))
          return fail(new Error('Invalid background process exit receipt'));
        settled = true;
        worker.disconnect(); worker.unref();
        resolve({ ...started, exitCode: message.exitCode, signal: message.signal });
        return;
      }
      if (!Number.isSafeInteger(message?.pid) || message.pid <= 0 || message.pid === worker.pid)
        return fail(new Error('Invalid background process PID from hidden worker'));
      if (spec.waitForExit) {
        clearTimeout(timer);
        started = { pid: message.pid, logFile: spec.logFile };
        return;
      }
      settled = true; clearTimeout(timer);
      worker.disconnect(); worker.unref();
      resolve({ pid: message.pid, logFile: spec.logFile });
    });
  });
}

async function startBackgroundProcess(spec, { spawnProcess = spawn, platform = process.platform, windowsWorker = false, onSpawn } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Expected a process specification');
  const file = absolutePath(spec.file, 'file');
  const cwd = absolutePath(spec.cwd, 'cwd');
  const logFile = absolutePath(spec.logFile, 'logFile');
  if (platform === 'win32' && !/\.exe$/iu.test(file))
    throw new Error('Use a native .exe; pass scripts as arguments to their interpreter');
  if (!fs.statSync(file).isFile()) throw new Error('Executable is not a file');
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd is not a directory');
  if (!Array.isArray(spec.args) || spec.args.some(value => typeof value !== 'string' || value.includes('\0')))
    throw new Error('args must be an array of strings without NUL characters');
  if (spec.waitForExit !== undefined && typeof spec.waitForExit !== 'boolean')
    throw new Error('waitForExit must be a boolean');
  if (spec.env !== undefined && (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)
      || Object.entries(spec.env).some(([key, value]) => !key || /[=\0]/u.test(key) || typeof value !== 'string' || value.includes('\0'))))
    throw new Error('env must contain string environment variables');
  // Do not turn the executable or a script being launched into its own log.
  const logPath = path.resolve(logFile), inputs = [file, ...spec.args].map(value => path.resolve(cwd, value));
  const pathKey = value => platform === 'win32' ? value.toLowerCase() : value;
  if (inputs.some(value => pathKey(value) === pathKey(logPath))) throw new Error('logFile must differ from process inputs');
  const fd = fs.openSync(logFile, 'a');
  try {
    if (platform === 'win32' && !windowsWorker) return await startWindowsWorker(spec, fd, spawnProcess);
    const child = spawnProcess(file, spec.args, { cwd, env: { ...process.env, ...spec.env },
      shell: false, windowsVerbatimArguments: false, windowsHide: true,
      detached: platform !== 'win32', stdio: ['ignore', fd, fd] });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    if (spec.waitForExit) {
      onSpawn?.({ pid: child.pid, logFile });
      return await new Promise(resolve => child.once('close', (exitCode, signal) =>
        resolve({ pid: child.pid, logFile, exitCode, signal })));
    }
    if (!windowsWorker) child.unref();
    return { pid: child.pid, logFile };
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  if (process.argv[2] === '--windows-worker' && process.platform === 'win32' && process.send) {
    process.once('message', async spec => {
      try { process.send(await startBackgroundProcess(spec, { windowsWorker: true,
        onSpawn: receipt => process.send(receipt) })); }
      catch (error) {
        process.exitCode = 1;
        process.send({ error: { message: error.message, code: error.code } }, () => { if (process.connected) process.disconnect(); });
      }
    });
  } else void (async () => {
    if (process.argv.length !== 3) throw new Error('Usage: node background-process.cjs <absolute JSON spec path>');
    const specFile = absolutePath(process.argv[2], 'spec');
    const result = await startBackgroundProcess(JSON.parse(fs.readFileSync(specFile, 'utf8')));
    console.log(JSON.stringify(result));
    if (Object.hasOwn(result, 'exitCode')) process.exitCode = result.exitCode === 0 ? 0 : 1;
  })().catch(error => { console.error('Background process failed: ' + error.message); process.exitCode = 1; });
}

module.exports = { startBackgroundProcess };
