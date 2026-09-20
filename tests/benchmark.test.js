'use strict';
const { removeTree } = require('./test-fs.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BenchmarkRunner, summarize, collectChanges, PREVIEW } = require('../src/benchmark/runner');
const { comparisonNotes, taskWarnings } = require('../src/benchmark/diagnostics');
const { createHash } = require('node:crypto');
const { TASKS, SUITES, VERSION, prepareTask, verifyTask } = require('../src/benchmark/tasks');
const { spawnSync } = require('node:child_process');
const { ENGINES, isolatedEnvironment, stopProcess } = require('../src/benchmark/engines');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { RequestScopes } = require('../src/api/request-scopes');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-bench-test-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('camellia-bench-test-')); removeTree(dir); });
  return dir;
}
const fixes = {
  'slug-basic': "module.exports = text => text.trim().toLowerCase().split(/\\s+/).join('-');",
  slug: "module.exports = value => String(value ?? '').normalize('NFKD').replace(/\\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');",
  invoice: "exports.total=(items,d=0,t=0)=>{const subtotal=items.reduce((n,i)=>n+Math.round(Number(i.price)*100)*i.quantity,0),discount=Math.round(subtotal*d/10000),tax=Math.round((subtotal-discount)*t/10000);return{subtotal,discount,tax,total:subtotal-discount+tax}};",
  intervals: "module.exports = a => {const r=[]; for(const x of a.filter(x=>Array.isArray(x)&&x.length===2&&x.every(Number.isFinite)&&x[0]<=x[1]).map(x=>[...x]).sort((a,b)=>a[0]-b[0])){if(r.length&&r.at(-1)[1]>=x[0])r.at(-1)[1]=Math.max(r.at(-1)[1],x[1]);else r.push(x);}return r;};",
  retry: "module.exports=(s,a,r=null)=>[429,500,502,503,504].includes(s)&&a<3?{retry:true,delayMs:Math.min(8000,typeof r==='number'&&Number.isFinite(r)&&r>=0?Math.round(r*1000):250*2**a)}:{retry:false,delayMs:0};",
};

test('timeout cleanup releases inherited pipes after the native process exits', { timeout: 3000 }, async () => {
  const proc = Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let closed = 0, terminated = false;
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) stream.once('close', () => {
    if (++closed === 3) proc.emit('close', proc.exitCode);
  });
  // No OS PID is touched. Exit arrived, but close waits for inherited pipes.
  await stopProcess(proc, async child => { terminated = true; child.exitCode = 1; child.emit('exit', 1); });
  assert.equal(terminated, true); assert.equal(closed, 3);
  await stopProcess(proc, () => { throw new Error('Never kill a PID after its process has exited'); });
});

test('capture preserves the complete graded Python source ahead of scratch files and ignores binary caches', t => {
  const root = temp(t), source = '# scientific code\n'.repeat(5000);
  fs.mkdirSync(path.join(root, '__pycache__'));
  fs.writeFileSync(path.join(root, '__pycache__', 'module.pyc'), 'not source');
  fs.writeFileSync(path.join(root, 'a.dat'), Buffer.from([1, 0, 2]));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `scratch-${i}.txt`), 'scratch');
  fs.writeFileSync(path.join(root, 'solution.py'), source);
  const changes = collectChanges({ library: 'scicode', files: { 'solution.py': '# starter' } }, root);
  assert.equal(changes[0].path, 'solution.py'); assert.equal(changes[0].after, source);
  assert.equal(changes[0].sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(changes.filter(c => c.path === 'solution.py').length, 1);
  assert.ok(changes.every(c => !c.path.includes('__pycache__') && c.path !== 'a.dat'));
});

