'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { removeTree } = require('./test-fs.cjs');
const patch = require('../integrations/dsh/client-performance.cjs');

const runtime = process.env.DSH_PERFORMANCE_RUNTIME_DIR || path.resolve(__dirname, '../runtimes/dsh');
const modules = path.join(runtime, 'node_modules/@deepseek-ai/dsh-client-modules');
const file = path.join(modules, 'lib/index.js');
const version = fs.existsSync(file) ? JSON.parse(fs.readFileSync(path.join(modules, 'package.json'))).version : null;
function functions(source) {
  return vm.runInNewContext(source.replace(/^import .+;\r?$/gm, '').replace(/^export .+;\r?$/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)) +
    '\n({ newlineCount, buildCombo, ClientModuleRegistry })', { Buffer, URL, createRequire, Service: class {}, ...crypto });
}
function record(id, source, sourceMap) {
  return { entry: { id, rev: 'first' }, bundle: Buffer.from(source), sourceMap };
}
function sameArtifact(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('client startup patch preserves bundle bytes, revisions, maps and HMR updates', { skip: version !== '0.1.5-rc.2' && 'This patch targets the 0.1 client' }, () => {
  const original = fs.readFileSync(fs.existsSync(file + '.workbench-original') ? file + '.workbench-original' : file, 'utf8');
  const before = functions(original), after = functions(patch(original));
  for (const source of ['', 'a', '\n', '猫🐈\r\nsecond\n', 'line\n'.repeat(10000)]) {
    assert.equal(after.newlineCount(source), before.newlineCount(source));
  }
  const a = record('@test/one', 'console.log("猫🐈");\n//# sourceMappingURL=client.js.map\n');
  const b = record('@test/two', 'second();\n//# sourceURL=/original/two.js\n', {
    parsed: { version: 3, names: [], sources: ['../src/two.ts'], sourcesContent: ['second();'], mappings: 'AAAA', sourceRoot: '' },
  });
  for (const records of [[a], [b], [a, b]]) for (const revision of [undefined, 'first']) {
    sameArtifact(after.buildCombo(records, revision), before.buildCombo(records, revision));
  }
  const initial = after.buildCombo([a], 'first');
  assert.equal(after.buildCombo([a], 'first'), initial, 'Unchanged plugin artifacts reuse their buffers');
  a.bundle = Buffer.from('updated();\n');
  const updated = after.buildCombo([a], 'second');
  assert.notEqual(updated, initial);
  sameArtifact(updated, before.buildCombo([a], 'second'));
  a.sourceMap = b.sourceMap;
  const remapped = after.buildCombo([a], 'third');
  assert.notEqual(remapped, updated);
  sameArtifact(remapped, before.buildCombo([a], 'third'));
  sameArtifact(after.buildCombo([a, b]), before.buildCombo([a, b]));
  sameArtifact(initial, before.buildCombo([record('@test/one', 'console.log("猫🐈");\n//# sourceMappingURL=client.js.map\n')], 'first'));
});

test('pinned DSH settings, module and locale integrations apply together and remain idempotent', {
  skip: !['0.2.0-rc.2', '0.2.1-rc.2'].includes(version) && 'Requires the pinned client packages',
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-dsh-integration-'));
  t.after(() => removeTree(root));
  const packages = { 'dsh-client-ui-settings-general': 'lib/client.js', 'dsh-client-modules': 'lib/index.js', 'dsh-client-locale': 'lib/client.js' };
  for (const [name, entry] of Object.entries(packages)) {
    const source = path.join(runtime, 'node_modules/@deepseek-ai', name), target = path.join(root, 'node_modules/@deepseek-ai', name);
    fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
    const original = path.join(source, entry + '.workbench-original');
    fs.copyFileSync(fs.existsSync(original) ? original : path.join(source, entry), path.join(target, entry));
  }
  const patchAll = require('../integrations/dsh/patch.cjs');
  patchAll(root);
  const outputs = Object.entries(packages).map(([name, entry]) => fs.readFileSync(path.join(root, 'node_modules/@deepseek-ai', name, entry), 'utf8'));
  assert.match(outputs[0], /WorkbenchSettingsRoot/);
  assert.match(outputs[1], /value.indexOf/);
  assert.match(outputs[2], /Camellia default/);
  patchAll(root);
  assert.deepEqual(Object.entries(packages).map(([name, entry]) => fs.readFileSync(path.join(root, 'node_modules/@deepseek-ai', name, entry), 'utf8')), outputs);
});

test('0.2 client preserves lazy scripts, source maps and shared responses after the line-scan patch', { skip: !['0.2.0-rc.2', '0.2.1-rc.2'].includes(version) && 'Requires the 0.2 client' }, async () => {
  const original = fs.readFileSync(fs.existsSync(file + '.workbench-original') ? file + '.workbench-original' : file, 'utf8');
  const before = functions(original), after = functions(patch(original, version));
  for (const source of ['', 'a', '\n', '猫🐈\r\nsecond\n', 'line\n'.repeat(10000)]) assert.equal(after.newlineCount(source), before.newlineCount(source));
  const a = { ...record('@test/one', 'console.log("猫🐈");\n//# sourceMappingURL=client.js.map\n'), meta: { clientPath: '/test/one/client.js' } };
  const b = { ...record('@test/two', 'second();\n//# sourceURL=/original/two.js\n'), meta: { clientPath: '/test/two/client.js' } };
  const map = { version: 3, names: [], sources: ['../src/two.ts'], sourcesContent: ['second();'], mappings: 'AAAA', sourceRoot: '' };
  const mapFor = file => file === b.meta.clientPath ? map : undefined;
  for (const records of [[a], [b], [a, b]]) for (const revision of [undefined, 'first', 'updated']) {
    let reads = 0;
    const expected = before.buildCombo(records, mapFor, revision);
    const actual = after.buildCombo(records, file => { reads++; return mapFor(file); }, revision);
    sameArtifact(actual, expected);
    assert.equal(actual.scriptBody(), actual.scriptBody(), 'Repeated requests share the generated script');
    assert.deepEqual(await actual.scriptBody(), await expected.scriptBody());
    assert.equal(reads, 0, 'Script requests must not load debug maps');
    assert.equal(actual.sourceMapBody(), actual.sourceMapBody(), 'Repeated requests share the generated map');
    assert.deepEqual(await actual.sourceMapBody(), await expected.sourceMapBody());
    assert.equal(reads, records.length);
  }
});
