'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const patch = require('../integrations/dsh/client-performance.cjs');

const file = path.resolve(__dirname, '../runtimes/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js');
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

test('client startup patch preserves bundle bytes, revisions, maps and HMR updates', { skip: !fs.existsSync(file) && 'Run npm run setup:runtimes first' }, () => {
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
