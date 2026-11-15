'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { casesFor, partitionCases, verifyCoverage, runWorkers } = require('./harness-thinking-smoke.cjs');
const { planShards } = require('../scripts/android-ci-shards.cjs');
const { removeTree } = require('./test-fs.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-ci-parallel-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-ci-parallel-'));
    removeTree(root);
  });
  return root;
}
const passedRow = row => ({ engine: row.engine, model: row.profile.model, selected: row.level || 'default', ok: true });

test('all 126 native thinking cases survive partitioning, including Boolean and default controls', () => {
  const cases = casesFor();
  assert.equal(cases.length, 126);
  for (const count of [1, 2, 3, 4, 8]) {
    const groups = partitionCases(cases, count);
    verifyCoverage(groups.flat().map(passedRow), cases);
    assert.ok(Math.max(...groups.map(g => g.length)) - Math.min(...groups.map(g => g.length)) <= 1);
  }
  for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok']) {
    const selected = cases.filter(row => row.engine === engine);
    assert.equal(selected.length, 21);
    assert.deepEqual(selected.filter(row => row.profile.model === 'kimi-k2.6').map(row => row.level), ['', 'none', 'high']);
  }
  assert.throws(() => partitionCases(cases, 0));
  assert.throws(() => partitionCases(cases, 9));
});

for (const mode of ['complete', 'missing', 'duplicate', 'failed']) {
  test(`native worker aggregation rejects incomplete success and propagates failures: ${mode}`, async t => {
    const root = temporary(t), cases = casesFor(['grok']);
    const fixture = path.join(root, 'worker.cjs'), input = path.join(root, 'expected.json');
    fs.writeFileSync(input, JSON.stringify(cases.map(passedRow)));
    fs.writeFileSync(fixture, `
      const fs = require('node:fs'), path = require('node:path');
      const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
      const index = Number(option('--worker-index')), count = Number(option('--worker-count'));
      if (process.env.WORKER_MODE === 'failed' && index === 1) process.exit(7);
      let rows = JSON.parse(fs.readFileSync(process.env.WORKER_CASES, 'utf8')).filter((_, at) => at % count === index);
      if (index === 0 && process.env.WORKER_MODE === 'missing') rows.pop();
      if (index === 0 && process.env.WORKER_MODE === 'duplicate') rows[1] = rows[0];
      const root = option('--worker-root'); fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows));
    `);
    const task = runWorkers(['grok'], 4, path.join(root, 'results'), { script: fixture,
      env: { ...process.env, WORKER_CASES: input, WORKER_MODE: mode } });
    if (mode === 'complete') {
      await task;
      const rows = JSON.parse(fs.readFileSync(path.join(root, 'results/results.json'), 'utf8'));
      assert.equal(rows.length, 21);
    } else await assert.rejects(task);
  });
}

test('Android shards keep whole classes, cover every suite once and reserve gateway capacity', t => {
  const root = temporary(t), names = ['HeavyTest', 'MediumTest', 'SmallTest', 'TailTest', 'OtherTest'];
  const counts = [50, 40, 30, 20, 10];
  names.forEach((name, at) => fs.writeFileSync(path.join(root, name + '.java'),
    Array.from({ length: counts[at] }, (_, index) => `public void testScenario${index}() {}`).join('\n')));
  const shards = planShards(names, 3, { directory: root });
  assert.deepEqual(shards.flatMap(shard => shard.classes).sort(), names.slice().sort());
  assert.equal(shards.reduce((sum, shard) => sum + shard.tests, 0), 150);
  assert.ok(shards[0].tests < Math.max(...shards.slice(1).map(shard => shard.tests)));
  assert.deepEqual(planShards(names, 3, { directory: root }), shards, 'Repeated selection must be deterministic');
  assert.throws(() => planShards([...names, names[0]], 3, { directory: root }), /twice/);
  assert.throws(() => planShards([...names, 'MissingTest'], 3, { directory: root }), /ENOENT/);
});

test('small Android selections still execute a nonempty shard each', t => {
  const root = temporary(t), names = ['OneTest', 'TwoTest', 'ThreeTest'];
  for (const name of names) fs.writeFileSync(path.join(root, name + '.java'), 'public void testOne() {}');
  const shards = planShards(names, 3, { directory: root });
  assert.ok(shards.every(shard => shard.tests === 1));
});

