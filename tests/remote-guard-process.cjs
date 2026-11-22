'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startBackgroundProcess } = require('../src/engines/background-process.cjs');

const root = path.resolve(__dirname, '..');
const guard = path.join(root, 'build/runtime-assets',
  process.platform === 'win32' ? 'camellia-remote-guard.exe' : 'camellia-remote-guard');
if (!fs.existsSync(guard)) throw new Error('Build the remote guard first: npm run build:remote-guard');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-remote-guard-process-'));
const launchesFile = path.join(directory, 'launches.txt');
const heartbeatFile = path.join(directory, 'heartbeat.json');
const stopFile = path.join(directory, 'stop');
const guardSpec = path.join(directory, 'guard-spec.json');
const fakeApp = path.join(directory, 'fake-app.cjs');
let guardPid = 0;
const appPids = new Set();

function readPids() {
  if (!fs.existsSync(launchesFile)) return [];
  return fs.readFileSync(launchesFile, 'utf8').split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
}

async function waitFor(predicate, timeout = 25_000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for ' + label);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function stopProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return;
  try { process.kill(pid); } catch { /* It may have exited between the check and the signal. */ }
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Best effort during cleanup. */ }
  }
}

async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  console.warn('Remote guard smoke directory is still locked: ' + directory);
}

fs.writeFileSync(fakeApp, [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const directory = process.argv[2];',
  "fs.appendFileSync(path.join(directory, 'launches.txt'), process.pid + '\\n');",
  "const heartbeat = () => fs.writeFileSync(path.join(directory, 'heartbeat.json'),",
  "  JSON.stringify({ version: 1, pid: process.pid, at: Date.now() }));",
  'heartbeat();',
  'setInterval(heartbeat, 1000);',
  'setInterval(() => {}, 60_000);',
].join('\n'));
fs.writeFileSync(guardSpec, JSON.stringify({
  version: 1,
  app: process.execPath,
  args: [fakeApp, directory],
  cwd: directory,
  heartbeat: heartbeatFile,
  stop: stopFile,
  status: path.join(directory, 'status.json'),
  lock: path.join(directory, 'guard.lock'),
  log: path.join(directory, 'guard.log'),
  staleMs: 5000,
  launchGraceMs: 10_000,
}));

void (async () => {
  try {
    const started = await startBackgroundProcess({
      file: guard,
      args: [guardSpec],
      cwd: directory,
      logFile: path.join(directory, 'launcher.log'),
    });
    guardPid = started.pid;
    await waitFor(() => readPids().length >= 1 && fs.existsSync(heartbeatFile), 20_000, 'the first fake app launch');
    const first = readPids()[0];
    appPids.add(first);
    await stopProcess(first);
    await waitFor(() => readPids().length >= 2, 30_000, 'the guarded relaunch');
    const second = readPids()[1];
    appPids.add(second);
    fs.writeFileSync(stopFile, String(Date.now()) + '\n');
    await waitFor(() => !alive(guardPid), 10_000, 'the guard to stop');
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.equal(readPids().length, 2, 'The guard must not relaunch after an explicit stop');
    assert.equal(fs.existsSync(path.join(directory, 'status.json')), false);
    console.log(`PASS: remote guard restarted the app and stayed stopped (${first} -> ${second})`);
  } finally {
    fs.writeFileSync(stopFile, String(Date.now()) + '\n');
    await stopProcess(guardPid);
    for (const pid of new Set([...appPids, ...readPids()])) await stopProcess(pid);
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Smoke directory escaped the temporary directory');
    await removeDirectory(resolved);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