test('comparison notices flag shared failures without treating repeats as separate engines or changing scores', () => {
  const rows = ['claude', 'codex', 'dsh'].map(engine => ({ engine, repeat: 1, task: 'scicode:46', status: 'failed',
    verification: { checks: { total: 14, passed: 7, failures: [{ kind: 'assertion', case: '46.3 / 1' }] } } }));
  const report = { versions: {}, tasks: [{ id: 'scicode:46' }], trials: rows };
  assert.equal(comparisonNotes(report).length, 2);
  assert.equal(comparisonNotes(report).find(n => n.kind === 'shared_failures').cases[0], '46.3 / 1');
  assert.ok(summarize(report).every(r => r.checkScore === 50));
  assert.equal(comparisonNotes({ ...report, trials: rows.map(r => ({ ...r, engine: 'claude' })) }).length, 1);
  assert.equal(comparisonNotes({ ...report, trials: rows.map((r, i) => ({ ...r, repeat: i + 1 })) }).length, 1);
  assert.equal(taskWarnings('scicode:46', { revision: 'different-dataset' }).length, 0);
});
test('all task verifiers reject unfinished work and accept independently supplied solutions', async t => {
  const root = temp(t);
  for (const task of TASKS) {
    const cwd = path.join(root, task.id), env = isolatedEnvironment(path.join(root, 'home-' + task.id), process.execPath);
    prepareTask(task, cwd);
    assert.equal((await verifyTask(task, cwd, process.execPath, env)).passed, false, task.id + ' starter');
    if (task.probe) fs.writeFileSync(path.join(cwd, task.probe.file), fixes[task.id]);
    else { fs.mkdirSync(path.join(cwd, 'output')); fs.writeFileSync(path.join(cwd, task.output), JSON.stringify(task.expected)); }
    if (task.id === 'invoice') {
      assert.equal((await verifyTask(task, cwd, process.execPath, env)).passed, false, 'The money helper must also be fixed');
      fs.writeFileSync(path.join(cwd, 'money.cjs'), 'exports.cents = price => Math.round(Number(price) * 100);');
    }
    const verdict = await verifyTask(task, cwd, process.execPath, env);
    assert.equal(verdict.passed, true, task.id + ': ' + verdict.detail);
    if (task.preserve) { fs.writeFileSync(path.join(cwd, task.preserve[0]), 'tampered'); assert.equal((await verifyTask(task, cwd, process.execPath, env)).passed, false); }
  }
});
test('candidate verification cannot write files or read outside its workspace', async t => {
  const root = temp(t), cwd = path.join(root, 'workspace'), task = TASKS.find(t => t.id === 'slug'); prepareTask(task, cwd);
  const target = path.join(root, 'outside'); fs.writeFileSync(target, 'private');
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), `module.exports=()=>require('node:fs').readFileSync(${JSON.stringify(target)},'utf8')`);
  const verdict = await verifyTask(task, cwd, process.execPath, isolatedEnvironment(path.join(root, 'home'), process.execPath));
  assert.equal(verdict.passed, false); assert.match(verdict.detail, /restricted|permission|Access/i);
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), "module.exports=()=>require('node:fs').writeFileSync('written','oops')");
  assert.equal((await verifyTask(task, cwd, process.execPath, isolatedEnvironment(path.join(root, 'home'), process.execPath))).passed, false);
  assert.equal(fs.existsSync(path.join(cwd, 'written')), false);
});

test('entry task has working public checks while independent grading still rejects incorrect code', async t => {
  const root = temp(t), cwd = path.join(root, 'workspace');
  const task = TASKS.find(t => t.id === SUITES.find(s => s.id === 'quick').taskIds[0]);
  const env = isolatedEnvironment(path.join(root, 'home'), process.execPath);
  prepareTask(task, cwd);
  const runChecks = () => spawnSync(process.execPath, ['check.cjs'], { cwd, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(task.id, 'slug-basic');
  assert.ok(task.probe.inputs.every(([input]) => /^[a-zA-Z0-9\s]*$/.test(input)));
  assert.equal(runChecks().status, 1, 'Public checks expose the starter bug');
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), fixes['slug-basic']);
  const result = runChecks();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6\/6 checks passed/);
  assert.equal((await verifyTask(task, cwd, process.execPath, env)).checks.passed, 6);
  fs.writeFileSync(path.join(cwd, 'check.cjs'), "console.log('6/6 checks passed');");
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), "module.exports = () => '';\n");
  assert.equal((await verifyTask(task, cwd, process.execPath, env)).passed, false, 'Editing self-tests cannot fabricate a pass');
  assert.ok(!SUITES.find(s => s.id === 'quick').taskIds.includes('slug'));
  assert.ok(SUITES.find(s => s.id === 'standard').taskIds.includes('slug'));
});

test('Unicode boundary failure reports 11/12 checks and exact escaped input, expected and actual values', async t => {
  const root = temp(t), cwd = path.join(root, 'workspace'), task = TASKS.find(t => t.id === 'slug'); prepareTask(task, cwd);
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), fixes.slug.replace('/\\p{M}/gu', '/[\\u0300-\\u036f]/g'));
  const verdict = await verifyTask(task, cwd, process.execPath, isolatedEnvironment(path.join(root, 'home'), process.execPath));
  assert.equal(verdict.passed, false); assert.equal(verdict.detail, '11/12 checks passed');
  assert.equal(verdict.checks.passed, 11); assert.equal(verdict.checks.evaluated, 12);
  assert.deepEqual(verdict.checks.failures, [{ kind: 'output', file: 'slug.cjs', case: 11, input: '["a\\u1ab0b"]', expected: '"ab"', actual: '"a-b"' }]);
});

