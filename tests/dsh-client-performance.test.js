'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const patch = require('../integrations/dsh/client-performance.cjs');

const runtime = process.env.DSH_PERFORMANCE_RUNTIME_DIR || path.resolve(__dirname, '../runtimes/dsh');
const modules = path.join(runtime, 'node_modules/@deepseek-ai/dsh-client-modules');
const file = path.join(modules, 'lib/index.js');
const version = fs.existsSync(file) ? JSON.parse(fs.readFileSync(path.join(modules, 'package.json'))).version : null;
function functions(source) {
  return vm.runInNewContext(source.replace(/^import .+;\r?$/gm, '').replace(/^export .+;\r?$/gm, '') +
    '\n({ newlineCount, buildCombo, ClientModuleRegistry })', { Buffer, URL, Service: class {}, ...crypto });
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

test('0.2 client preserves lazy scripts, source maps and shared responses after the line-scan patch', { skip: version !== '0.2.0-rc.2' && 'Requires the 0.2 client' }, async () => {
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
