'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { antigravitySpawnSpec } = require('../src/engines/antigravity');
const { readJson, writeJson } = require('../src/shared/json-store');
const { createHarness } = require('./claude-harness.cjs');

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-custom-runtime-'));
  context.after(() => removeTree(root));
  const config = path.join(root, 'paths.json'), calls = [];
  const settings = { root, installRoot: root, node: process.execPath, discoverLocal: false,
    customPaths: () => readJson(config, {}), saveCustomPaths: value => writeJson(config, value),
    probe: async (executable, args) => { calls.push({ executable, args }); return { stdout: 'CLI 1.2.3' }; }, ...options };
  const manager = createRuntimeManager(settings);
  function file(name) {
    const filename = path.join(root, name);
    fs.writeFileSync(filename, '', { mode: 0o755 });
    return filename;
  }
  return { manager, root, config, calls, settings, file };
}

test('custom runtime paths persist, take priority, and reset without modifying installations', async context => {
  const setup = fixture(context), executable = setup.file('my codex.exe');
  await setup.manager.setPath('codex', executable);
  assert.equal(setup.manager.locate('codex').file, executable);
  assert.equal(setup.manager.locate('codex').external, true);
  assert.equal(createRuntimeManager(setup.settings).locate('codex').file, executable);
  assert.equal((await setup.manager.ensure('codex')).file, executable);
  assert.deepEqual(setup.calls[0], { executable, args: ['--version'] });
  await setup.manager.setPath('codex', '');
  assert.equal(setup.manager.locate('codex'), null);
  assert.ok(fs.existsSync(executable));
});

test('invalid paths do not overwrite saved settings; missing overrides never trigger fallback', async context => {
  const setup = fixture(context), executable = setup.file('codex.exe');
  await setup.manager.setPath('codex', executable);
  for (const file of ['relative.exe', setup.root, setup.file('wrapper.cmd'), setup.file('script.js')]) {
    await assert.rejects(setup.manager.setPath('codex', file));
    assert.equal(setup.manager.locate('codex').file, executable);
  }
  fs.unlinkSync(executable);
  assert.throws(() => setup.manager.ensure('codex'), /no longer exists/);
  const row = setup.manager.state().find(entry => entry.id === 'codex');
  assert.equal(row.status, 'error');
  assert.equal(row.customPath, executable);
  assert.equal(row.external, true);
  await setup.manager.setPath('codex', '');
  assert.equal(setup.manager.locate('codex'), null);
});

test('Python and Antigravity CLI paths are independent and use the correct launch environment', async context => {
  const setup = fixture(context), python = setup.file('python.exe'), cli = setup.file('agy.exe');
  await setup.manager.setPath('antigravity', python, 'api');
  await setup.manager.setPath('antigravity', cli, 'subscription');
  assert.match(setup.calls[0].args[1], /from google.antigravity import Agent, LocalOpenAIAgentConfig/);
  assert.match(setup.calls[0].args[1], /version\("google-antigravity"\)/);
  assert.equal(setup.manager.locate('antigravity', 'api').file, python);
  assert.equal(setup.manager.locate('antigravity', 'subscription').file, cli);
  const spec = antigravitySpawnSpec({ runtime: setup.manager.locate('antigravity', 'api'), home: setup.root,
    route: { baseUrl: 'http://localhost' }, env: { PATH: 'system', CUSTOM_ENV: 'kept' } });
  assert.equal(spec.env.CUSTOM_ENV, 'kept');
  assert.equal(spec.env.PYTHONPATH, undefined);
  assert.equal(spec.env.PYTHONUTF8, '1');
  await setup.manager.setPath('antigravity', '', 'api');
  assert.equal(setup.manager.locate('antigravity', 'subscription').file, cli);
});

test('failed version and Python import checks leave the configuration untouched', async context => {
  const setup = fixture(context, { probe: async () => { throw new Error('failed'); } });
  await assert.rejects(setup.manager.setPath('antigravity', setup.file('python.exe')), /SDK installed/);
  await assert.rejects(setup.manager.setPath('codex', setup.file('codex.exe')), /Could not run/);
  assert.equal(fs.existsSync(setup.config), false);
});

test('JavaScript entry points run under Node, and native engines reject script entries', async context => {
  const setup = fixture(context), script = setup.file('main file.mjs');
  await setup.manager.setPath('kimi', script);
  await setup.manager.setPath('dsh', script);
  assert.deepEqual(setup.calls[0], { executable: process.execPath, args: [script, '--version'] });
  await assert.rejects(setup.manager.setPath('claude', script), /native executable/);
  await assert.rejects(setup.manager.setPath('kimi', setup.file('kimi.exe')), /JavaScript/);
});

test('desktop IPC persists and clears a local executable path', async context => {
  const harness = createHarness();
  context.after(() => harness.cleanup());
  const result = await harness.call('runtime-set-path', { engine: 'codex', file: process.execPath, mode: 'api' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.engines.find(row => row.id === 'codex').customPath, process.execPath);
  const reset = await harness.call('runtime-set-path', { engine: 'codex', file: '', mode: 'api' });
  assert.equal(reset.ok, true, reset.error);
  assert.equal(reset.engines.find(row => row.id === 'codex').customPath, '');
});

test('standard npm wrappers resolve to their package entry without executing a shell', async context => {
  const setup = fixture(context), wrapper = setup.file('dsh.cmd');
  const packageDir = path.join(setup.root, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }));
  const entry = path.join(packageDir, 'lib', 'bin.js');
  fs.writeFileSync(entry, '');
  await setup.manager.setPath('dsh', wrapper);
  assert.equal(setup.manager.locate('dsh').file, entry);
  assert.deepEqual(setup.calls[0], { executable: process.execPath, args: [entry, '--version'] });
});

test('path validation prevents overlapping saves and downloads and releases its lock', async context => {
  let finish;
  const setup = fixture(context, { probe: () => new Promise(resolve => { finish = resolve; }) });
  const saving = setup.manager.setPath('codex', setup.file('codex.exe'));
  await assert.rejects(setup.manager.setPath('codex', ''), /validation to finish/);
  await assert.rejects(setup.manager.ensure('codex'), /validation to finish/);
  finish({ stdout: 'codex 1.2.3' });
  await saving;
  await setup.manager.setPath('codex', '');
  assert.equal(setup.manager.locate('codex'), null);
});

test('a response started during validation prevents committing a new path', async context => {
  let busy = false;
  const setup = fixture(context, {
    probe: async () => { busy = true; return { stdout: 'codex 1.2.3' }; },
    beforePathSave: () => { if (busy) throw new Error('engine busy'); },
  });
  await assert.rejects(setup.manager.setPath('codex', setup.file('codex.exe')), /engine busy/);
  assert.equal(fs.existsSync(setup.config), false);
  busy = false;
  await setup.manager.setPath('codex', '');
});