test('per-case exceptions, input mutation and unavailable code produce distinct diagnostics', async t => {
  const root = temp(t), cwd = path.join(root, 'workspace'), task = TASKS.find(t => t.id === 'slug'); prepareTask(task, cwd);
  const env = isolatedEnvironment(path.join(root, 'home'), process.execPath);
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), "module.exports=()=>{throw Error('Fixture function error')}");
  const thrown = await verifyTask(task, cwd, process.execPath, env);
  assert.equal(thrown.passed, false); assert.equal(thrown.checks.evaluated, 12);
  assert.ok(thrown.checks.failures.every(f => f.kind === 'exception' && f.error === 'Fixture function error'));
  const immutable = { probe: { file: 'slug.cjs', inputs: [[[[1, 2]]]], immutable: true }, expected: [[[1, 2]]] };
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), 'module.exports=a=>{a.push([9,9]);return [[1,2]]}');
  const mutated = await verifyTask(immutable, cwd, process.execPath, env);
  assert.equal(mutated.passed, false); assert.equal(mutated.checks.failures[0].kind, 'input_mutated');
  fs.unlinkSync(path.join(cwd, 'slug.cjs'));
  const missing = await verifyTask(task, cwd, process.execPath, env);
  assert.equal(missing.passed, false); assert.equal(missing.checks.evaluated, 0);
  assert.equal(missing.checks.total, 12); assert.equal(missing.checks.failures[0].kind, 'execution');
});

test('file checks distinguish wrong output, malformed JSON and modified required inputs', async t => {
  const root = temp(t), cwd = path.join(root, 'workspace'), task = TASKS.find(t => t.id === 'reconcile'); prepareTask(task, cwd);
  const env = isolatedEnvironment(path.join(root, 'home'), process.execPath);
  fs.mkdirSync(path.join(cwd, 'output')); fs.writeFileSync(path.join(cwd, task.output), '[]');
  const mismatch = await verifyTask(task, cwd, process.execPath, env);
  assert.equal(mismatch.checks.passed, 1); assert.equal(mismatch.checks.total, 2);
  assert.equal(mismatch.checks.failures[0].kind, 'output'); assert.equal(mismatch.checks.failures[0].actual, '[]');
  fs.writeFileSync(path.join(cwd, task.output), '{');
  assert.equal((await verifyTask(task, cwd, process.execPath, env)).checks.failures[0].kind, 'invalid_json');
  fs.writeFileSync(path.join(cwd, task.output), JSON.stringify(task.expected));
  fs.writeFileSync(path.join(cwd, task.preserve[0]), 'modified');
  const changed = await verifyTask(task, cwd, process.execPath, env);
  assert.equal(changed.passed, false); assert.equal(changed.checks.failures[0].kind, 'input_changed');
});

test('grading works when the workspace sits behind a symlink, like the macOS temp dir', async t => {
  const root = temp(t), real = path.join(root, 'real'), link = path.join(root, 'link');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link, 'junction');
  const cwd = path.join(link, 'workspace'), task = TASKS.find(t => t.id === 'slug'); prepareTask(task, cwd);
  const env = isolatedEnvironment(path.join(root, 'home'), process.execPath);
  fs.writeFileSync(path.join(cwd, 'slug.cjs'), fixes.slug);
  const verdict = await verifyTask(task, cwd, process.execPath, env);
  assert.equal(verdict.passed, true, verdict.detail);
  assert.equal(verdict.checks.evaluated, 12);
});
function setupRunner(t, execute) {
  const root = temp(t), scopes = new RequestScopes();
  const router = { getState: () => ({ enabled: true, running: true, usage: {}, providers: [{ id: 'p', name: 'Fixture', enabled: true,
    keys: [{ id: 'k', enabled: true }], models: [{ id: 'm', upstream: 'upstream-m' }] }] }),
    createScope: opts => scopes.create({ ...opts, upstream: 'upstream-m' }) };
  const options = { directory: root, runtimes: () => ({ locate: () => ({ version: 'test' }) }), node: () => process.execPath,
    getRouter: () => router, execute, verify: async () => ({ passed: true, detail: 'Fixture verifier' }) };
  const runner = new BenchmarkRunner(options);
  t.after(() => runner.shutdown());
  return { runner, options, root, scopes };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function controlledRunner(t) {
  const calls = [];
  const setup = setupRunner(t, args => new Promise(resolve => {
    const call = { ...args, done: false, finish: (result = { ok: true }) => { call.done = true; resolve(result); } };
    args.signal.addEventListener('abort', () => call.finish({ ok: false, cancelled: true }), { once: true });
    calls.push(call);
  }));
  return { ...setup, calls };
}

test('preview enforces the same small sample and limits regardless of stale setup selections', async t => {
  const { runner } = setupRunner(t, async () => ({ ok: true }));
  const { id } = runner.start({ model: 'm', providerId: 'p', mode: 'preview', suite: 'scicode-full', repeats: 3,
    timeoutSeconds: 3600, maxTokensPerTask: 5000000, tokenBudget: 10000 });
  const report = runner.report(id);
  for (const [key, value] of Object.entries(PREVIEW)) assert.equal(report[key], value, key);
  assert.equal(report.library.id, 'builtin'); assert.equal(report.trials.length, 15);
  assert.equal(report.version, VERSION);
  assert.deepEqual(report.tasks.map(task => task.id), ['slug-basic', 'reconcile', 'invoice']);
  await runner.pending;
  assert.equal(runner.report(id).status, 'completed');
});

test('benchmark captures API tool failures without GUI events and deduplicates native GUI reports', async t => {
  const { runner } = setupRunner(t, async args => {
    const id = 'failed-shell';
    if (args.engine === 'kimi') args.onEvent({ type: 'gui:tool', id: '0:' + id, name: 'Bash', status: 'failed', output: 'early report' });
    const request = { messages: [
      { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: '{"command":"exit 7"}' } }] },
      { role: 'tool', tool_call_id: id, content: '\nThe command exited with code 7.\nOutput:\nactual native diagnostic' },
    ] };
    args.route.scope.observeTools(request, 'openai'); args.route.scope.observeTools(request, 'openai');
    return { ok: true };
  });
  const { id } = runner.start({ model: 'm', providerId: 'p', mode: 'preview' }); await runner.pending;
  for (const trial of runner.report(id).trials) {
    assert.equal(trial.toolFailureCount, 1, trial.engine);
    assert.match(trial.toolFailures[0].output, /actual native diagnostic/);
    assert.equal(trial.checkScore, 100, 'A recovered tool failure does not override independent grading');
  }
});

