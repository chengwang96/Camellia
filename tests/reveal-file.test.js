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

test('macOS and Linux use their file manager commands', () => {
  assert.deepEqual(revealCommand('darwin', '/tmp/report.pdf'), { command: 'open', args: ['-R', '/tmp/report.pdf'] });
  assert.deepEqual(revealCommand('linux', '/home/user/outputs/report.pdf'), { command: 'xdg-open', args: ['/home/user/outputs'] });
});

test('reveal spawns the platform command detached for an existing file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const filePath = path.join(directory, 'report.pdf');
  fs.writeFileSync(filePath, 'fixture');

  const mac = createHarness({ platform: 'darwin' });
  assert.deepEqual(await mac.run(filePath), { command: 'open', args: ['-R', filePath] });
  assert.deepEqual(mac.calls[0].args, ['-R', filePath]);
  assert.equal(mac.calls[0].options.detached, true);
  assert.equal(mac.calls[0].options.stdio, 'ignore');
  assert.equal(mac.calls[0].unrefed, true);

  const linux = createHarness({ platform: 'linux' });
  await linux.run(filePath);
  assert.deepEqual(linux.calls[0].args, [directory]);
});

test('Windows passes special paths unchanged to native file selection without spawning Explorer', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const folder = path.join(directory, '中文 outputs, with spaces & (brackets)');
  fs.mkdirSync(folder);
  const revealed = [];
  const windows = createHarness({ platform: 'win32' });
  for (const name of ['report.pdf', '报告 final, v2 & (draft).pdf', 'report #100%.pdf']) {
    const filePath = path.join(folder, name);
    fs.writeFileSync(filePath, 'fixture');
    const result = await windows.run(filePath, { showItemInFolder: file => revealed.push(file) });
    assert.deepEqual(result, { command: 'showItemInFolder', args: [filePath] });
    assert.equal(revealed.at(-1), filePath);
  }
  const relativePath = path.relative(process.cwd(), folder);
  await windows.run(relativePath, { showItemInFolder: file => revealed.push(file) });
  assert.equal(revealed.at(-1), folder);
  assert.equal(revealed.length, 4);
  assert.deepEqual(windows.calls, []);
});

test('Windows reports unavailable or throwing native file selection', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const windows = createHarness({ platform: 'win32' });
  await assert.rejects(windows.run(directory), /Windows file reveal is unavailable/);
  await assert.rejects(windows.run(directory, {
    showItemInFolder: () => { throw new Error('native reveal failed'); },
  }), /native reveal failed/);
  assert.deepEqual(windows.calls, []);
});

test('missing files are rejected before any process starts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const revealed = [];
  const harness = createHarness({ platform: 'win32' });
  await assert.rejects(harness.run(path.join(directory, 'missing.pdf'), {
    showItemInFolder: file => revealed.push(file),
  }), /ENOENT/);
  await assert.rejects(harness.run(path.join(directory, 'missing.pdf')), /ENOENT/);
  await assert.rejects(harness.run('   '), /A file path is required/);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(revealed, []);
});

test('spawn errors surface and Linux falls back to opening the folder', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-reveal-'));
  t.after(() => removeTree(directory));
  const filePath = path.join(directory, 'report.pdf');
  fs.writeFileSync(filePath, 'fixture');

  const failing = createHarness({ platform: 'darwin', error: new Error('open is unavailable') });
  await assert.rejects(failing.run(filePath), /open is unavailable/);

  const missing = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
  const folders = [];
  const linux = createHarness({ platform: 'linux', error: missing });
  assert.deepEqual(await linux.run(filePath, { openPath: async folder => { folders.push(folder); return ''; } }),
    { command: 'openPath', args: [directory] });
  assert.deepEqual(folders, [directory]);

  const broken = createHarness({ platform: 'linux', error: missing });
  await assert.rejects(broken.run(filePath, { openPath: async () => 'no file manager' }), /no file manager/);
});
