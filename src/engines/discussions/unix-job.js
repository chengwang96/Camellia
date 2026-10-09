'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { WindowsJobJournal, jobIdentity } = require('./windows-job-journal');

class UnixJobJournal extends WindowsJobJournal {
  read(identity) {
    const { jobName, ...record } = super.read(identity);
    return Object.freeze({ ...record, stateFile: path.join(path.dirname(record.lockFile), 'unix-state.json') });
  }
}
function helperExecutable() {
  const file = process.env.CAMELLIA_DISCUSSION_HELPER || [
    process.resourcesPath && path.join(process.resourcesPath, 'runtime/camellia-discussion-job'),
    path.resolve(__dirname, '../../../build/runtime-assets/camellia-discussion-job'),
  ].filter(Boolean).find(file => fs.existsSync(file));
  if (!file || !path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('The macOS discussion helper is missing. Reinstall Camellia or build its discussion helper.');
  return file;
}
const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
  return { promise, resolve, reject };
};
function validate(identity, journal, timeoutMs) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Unix discussion supervision is unavailable on this platform');
  if (!(journal instanceof UnixJobJournal) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Invalid Unix job journal or timeout');
  return jobIdentity(identity);
}
function startHost(record, type, nonce) {
  // Control and evidence have separate private descriptors. CLI stdout/stderr
  // remain byte streams and cannot forge a native stop acknowledgement.
  const host = spawn(helperExecutable(), [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  host.stdio[3].write(JSON.stringify({ ...record, type, nonce }) + '\n');
  return host;
}
async function prepareUnixJob({ identity, journal, signal, timeoutMs = 30000 }) {
  const scope = validate(identity, journal, timeoutMs);
  if (signal?.aborted) throw Object.assign(new Error('Discussion activity cancelled'), { name: 'AbortError' });
  const record = journal.reserve(scope), nonce = randomUUID(), ready = pending(), confirmed = pending();
  const host = startHost(record, 'initialize', nonce), lines = createInterface({ input: host.stdio[4] });
  let proc, sealed = false, proof, failure, closed = false, stopping, exitReceived = false;
  const failProcess = error => { if (proc && !proc.failed) { proc.failed = true; queueMicrotask(() => proc.emit('error', error)); } };
  const fail = error => { failure ||= error; sealed = true; ready.reject(error); confirmed.reject(error); failProcess(error); host.kill('SIGTERM'); };
  const send = value => {
    if (closed || host.stdio[3].destroyed) throw new Error('Unix job supervisor is unavailable');
    host.stdio[3].write(JSON.stringify({ ...value, nonce }) + '\n');
  };
  const timer = setTimeout(() => fail(new Error('Unix job supervisor preparation timed out')), timeoutMs);
  lines.on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.nonce !== nonce || failure) throw new Error('Invalid Unix job supervisor event');
      if (value.type === 'ready') { clearTimeout(timer); ready.resolve(); }
      else if (value.type === 'failure') { const error = new Error('Unix job supervisor: ' + value.message); failProcess(error); }
      else if (value.type === 'spawned') {
        if (!proc || proc.pid || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('Invalid Unix process identity');
        proc.pid = value.pid; proc.emit('spawn');
      } else if (value.type === 'exit') {
        if (!proc?.pid || exitReceived || !Number.isSafeInteger(value.code) || value.code < 0) throw new Error('Invalid Unix process exit');
        exitReceived = true; proc.exitCode = value.code; proc.emit('exit', value.code, null);
      } else if (value.type === 'stopped') {
        if (proof || value.sealed !== true || value.activeProcesses !== 0 || !Number.isSafeInteger(value.totalProcesses)
          || value.totalProcesses < 0 || proc?.pid && !exitReceived) throw new Error('Invalid Unix job stop proof');
        sealed = true;
        proof = Object.freeze({ ...scope, stopped: true, kind: 'unix-process-group', activeProcesses: 0,
          totalProcesses: value.totalProcesses, supervisorPid: host.pid, rootPid: proc?.pid || null });
      } else throw new Error('Unknown Unix job supervisor event');
    } catch (error) { fail(error); }
  });
  // Engine descendants may keep stdio open after their supervisor dies. The
  // private evidence descriptor closes independently and makes recovery prompt.
  lines.once('close', () => {
    if (!proof && !closed) fail(new Error('Unix supervisor exited without verified stop'));
  });
  host.on('error', fail); host.stdio[3].on('error', fail);
  host.stdin.on('error', error => { if (!proof) failProcess(error); });
  host.once('close', code => {
    closed = true; sealed = true; clearTimeout(timer); lines.close(); signal?.removeEventListener('abort', abort);
    if (proof && !failure && code === 0) confirmed.resolve(proof);
    else { const error = failure || new Error('Unix supervisor exited without verified stop'); ready.reject(error); confirmed.reject(error); failProcess(error); }
    if (proc) { if (proc.exitCode === null) proc.exitCode = -1; proc.emit('close', proc.exitCode, null); }
  });
  function abort() { void stop().catch(() => {}); }
  function stop() {
    if (stopping) return stopping;
    sealed = true;
    stopping = (async () => {
      let stopTimer;
      try {
        await ready.promise;
        if (!closed && !proof) send({ type: 'stop' });
        return await Promise.race([confirmed.promise, new Promise((_, reject) => {
          stopTimer = setTimeout(() => reject(new Error('Unix job stop timed out')), timeoutMs);
        })]);
      } catch {
        host.kill('SIGTERM');
        // Recovery fences launch and observes OS membership independently of
        // a failed helper, driver flag, or persisted stopped boolean.
        return recoverUnixJob({ identity: scope, journal, timeoutMs });
      } finally { clearTimeout(stopTimer); }
    })();
    stopping.catch(() => {}); return stopping;
  }
  signal?.addEventListener('abort', abort, { once: true });
  await ready.promise;
  if (signal?.aborted) { await stop(); throw Object.assign(new Error('Discussion activity cancelled'), { name: 'AbortError' }); }
  function spawnProcess(exe, args, options) {
    if (sealed || proc) throw new Error('Unix launcher is stopped or already used');
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || exe.includes('\0') || !Array.isArray(args)
      || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !path.isAbsolute(options?.cwd || '') || options.cwd.includes('\0')
      || !options.env || typeof options.env !== 'object' || Array.isArray(options.env)
      || Object.entries(options.env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))
      || options.shell || options.detached || options.windowsVerbatimArguments || JSON.stringify(options.stdio) !== '["pipe","pipe","pipe"]') throw new Error('Invalid supervised Unix launch');
    proc = new EventEmitter(); proc.on('error', () => {});
    Object.assign(proc, { pid: undefined, exitCode: null, signalCode: null, stdin: host.stdin, stdout: host.stdout, stderr: host.stderr });
    proc.kill = () => { abort(); return true; };
    send({ type: 'spawn', exe, args, cwd: options.cwd, env: options.env }); return proc;
  }
  return Object.freeze({ identity: scope, spawn: spawnProcess, stop, supervisorPid: host.pid });
}
async function recoverUnixJob({ identity, journal, timeoutMs = 30000 }) {
  const scope = validate(identity, journal, timeoutMs), nonce = randomUUID();
  const host = startHost(journal.read(scope), 'recover', nonce), lines = createInterface({ input: host.stdio[4] });
  // Recovery never consumes native CLI input or account data.
  host.stdin.end(); host.stdout.resume(); host.stderr.resume(); host.stdio[3].end();
  return new Promise((resolve, reject) => {
    let proof, failure;
    const fail = error => { failure ||= error; host.kill('SIGTERM'); };
    const timer = setTimeout(() => fail(new Error('Unix job recovery timed out')), timeoutMs);
    host.on('error', fail); host.stdio[3].on('error', fail);
    lines.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.nonce !== nonce || value.type !== 'recovered' || proof || value.sealed !== true || value.activeProcesses !== 0
          || !Number.isSafeInteger(value.totalProcesses) || value.totalProcesses < 0) throw new Error('Invalid Unix job recovery proof');
        proof = Object.freeze({ ...scope, stopped: true, kind: 'unix-process-group-recovery', sealed: true, activeProcesses: 0, totalProcesses: value.totalProcesses });
      } catch (error) { fail(error); }
    });
    host.once('close', code => { clearTimeout(timer); lines.close(); failure || !proof || code !== 0
      ? reject(failure || new Error('Unix recovery exited without proof')) : resolve(proof); });
  });
}
module.exports = { UnixJobJournal, prepareUnixJob, recoverUnixJob, helperExecutable };