test('native success cannot conceal an unrecovered agent API failure behind a successful title request', async t => {
  let verifications = 0;
  const { runner } = setupRunner(t, async args => {
    args.route.scope.record({ hasTools: true, outcome: 'error', error: 'EXPECTED_UPSTREAM_FAILURE', tokens: { reported: false } });
    args.route.scope.record({ hasTools: false, outcome: 'success', tokens: { reported: true } });
    return { ok: true };
  });
  runner.verify = async () => { verifications++; return { passed: true, detail: 'Should not grade after terminal API error' }; };
  const { id } = runner.start({ model: 'm', providerId: 'p', mode: 'preview' }); await runner.pending;
  for (const trial of runner.report(id).trials) {
    assert.equal(trial.status, 'error'); assert.equal(trial.checkScore, 0);
    assert.equal(trial.error, 'EXPECTED_UPSTREAM_FAILURE');
  }
  assert.equal(verifications, 0);
});

test('full-library mode selects every built-in task and has no preview deadline', async t => {
  const { runner } = setupRunner(t, async () => ({ ok: true }));
  const { id } = runner.start({ model: 'm', providerId: 'p', mode: 'full', library: 'builtin', suite: 'quick' });
  const report = runner.report(id);
  assert.equal(report.suite, 'standard'); assert.equal(report.mode, 'full'); assert.equal(report.maxDurationSeconds, null);
  assert.equal(report.trials.length, TASKS.length * ENGINES.length);
  await runner.pending;
  assert.ok(runner.report(id).engines.every(e => e.checkScore === 100));
});

test('preview tasks share time so early or late tasks can exceed 90 seconds within the same whole-run deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const { runner, calls } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p', mode: 'preview' }); await tick();
  t.mock.timers.tick(110000);
  assert.ok(calls.every(c => !c.signal.aborted));
  for (const call of calls.filter(c => !c.done)) call.finish(); await tick();
  assert.ok(runner.report(id).trials.filter(t => t.status === 'running').every(t => t.timeoutSeconds === 160));
  t.mock.timers.tick(35000);
  for (const call of calls.filter(c => !c.done)) call.finish(); await tick();
  assert.ok(runner.report(id).trials.filter(t => t.status === 'running').every(t => t.timeoutSeconds === 125));
  // The old 75-second policy would have stopped this task before it completed.
  t.mock.timers.tick(100000);
  assert.ok(calls.filter(c => !c.done).every(c => !c.signal.aborted));
  for (const call of calls.filter(c => !c.done)) call.finish(); await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'completed'); assert.equal(report.maxDurationSeconds, 300);
  assert.ok(report.engines.every(e => e.checkScore === 100));
});