const workflow = name => YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/' + name + '.yml'), 'utf8'));
test('Android SDK preparation makes avdmanager available in a fresh CI step', t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!fs.existsSync(bash)) return t.skip('Bash is unavailable');
  const root = temporary(t);
  const tools = path.join(root, 'sdk/cmdline-tools/latest/bin'), java = path.join(root, 'jdk');
  fs.mkdirSync(tools, { recursive: true }); fs.mkdirSync(path.join(java, 'bin'), { recursive: true });
  for (const [name, output] of [['sdkmanager', 'sdk prepared'], ['avdmanager', 'AVD_MANAGER_FOUND']]) {
    const file = path.join(tools, name);
    fs.writeFileSync(file, '#!/bin/bash\nprintf "%s\\n" "' + output + '"\n');
    fs.chmodSync(file, 0o755);
  }
  const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : value;
  const environment = path.join(root, 'github-env'), githubPath = path.join(root, 'github-path');
  const env = { ...process.env, PATH: '/usr/bin:/bin', ANDROID_HOME: shellPath(path.join(root, 'sdk')),
    JAVA_HOME_17_X64: shellPath(java), GITHUB_ENV: shellPath(environment), GITHUB_PATH: shellPath(githubPath) };
  const prepare = workflow('android').jobs.ui.steps.find(step => step.name === 'Prepare emulator SDK').run;
  const result = spawnSync(bash, ['-e', '-c', prepare], { env, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(githubPath), 'SDK command paths must survive the preparation shell');
  const paths = fs.readFileSync(githubPath, 'utf8').trim().split(/\r?\n/);
  const next = spawnSync(bash, ['-e', '-c', 'avdmanager list avd'], { windowsHide: true, encoding: 'utf8',
    env: { ...env, PATH: [...paths, '/usr/bin', '/bin'].join(':') } });
  assert.equal(next.status, 0, next.stderr || next.stdout);
  assert.match(next.stdout, /AVD_MANAGER_FOUND/);
});

test('desktop acceptance depends only on its own platform and keeps the four public checks', () => {
  const { jobs } = workflow('desktop'), names = [];
  for (const [buildId, acceptanceId, platform] of [['build', 'acceptance', 'windows'], ['build-macos', 'acceptance-macos', 'macos']]) {
    const build = jobs[buildId], acceptance = jobs[acceptanceId];
    assert.equal(acceptance.needs, buildId);
    assert.deepEqual(build.strategy.matrix.include.map(row => row.platform), [platform]);
    assert.equal(build.strategy.matrix.include[0].thinking_jobs, platform === 'windows' ? 2 : 4);
    assert.deepEqual(acceptance.strategy.matrix.include.map(row => row.platform), [platform]);
    for (const job of [build, acceptance]) {
      const row = job.strategy.matrix.include[0];
      names.push(job.name.replace('${{ matrix.platform }}', row.platform).replace('${{ matrix.arch }}', row.arch));
    }
    assert.ok(build.steps.findIndex(s => s.name === 'Data directory migration progress window')
      < build.steps.findIndex(s => s.name === 'Native API thinking controls'));
  }
  assert.deepEqual(names.sort(), ['windows / x64', 'macos / arm64', 'Acceptance / windows / x64', 'Acceptance / macos / arm64'].sort());
  assert.deepEqual(jobs.build.steps, jobs['build-macos'].steps);
  assert.ok(jobs.build.steps.find(step => step.name === 'Upload smoke diagnostics on failure').with.path
    .includes('artifacts/harness-thinking-smoke-*/**/results.json'));
  assert.deepEqual(jobs.acceptance.steps, jobs['acceptance-macos'].steps);
});

test('Android aggregate requires the package and all shards, including on failure or cancellation', t => {
  const { jobs, on: triggers } = workflow('android');
  for (const trigger of ['push', 'pull_request']) assert.ok(triggers[trigger].paths.includes('scripts/android-ci-shards.cjs'));
  assert.equal(jobs.build.name, 'build');
  assert.equal(jobs.build.if, 'always()');
  assert.deepEqual(jobs.build.needs, ['package', 'ui']);
  assert.equal(jobs.ui.needs, 'package');
  assert.deepEqual(jobs.ui.strategy.matrix.shard, [1, 2, 3]);
  assert.equal(jobs.ui.strategy['fail-fast'], false);
  const run = jobs.ui.steps.find(step => step.name === 'Android UI and gateway integration');
  assert.equal(Number(run.env.SHARD_COUNT), jobs.ui.strategy.matrix.shard.length);
  const classes = run.run.match(/ui_classes=\(([\s\S]*?)\)/)[1].trim().split(/\s+/);
  assert.equal(new Set(classes).size, classes.length);
  for (const name of ['ModernSettingsLayoutTest', 'NavigationVeilTest', 'UiConsistencyTest']) assert.ok(classes.includes(name), name);
  const gateway = run.run.match(/if \[ "\$SHARD" = 1 \]; then([\s\S]*?)\nfi/)[1];
  for (const fixture of ['pairing', 'gateway', 'discussions']) assert.match(gateway, new RegExp('android-' + fixture + '-smoke\\.cjs'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!fs.existsSync(bash)) return t.skip('Bash is unavailable');
  for (const [packageResult, uiResult] of [['success', 'success'], ['failure', 'success'], ['success', 'failure'], ['success', 'cancelled'], ['skipped', 'skipped']]) {
    const result = spawnSync(bash, ['-e', '-c', jobs.build.steps[0].run], { windowsHide: true, encoding: 'utf8',
      env: { ...process.env, PACKAGE_RESULT: packageResult, UI_RESULT: uiResult } });
    assert.equal(result.status === 0, packageResult === 'success' && uiResult === 'success', packageResult + '/' + uiResult);
  }
});
