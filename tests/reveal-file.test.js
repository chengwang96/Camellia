'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { revealCommand, revealInFileManager } = require('../src/main/reveal-file');

function createHarness({ platform, error } = {}) {
  const calls = [];
  const children = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => calls.at(-1).unrefed = true;
    children.push(child);
    queueMicrotask(() => error ? child.emit('error', error) : child.emit('spawn'));
    return child;
  };
  return { calls, children, spawnProcess, run: (filePath, extra = {}) => revealInFileManager(filePath, { platform, spawnProcess, ...extra }) };
}

test('each desktop is asked to reveal the file in its own way', () => {
  assert.deepEqual(revealCommand('darwin', '/tmp/report.pdf'), { command: 'open', args: ['-R', '/tmp/report.pdf'] });
  assert.deepEqual(revealCommand('win32', 'C:\\outputs\\report.pdf'), { command: 'explorer.exe', args: ['/select,C:\\outputs\\report.pdf'] });
  assert.deepEqual(revealCommand('linux', '/home/user/outputs/report.pdf'), { command: 'xdg-open', args: ['/home/user/outputs'] });
});

test('reveal spawns the platform command detached for an existing file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const filePath = path.join(directory, 'report.pdf');
  fs.writeFileSync(filePath, 'fixture');

  const windows = createHarness({ platform: 'win32' });
  const result = await windows.run(filePath);
  assert.deepEqual(result, { command: 'explorer.exe', args: ['/select,' + filePath] });
  assert.equal(windows.calls[0].options.detached, true);
  assert.equal(windows.calls[0].options.stdio, 'ignore');
  assert.equal(windows.calls[0].unrefed, true);

  const mac = createHarness({ platform: 'darwin' });
  await mac.run(filePath);
  assert.deepEqual(mac.calls[0].args, ['-R', filePath]);

  const linux = createHarness({ platform: 'linux' });
  await linux.run(filePath);
  assert.deepEqual(linux.calls[0].args, [directory]);
});

test('missing files are rejected before any process starts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const harness = createHarness({ platform: 'win32' });
  await assert.rejects(harness.run(path.join(directory, 'missing.pdf')), /ENOENT/);
  await assert.rejects(harness.run('   '), /A file path is required/);
  assert.deepEqual(harness.calls, []);
});

test('spawn errors surface and Linux falls back to opening the folder', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const filePath = path.join(directory, 'report.pdf');
  fs.writeFileSync(filePath, 'fixture');

  const failing = createHarness({ platform: 'win32', error: new Error('explorer is unavailable') });
  await assert.rejects(failing.run(filePath), /explorer is unavailable/);

  const missing = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
  const folders = [];
  const linux = createHarness({ platform: 'linux', error: missing });
  assert.deepEqual(await linux.run(filePath, { openPath: async folder => { folders.push(folder); return ''; } }),
    { command: 'openPath', args: [directory] });
  assert.deepEqual(folders, [directory]);

  const broken = createHarness({ platform: 'linux', error: missing });
  await assert.rejects(broken.run(filePath, { openPath: async () => 'no file manager' }), /no file manager/);
});