test('timed-out work saves request duration, activity and changed files without changing its score', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const { runner, calls } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p', mode: 'preview' }); await tick();
  const call = calls.find(c => c.engine === 'codex');
  call.onEvent({ type: 'gui:tool', name: 'fileChange', status: 'completed' });
  for (let i = 0; i < 12; i++) call.onEvent({ type: 'gui:tool', name: 'commandExecution', status: 'completed', is_error: true,
    input: { command: 'apply_patch $patch' }, output: 'Invalid patch: The last line of the patch must be End Patch.\n' + 'x'.repeat(2000) });
  fs.writeFileSync(path.join(call.cwd, 'working.txt'), 'unfinished work');
  call.route.scope.begin({ hasTools: true });
  t.mock.timers.tick(10000);
  call.route.scope.record({ sequence: 1, durationMs: 10000, outcome: 'success', finishReason: 'tool_calls', tokens: { reported: true } });
  call.route.scope.begin({ hasTools: true });
  t.mock.timers.tick(260000); await tick();
  const trial = runner.report(id).trials.find(t => t.engine === 'codex' && t.task === 'slug-basic');
  assert.equal(trial.status, 'timeout'); assert.equal(trial.checkScore, 0);
  assert.deepEqual(trial.timeoutContext, { activity: 'Waiting for model response', requestsInFlight: 1 });
  assert.ok(trial.timeline.some(e => e.detail === 'Completed tool: fileChange'));
  assert.equal(trial.toolFailureCount, 12); assert.equal(trial.toolFailures.length, 10);
  assert.equal(trial.toolFailures[0].output.length, 1500);
  assert.ok(trial.timeline.some(e => e.type === 'tool_error' && e.detail.includes('Invalid patch')));
  assert.equal(trial.apiRequests[0].durationMs, 10000);
  assert.ok(trial.changes.some(c => c.path === 'working.txt'));
  await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'time_limit_reached');
  assert.equal(report.trials.filter(t => t.status === 'timeout').length, 5);
  assert.equal(report.trials.filter(t => t.status === 'skipped').length, 10);
  assert.ok(report.trials.filter(t => t.status === 'skipped').every(t => t.checkScore === null));
});

test('preview deadline closes all routes, keeps partial evidence and excludes unstarted work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const { runner, calls, scopes } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p', mode: 'preview' }); await tick();
  for (const call of calls) call.finish(); await tick();
  assert.ok(runner.report(id).engines.every(e => e.observedCheckScore === 100 && e.coverage === 33.3 && e.checkScore === null));
  // Simulate slow work between trials. The run deadline must cover time outside
  // a task's native execution timer as well as time within it.
  t.mock.timers.setTime(1000000 + 299000);
  t.mock.timers.tick(1000); await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'time_limit_reached'); assert.equal(calls.length, 10);
  assert.equal(report.trials.filter(t => t.status === 'passed').length, 5);
  assert.equal(report.trials.filter(t => t.status === 'timeout').length, 5);
  assert.equal(report.trials.filter(t => t.status === 'skipped').length, 5);
  assert.ok(report.engines.every(e => e.checkScore === null && e.observedCheckScore === 50 && e.coverage === 66.7));
  assert.equal(scopes.scopes.size, 0); assert.equal(runner.state().busy, false);
  assert.ok(calls.every(c => !fs.existsSync(c.cwd)));
});

test('live scores retain equal attempt weights and never count pending work as failure', () => {
  const result = summarize({ versions: {}, trials: [
    { engine: 'dsh', status: 'failed', verification: { checks: { passed: 11, total: 12 } } },
    { engine: 'dsh', status: 'pending' }, { engine: 'dsh', status: 'skipped' },
  ] })[0];
  assert.equal(result.checkScore, null); assert.equal(result.observedCheckScore, 91.7);
  assert.equal(result.observedPassRate, 0); assert.equal(result.coverage, 33.3);
  const invalid = summarize({ versions: {}, trials: [{ engine: 'dsh', status: 'grader_error' }, { engine: 'dsh', status: 'pending' }] })[0];
  assert.equal(invalid.observedCheckScore, null); assert.equal(invalid.observedPassRate, null);
});
test('all engines run concurrently and advance independently with one active trial per engine', async t => {
  const { runner, calls, scopes, root } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p' });
  assert.equal(runner.state().busy, true);
  await tick();
  assert.equal(calls.length, ENGINES.length);
  assert.equal(new Set(calls.map(c => c.engine)).size, ENGINES.length);
  assert.equal(runner.report(id).trials.filter(t => t.status === 'running').length, ENGINES.length);
  assert.equal(scopes.scopes.size, ENGINES.length);
  for (let wave = 0; wave < 3; wave++) {
    for (const call of calls.filter(c => !c.done && c.engine !== 'claude')) {
      call.route.scope.record({ tokens: { input: ENGINES.indexOf(call.engine) * 10, output: 1, reported: true } });
      call.finish();
    }
    await tick();
    assert.ok(ENGINES.every(engine => calls.filter(c => c.engine === engine && !c.done).length <= 1));
  }
  const midway = runner.report(id);
  assert.ok(midway.engines.filter(e => e.id !== 'claude').every(e => e.score === 100));
  assert.equal(midway.trials.filter(t => t.engine === 'claude' && t.status === 'running').length, 1);
  assert.equal(midway.finishedAt, null);
  assert.equal(runner.state().busy, true);
  for (let wave = 0; wave < 3; wave++) { calls.find(c => !c.done).finish(); await tick(); }
  await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'completed'); assert.equal(calls.length, 15);
  assert.deepEqual(report.engines.map(e => e.tokens), [0, 33, 63, 93, 123]);
  assert.equal(new Set(calls.map(c => c.cwd)).size, calls.length);
  assert.equal(new Set(calls.map(c => c.home)).size, calls.length);
  assert.equal(new Set(calls.map(c => c.route.path)).size, calls.length);
  assert.ok(calls.every(c => !fs.existsSync(c.cwd)));
  assert.equal(scopes.scopes.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, id + '.json'))).execution,
    { mode: 'parallel-engines', maxConcurrentTrials: ENGINES.length, perEngineConcurrency: 1 });
});
test('runner isolates every attempt, counts every repeat, saves evidence and keeps API usage separate', async t => {
  const folders = new Set();
  const { runner, root } = setupRunner(t, async ({ cwd, route, engine }) => {
    assert.equal(folders.has(cwd), false); folders.add(cwd);
    assert.equal(fs.existsSync(path.join(cwd, 'marker')), false); fs.writeFileSync(path.join(cwd, 'marker'), engine);
    route.scope.record({ tokens: { input: 12, output: 5, reported: true }, outcome: 'success' });
    return { ok: engine !== 'kimi', error: engine === 'kimi' ? 'Fixture error' : null };
  });
  const { id } = runner.start({ model: 'm', providerId: 'p', repeats: 3 });
  assert.equal(runner.report(id).timeoutSeconds, 300);
  assert.equal(runner.report(id).tokenBudget, null);
  assert.equal(runner.report(id).maxTokensPerTask, 250000);
  assert.throws(() => runner.start({ model: 'm', providerId: 'p' }), /already running/);
  await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'completed'); assert.equal(report.trials.length, 45); assert.equal(folders.size, 45);
  assert.deepEqual(report.engines.map(e => e.score), [100, 100, 100, 0, 100]);
  assert.ok(report.engines.every(e => e.tokens === 153));
  assert.ok([...folders].every(cwd => !fs.existsSync(cwd)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, id + '.json'))).trials.length, 45);
  assert.throws(() => runner.report('../routes'), /Invalid/);
});

