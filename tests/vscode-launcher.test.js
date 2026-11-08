'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { createHarness } = require('./main-process-harness.cjs');
const { detectVSCodeInstallations, validateVSCodeExecutable, openWorkspaceInVSCode } = require('../src/main/vscode-launcher');

function virtualFileSystem({ files = [], directories = [] } = {}) {
  const fileSet = new Set(files), directorySet = new Set(directories);
  return {
    constants: fs.constants,
    statSync(target) {
      if (fileSet.has(target)) return { isFile: () => true, isDirectory: () => false };
      if (directorySet.has(target)) return { isFile: () => false, isDirectory: () => true };
      throw new Error('Missing virtual path: ' + target);
    },
    accessSync(target) {
      if (!fileSet.has(target) && !directorySet.has(target)) throw new Error('Unreadable virtual path: ' + target);
    },
  };
}

function spawnHarness(error) {
  const calls = [];
  return {
    calls,
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      child.unref = () => { child.unrefed = true; };
      calls.push({ command, args, options, child });
      queueMicrotask(() => error ? child.emit('error', error) : child.emit('spawn'));
      return child;
    },
  };
}

const win = (...parts) => path.win32.join(...parts);

test('Windows detection finds user, system and PATH installations with stable first', () => {
  const root = 'C:\\fixtures';
  const stableUser = win(root, 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const stableSystem = win(root, 'Program Files', 'Microsoft VS Code', 'Code.exe');
  const stablePath = win(root, 'path', 'Code.exe');
  const insiders = win(root, 'Local', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe');
  const installations = detectVSCodeInstallations({
    platform: 'win32', home: win(root, 'home'),
    env: { LOCALAPPDATA: win(root, 'Local'), ProgramFiles: win(root, 'Program Files'), 'ProgramFiles(x86)': win(root, 'x86'), PATH: win(root, 'path') },
    fileSystem: virtualFileSystem({ files: [stableUser, stableSystem, stablePath, insiders] }),
  });
  assert.deepEqual(installations.map(item => item.path), [stableUser, stableSystem, stablePath, insiders]);
  assert.deepEqual(installations.map(item => item.id), ['stable', 'stable', 'stable', 'insiders']);
});

test('macOS and Linux detection supports application bundles, commands and stable PATH priority', () => {
  const macStable = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const macPath = '/opt/homebrew/bin/code';
  const macInsiders = '/home/test/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code';
  const mac = detectVSCodeInstallations({ platform: 'darwin', home: '/home/test', env: { PATH: '/opt/homebrew/bin' },
    fileSystem: virtualFileSystem({ files: [macStable, macPath, macInsiders] }) });
  assert.deepEqual(mac.map(item => item.path), [macStable, macPath, macInsiders]);

  const linuxStable = '/opt/code/code', linuxInsiders = '/usr/bin/code-insiders';
  const linux = detectVSCodeInstallations({ platform: 'linux', home: '/home/test', env: { PATH: '/opt/code' },
    fileSystem: virtualFileSystem({ files: [linuxStable, linuxInsiders] }) });
  assert.deepEqual(linux.map(item => item.path), [linuxStable, linuxInsiders]);
});

test('custom executable validation accepts files, clears automatic mode and rejects invalid paths', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-vscode-'));
  t.after(() => removeTree(directory));
  const executable = path.join(directory, process.platform === 'win32' ? 'Code.exe' : 'code');
  fs.writeFileSync(executable, 'fixture');
  assert.equal(validateVSCodeExecutable('  ' + executable + '  '), path.normalize(executable));
  assert.equal(validateVSCodeExecutable(''), '');
  for (const value of [null, {}, 42, 'relative/code', directory, executable + '-missing', executable + '\n']) {
    assert.throws(() => validateVSCodeExecutable(value));
  }
});

test('opening a workspace auto-selects stable, honors a chosen edition and passes the directory verbatim', async () => {
  const stable = win('C:\\fixtures', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const insiders = win('C:\\fixtures', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe');
  const workspace = win('C:\\work', 'Camellia 中文 , & test');
  const fileSystem = virtualFileSystem({ files: [stable, insiders], directories: [workspace] });
  const options = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\fixtures', PATH: '' }, home: 'C:\\fixtures', fileSystem };
  const automatic = spawnHarness();
  assert.deepEqual(await openWorkspaceInVSCode(workspace, { ...options, spawnProcess: automatic.spawnProcess }), { executable: stable, name: 'Visual Studio Code' });
  assert.equal(automatic.calls[0].command, stable);
  assert.deepEqual(automatic.calls[0].args, [workspace]);
  assert.equal(automatic.calls[0].options.detached, true);
  assert.equal(automatic.calls[0].options.stdio, 'ignore');
  assert.equal(automatic.calls[0].child.unrefed, true);

  const selected = spawnHarness();
  await openWorkspaceInVSCode(workspace, { ...options, vscodePath: insiders, spawnProcess: selected.spawnProcess });
  assert.equal(selected.calls[0].command, insiders);
  assert.deepEqual(selected.calls[0].args, [workspace]);
});

test('missing installations, invalid paths and process failures never silently launch another program', async () => {
  const workspace = win('C:\\work', 'project'), stable = win('C:\\fixtures', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const empty = spawnHarness();
  await assert.rejects(openWorkspaceInVSCode(workspace, { platform: 'win32', env: {}, fileSystem: virtualFileSystem({ directories: [workspace] }), spawnProcess: empty.spawnProcess }), /No VS Code installation was found/);
  assert.equal(empty.calls.length, 0);
  await assert.rejects(openWorkspaceInVSCode('relative/project', { platform: 'win32', fileSystem: virtualFileSystem(), spawnProcess: empty.spawnProcess }), /absolute path/);
  await assert.rejects(openWorkspaceInVSCode(workspace, { platform: 'win32', vscodePath: 'C:\\missing\\Code.exe', fileSystem: virtualFileSystem({ directories: [workspace] }), spawnProcess: empty.spawnProcess }), /does not exist/);
  assert.equal(empty.calls.length, 0);

  const failing = spawnHarness(new Error('VS Code could not start'));
  await assert.rejects(openWorkspaceInVSCode(workspace, { platform: 'win32', env: { LOCALAPPDATA: 'C:\\fixtures' },
    fileSystem: virtualFileSystem({ files: [stable], directories: [workspace] }), spawnProcess: failing.spawnProcess }), /VS Code could not start/);
});

test('VS Code preference persists through partial saves and real IPC launches the selected executable', async () => {
  const first = createHarness();
  try {
    assert.equal(first.call('workbench-settings').vscodePath, '');
    const executable = path.join(first.home, 'Programs', 'Microsoft VS Code', 'Code.exe');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'fixture');
    const detected = first.call('vscode-installations');
    assert.equal(detected.ok, true);
    if (process.platform === 'win32') assert.ok(detected.installations.some(item => item.path === executable));
    assert.equal(first.call('workbench-save-settings', { vscodePath: '  ' + executable + '  ' }).ok, true);
    assert.equal(first.call('workbench-settings').vscodePath, executable);
    assert.equal(first.call('workbench-save-settings', { theme: 'dark' }).ok, true);
    assert.equal(first.call('workbench-settings').vscodePath, executable);
    const reopened = createHarness(first.root);
    assert.equal(reopened.call('workbench-settings').vscodePath, executable);
    for (const value of [null, {}, 42, 'relative/Code.exe', first.home, executable + '-missing', executable + '\n']) {
      assert.equal(reopened.call('workbench-save-settings', { vscodePath: value }).ok, false);
      assert.equal(reopened.call('workbench-settings').vscodePath, executable);
    }
    if (process.platform === 'win32') {
      assert.equal(reopened.call('workbench-save-settings', { vscodePath: '' }).ok, true);
      assert.equal(reopened.call('workbench-settings').vscodePath, '');
    }
    const workspace = reopened.folder('VS Code workspace');
    const opened = await reopened.call('open-in-vscode', workspace);
    assert.equal(opened.ok, true);
    assert.equal(opened.executable, executable);
    const child = reopened.processes.at(-1);
    assert.equal(child.exe, executable);
    assert.deepEqual(child.args, [workspace]);
    assert.equal(child.unrefed, true);
    await reopened.cleanup();
  } finally { await first.cleanup(); }
});
