'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const sourceRoot = path.join(__dirname, '../android/app/src/androidTest/java/app/camellia/mobile');

function planShards(classes, count, { directory = sourceRoot, gatewayWeight = 36 } = {}) {
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 8 && count <= classes.length, 'Choose 1 to 8 nonempty Android shards');
  assert.equal(new Set(classes).size, classes.length, 'Android suites must not be listed twice');
  const suites = classes.map((name, order) => {
    assert.match(name, /^[A-Za-z][A-Za-z0-9]*Test$/, 'Use an Android test class name');
    const source = fs.readFileSync(path.join(directory, name + '.java'), 'utf8');
    const tests = [...source.matchAll(/\bpublic\s+void\s+test\w+\s*\(/g)].length;
    assert.ok(tests > 0, 'No instrumentation tests found in ' + name);
    return { name, tests, order };
  });
  // The first runner also executes pairing/gateway/discussion integration.
  // Reserve approximately three minutes there instead of assigning it the
  // same UI load as the other runners. Every suite stays intact.
  const shards = Array.from({ length: count }, (_, index) => ({ classes: [], tests: 0,
    weight: count > 1 && index === 0 ? gatewayWeight : 0 }));
  const ordered = suites.slice().sort((a, b) => b.tests - a.tests || a.order - b.order);
  for (const [index, suite] of ordered.entries()) {
    const empty = shards.filter(shard => !shard.classes.length);
    const candidates = ordered.length - index === empty.length ? empty : shards;
    const target = candidates.reduce((best, shard) => shard.weight < best.weight ? shard : best);
    target.classes.push(suite); target.tests += suite.tests; target.weight += suite.tests;
  }
  for (const shard of shards) shard.classes = shard.classes.sort((a, b) => a.order - b.order).map(suite => suite.name);
  assert.ok(shards.every(shard => shard.classes.length), 'Every Android shard must execute tests');
  assert.deepEqual(shards.flatMap(shard => shard.classes).sort(), classes.slice().sort(), 'Android test coverage changed');
  return shards;
}

function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    index: { type: 'string' }, total: { type: 'string' }, 'source-root': { type: 'string' },
  } });
  const count = Number(values.total), index = Number(values.index);
  assert.ok(Number.isInteger(index) && index >= 1 && index <= count, 'Invalid Android shard index');
  const shards = planShards(positionals, count, values['source-root'] ? { directory: path.resolve(values['source-root']) } : {});
  const selected = shards[index - 1];
  console.error(`Android UI shard ${index}/${count}: ${selected.classes.length} classes, approximately ${selected.tests} tests${index === 1 ? ', plus gateway integration' : ''}`);
  console.log(selected.classes.map(name => 'app.camellia.mobile.' + name).join(','));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { planShards };