test('response truncation is diagnosed separately from task budgets and a recovered API failure', async t => {
  const { runner } = setupRunner(t, async ({ route, engine }) => {
    route.scope.record({ outcome: 'error', failureKind: 'quota', error: 'monthly usage limit', tokens: { reported: false } });
    route.scope.record({ outcome: 'success', finishReason: engine === 'dsh' ? 'length' : 'stop', maxOutputTokens: 32768, hasTools: true,
      tokens: { input: 10, output: 8000, reported: true } });
    route.scope.record({ outcome: 'success', finishReason: 'stop', maxOutputTokens: 64, hasTools: false, tokens: { output: 10, reported: true } });
    return { ok: engine !== 'dsh', error: 'DSH exited (1)', exitCode: engine === 'dsh' ? 1 : 0 };
  });
  const { id } = runner.start({ model: 'm', providerId: 'p' }); await runner.pending;
  const report = runner.report(id);
  assert.ok(report.trials.every(trial => trial.apiError === undefined && trial.apiFailures.quota === 1));
  const errors = report.trials.filter(trial => trial.engine === 'dsh');
  assert.ok(errors.every(trial => trial.status === 'error' && trial.failureKind === 'output_limit' && trial.engineExitCode === 1));
  assert.ok(errors.every(trial => /32,768/.test(trial.error) && trial.checkScore === 0));
  assert.ok(report.comparisonNotes.some(note => note.kind === 'output_limit'));
  assert.ok(report.comparisonNotes.some(note => note.kind === 'provider_quota'));
});

test('11/12 checks earns 91.7 check points while the full-task pass rate remains zero', async t => {
  const { runner, root } = setupRunner(t, async () => ({ ok: true, text: 'All my checks passed' }));
  runner.verify = async () => ({ passed: false, detail: '11/12 checks passed', graderVersion: '1.1.0',
    checks: { passed: 11, total: 12, evaluated: 12, failures: [{ case: 11, expected: '"ab"', actual: '"a-b"' }] } });
  const { id } = runner.start({ model: 'm', providerId: 'p' }); await runner.pending;
  const report = runner.report(id);
  assert.ok(report.engines.every(e => e.score === 0 && e.checkScore === 91.7));
  assert.ok(report.trials.every(t => t.status === 'failed' && t.checkScore === 91.7));
  assert.equal(report.checkScoreMethod, 'mean-trial-check-fraction-v1');
  const saved = JSON.parse(fs.readFileSync(path.join(root, id + '.json')));
  assert.equal(saved.graderVersion, '1.1.0');
  assert.equal(saved.checkScoreMethod, report.checkScoreMethod);
  assert.equal(saved.trials[0].verification.checks.passed, 11);
  assert.equal(saved.trials[0].verification.checks.failures[0].actual, '"a-b"');
});
test('check scores average per attempt so tasks with more checks have no extra weight', () => {
  const rows = [
    { engine: 'claude', status: 'failed', verification: { checks: { passed: 11, total: 12, evaluated: 12 } } },
    { engine: 'claude', status: 'passed', verification: { checks: { passed: 2, total: 2, evaluated: 2 } } },
    { engine: 'claude', status: 'passed', verification: { checks: { passed: 3, total: 3, evaluated: 3 } } },
  ];
  const result = summarize({ versions: { claude: 'test' }, trials: rows })[0];
  assert.equal(result.checkScore, 97.2); assert.equal(result.score, 66.7);
  // All repeats count, including one repeat that could not finish any task.
  const repeated = summarize({ versions: {}, trials: [...rows, ...rows, ...rows.map(r => ({ ...r, status: 'error' }))] })[0];
  assert.equal(repeated.checkScore, 64.8); assert.equal(repeated.score, 44.4);
});
test('grader errors have no valid check score or full-task pass rate', () => {
  const report = { versions: {}, trials: [
    { engine: 'claude', status: 'passed', verification: { checks: { passed: 2, total: 2 } } },
    { engine: 'claude', status: 'grader_error', verification: { invalid: true, checks: { passed: 4, total: 14 } } },
  ] };
  const result = summarize(report)[0];
  assert.equal(result.completed, 2); assert.equal(result.invalid, 1);
  assert.equal(result.checkScore, null); assert.equal(result.score, null);
});

test('unexecuted checks and engine errors cannot inflate check scores; missing historical counts stay unknown', () => {
  const score = rows => summarize({ versions: {}, trials: rows.map(r => ({ engine: 'claude', ...r })) })[0];
  assert.equal(score([{ status: 'failed', verification: { checks: { passed: 1, total: 4, evaluated: 1 } } }]).checkScore, 25);
  for (const status of ['error', 'timeout', 'limit']) {
    assert.equal(score([{ status, verification: { checks: { passed: 1, total: 1, evaluated: 1 } } }]).checkScore, 0);
  }
  for (const status of ['pending', 'running', 'cancelled']) {
    const result = score([{ status: 'passed' }, { status }]);
    assert.equal(result.checkScore, null); assert.equal(result.score, null);
  }
  const legacy = score([{ status: 'passed' }, { status: 'failed' }]);
  assert.equal(legacy.checkScore, null); assert.equal(legacy.checkScored, 1); assert.equal(legacy.score, 50);
  assert.equal(score([{ status: 'passed' }]).checkScore, 100);
  assert.equal(score([{ status: 'failed', verification: { checks: { passed: 2, total: 1 } } }]).checkScore, null);
});
test('cancel closes every active scope immediately and waits for all accounting before allowing another run', async t => {
  const drain = Promise.withResolvers(); t.after(() => drain.resolve());
  const { runner, calls, scopes } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p', tokenBudget: 10000 }); await tick();
  assert.equal(calls.length, ENGINES.length);
  calls[0].route.scope.pending.add(drain.promise);
  runner.cancel();
  assert.ok(calls.every(c => c.signal.aborted && c.route.scope.closed));
  await tick();
  assert.equal(runner.state().busy, true); assert.equal(runner.report(id).finishedAt, null);
  assert.throws(() => runner.start({ model: 'm', providerId: 'p' }), /already running/);
  // An in-flight response can report usage after cancellation. Account for it
  // without replacing the user's stop reason with a budget status.
  calls[0].route.scope.record({ tokens: { input: 11000, reported: true } });
  assert.equal(runner.report(id).status, 'cancelling');
  drain.resolve(); await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'cancelled'); assert.equal(report.trials.filter(t => t.status === 'pending').length, 10);
  assert.equal(report.trials.filter(t => t.status === 'cancelled').length, ENGINES.length);
  assert.equal(report.engines.reduce((sum, e) => sum + e.tokens, 0), 11000);
  assert.equal(scopes.scopes.size, 0); assert.equal(runner.state().busy, false);
  assert.ok(report.engines.every(e => e.score === null));
});
test('the shared token budget aborts all concurrent engines and prevents queued trials from starting', async t => {
  const { runner, calls, scopes } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p', tokenBudget: 10000 }); await tick();
  assert.equal(calls.length, ENGINES.length);
  for (const call of calls) call.route.scope.record({ tokens: { input: 4000, output: 0, reported: true } });
  assert.ok(calls.every(c => c.signal.aborted && c.route.scope.closed));
  await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'budget_exceeded'); assert.equal(calls.length, ENGINES.length);
  assert.equal(report.trials.filter(t => t.status === 'pending').length, 10);
  assert.equal(report.engines.reduce((sum, e) => sum + e.tokens, 0), 20000);
  assert.ok(report.engines.every(e => e.score === null)); assert.equal(scopes.scopes.size, 0);
});
test('reported token budget stops remaining billable work and restart does not resume it', async t => {
  let called = 0;
  const { runner, options } = setupRunner(t, async ({ route }) => { called++; route.scope.record({ tokens: { input: 11000, reported: true } }); return { ok: true }; });
  const { id } = runner.start({ model: 'm', providerId: 'p', tokenBudget: 10000 }); await runner.pending;
  assert.equal(called, 1); assert.equal(runner.report(id).status, 'budget_exceeded');
  const saved = JSON.parse(fs.readFileSync(path.join(options.directory, id + '.json'))); saved.status = 'running'; saved.trials[0].status = 'running';
  fs.writeFileSync(path.join(options.directory, id + '.json'), JSON.stringify(saved));
  const restored = new BenchmarkRunner(options);
  assert.equal(restored.report(id).status, 'interrupted'); assert.equal(restored.pending, null);
});

test('per-task limit failures remain scored failures when the engine throws on abort', async t => {
  const { runner } = setupRunner(t, async ({ route }) => {
    route.scope.record({ tokens: { input: 1000000, reported: true } });
    throw new Error('Engine interrupted by request limit');
  });
  const { id } = runner.start({ model: 'm', providerId: 'p', tokenBudget: 20000000 }); await runner.pending;
  const report = runner.report(id);
  assert.ok(report.trials.every(t => t.status === 'limit'));
  assert.ok(report.engines.every(e => e.score === 0));
});
test('a single trial limit does not abort other engines or stop the remaining task queues', async t => {
  const { runner, calls } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p', maxTokensPerTask: 10000 }); await tick();
  const limited = calls[0]; limited.route.scope.record({ tokens: { input: 10000, reported: true } });
  await tick();
  assert.equal(calls.length, ENGINES.length + 1);
  assert.equal(calls.at(-1).engine, limited.engine);
  assert.ok(calls.slice(1).every(c => !c.signal.aborted));
  for (let wave = 0; wave < 3; wave++) { for (const call of calls.filter(c => !c.done)) call.finish(); await tick(); }
  await runner.pending;
  const report = runner.report(id);
  assert.equal(report.status, 'completed'); assert.equal(calls.length, 15);
  assert.equal(report.tokenBudget, null);
  assert.equal(report.maxTokensPerTask, 10000);
  assert.equal(report.trials.filter(t => t.status === 'limit').length, 1);
  assert.equal(report.trials.filter(t => t.status === 'passed').length, 14);
});

test('failure to save stops all workers and waits for cleanup without rejecting the run promise', async t => {
  const drain = Promise.withResolvers(); t.after(() => drain.resolve());
  const { runner, calls, scopes } = controlledRunner(t);
  const { id } = runner.start({ model: 'm', providerId: 'p' }); await tick();
  calls[1].route.scope.pending.add(drain.promise);
  runner.save = () => { throw new Error('Fixture disk full'); };
  calls[0].finish(); await tick();
  assert.ok(calls.every(c => c.route.scope.closed));
  assert.ok(calls.slice(1).every(c => c.signal.aborted));
  assert.equal(runner.state().busy, true); assert.equal(runner.report(id).finishedAt, null);
  drain.resolve(); await runner.pending;
  assert.equal(calls.length, ENGINES.length); assert.equal(runner.report(id).status, 'error');
  assert.match(runner.report(id).error, /Could not save/);
  assert.equal(scopes.scopes.size, 0); assert.ok(calls.every(c => !fs.existsSync(c.cwd)));
});
test('benchmark environment does not inherit API keys, personal settings, or Node injection', t => {
  const root = temp(t), env = isolatedEnvironment(root, process.execPath, { PATH: process.env.PATH, SOME_API_KEY: 'secret',
    NODE_OPTIONS: '--require bad', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CONFIG_DIR: '/personal', DSH_HOME: '/personal' });
  assert.equal(env.SOME_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined); assert.equal(env.DSH_HOME, undefined); assert.equal(env.HOME, root);
});

test('benchmark reports can be deleted individually, and the active run is protected', t => {
  const dir = temp(t);
  const runner = new BenchmarkRunner({ directory: dir, runtimes: () => ({ locate: () => null }), node: process.execPath, getRouter: () => null });
  const mk = status => {
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, version: VERSION, status, startedAt: new Date().toISOString(), trials: [] }));
    return id;
  };
  const a = mk('completed'), b = mk('completed');
  assert.equal(runner.history().length, 2);
  assert.equal(runner.deleteReport(a).ok, true);
  assert.equal(runner.history().length, 1);
  assert.throws(() => runner.deleteReport(a), /not found/);
  assert.throws(() => runner.deleteReport('bad-id'), /Invalid/);
  const active = mk('running');
  runner.active = { id: active };
  assert.throws(() => runner.deleteReport(active), /Stop the running benchmark/);
  runner.active = null;
  assert.equal(runner.deleteReport(active).ok, true);
  assert.equal(runner.history().length, 1);
});
