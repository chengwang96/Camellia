'use strict';
const { removeTree } = require('./test-fs.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { makeTasks, selectTasks, publicTask, download, createLibraryManager, EXTERNAL_SUITES } = require('../src/benchmark/libraries');
const { checksFor } = require('../src/benchmark/python-verifier');
const { BenchmarkRunner } = require('../src/benchmark/runner');
const { RequestScopes } = require('../src/api/request-scopes');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-library-test-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('camellia-library-test-')); removeTree(dir); });
  return dir;
}
const ds = { prompt: 'Public question: compute the result.', metadata: { problem_id: 42, library: 'Numpy', test_case_cnt: 2 },
  reference_code: 'SECRET_REFERENCE', code_context: 'SECRET_CHECKER\ndef test_string(solution): pass' };
const sci = { problem_id: '9', problem_name: 'Scientific_calculation', problem_description_main: 'Public science problem.', problem_io: 'Return a number.',
  required_dependencies: 'import numpy as np', general_tests: ['SECRET_GENERAL_TEST'], sub_steps: [
    { step_number: '9.1', step_description_prompt: 'Implement f', function_header: 'def f(x):', return_line: '    return y',
      step_background: 'Public scientific background', ground_truth_code: 'SECRET_REFERENCE', test_cases: ['SECRET_CHECKER', 'SECRET_CHECKER_2'] }] };

test('official adapters expose only prompts, interfaces and public helpers to agents and reports', () => {
  for (const task of [...makeTasks('ds1000', [ds]), ...makeTasks('scicode', [sci])]) {
    assert.doesNotMatch(JSON.stringify([task.instruction, task.files, publicTask(task)]), /SECRET/);
    assert.match(JSON.stringify(task.record), /SECRET/);
    assert.ok(task.files['solution.py']);
  }
  const [science] = makeTasks('scicode', [{ ...sci, problem_id: '13', sub_steps: [...sci.sub_steps,
    { step_number: '13.6', test_cases: [] }] }]);
  assert.match(science.files['solution.py'], /class Maxwell/);
  assert.equal(science.checkCount, 2, 'provided helper steps earn no points');
  assert.deepEqual(checksFor(makeTasks('ds1000', [ds])[0]), [0, 1, 'constraint']);
  assert.deepEqual(checksFor(science), [['9.1', 0], ['9.1', 1]]);
  assert.deepEqual(checksFor(makeTasks('ds1000', [{ ...ds, metadata: { ...ds.metadata, test_case_cnt: 0 } }])[0]), [0, 'constraint']);
});

test('fixed samples are nested, independent of input ordering, and cover different DS-1000 libraries first', () => {
  const records = Array.from({length: 21}, (_, i) => ({ ...ds, metadata: { problem_id: i, library: ['Pandas', 'Numpy', 'Scipy'][i % 3], test_case_cnt: 1 } }));
  const tasks = makeTasks('ds1000', records);
  const short = selectTasks(tasks, 3), longer = selectTasks([...tasks].reverse(), 6);
  assert.deepEqual(short.map(t => t.id), longer.slice(0,3).map(t => t.id));
  assert.equal(new Set(short.map(t => t.category)).size, 3);
  const all = selectTasks(tasks, 1000);
  assert.equal(all.length, tasks.length); assert.equal(new Set(all.map(t => t.id)).size, tasks.length);
  assert.deepEqual(selectTasks([], 3), []);
  const science = Array.from({ length: 65 }, (_, i) => ({ id: `scicode:${i + 1}`, library: 'scicode' }));
  const shortScience = selectTasks(science, 12), allScience = selectTasks(science, 65);
  assert.ok(!shortScience.some(t => ['scicode:15', 'scicode:46'].includes(t.id)), 'Known problematic questions stay out of short samples');
  assert.deepEqual(new Set(allScience.slice(-2).map(t => t.id)), new Set(['scicode:15', 'scicode:46']), 'The full split retains the upstream questions');
  assert.deepEqual(shortScience, allScience.slice(0, 12));
  assert.equal(publicTask({ id: 'scicode:46' }).warnings[0].code, 'seeded-monte-carlo-trajectory');
});

test('downloads are checksum-verified, reused offline, and never replace valid cached data on failure', async t => {
  const dir = temp(t), target = path.join(dir, 'dataset'), bytes = Buffer.from('official fixture dataset');
  const spec = {name:'dataset',url:'https://fixture.invalid/data',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  let requests = 0;
  const connection = {fetch:async()=>{requests++; return new Response(bytes)}};
  await download(spec,target,connection); await download(spec,target,connection);
  assert.equal(requests,1); assert.deepEqual(fs.readFileSync(target),bytes);
  await assert.rejects(download({...spec,sha256:'0'.repeat(64)},target,connection),/checksum mismatch/);
  assert.deepEqual(fs.readFileSync(target),bytes); assert.equal(fs.existsSync(target+'.download'),false);
  await assert.rejects(download({...spec,size:1},target,connection),/Unexpected download size/);
  assert.deepEqual(fs.readFileSync(target),bytes);
});

test('missing question libraries are visible but cannot start downloads or resolve a paid run implicitly', async t => {
  const manager = createLibraryManager({directory:temp(t),connect:()=>{throw new Error('Unexpected download')}});
  assert.equal(manager.state().length,2);
  assert.ok(manager.state().every(l=>!l.ready));
  assert.equal(manager.suites().length,8);
  assert.ok(manager.suites().every(s=>s.tasks.length===0));
  assert.equal(EXTERNAL_SUITES.find(s=>s.id==='ds1000-full').count,1000);
  assert.equal(EXTERNAL_SUITES.find(s=>s.id==='scicode-full').count,65);
  assert.throws(()=>manager.resolve('scicode-quick'),/Prepare SciCode/);
  await assert.rejects(manager.ensure('../escape'),/Unknown question library/);
});

test('external runs use the selected tasks for every engine, preserve provenance and partial scores, and exclude hidden answers from reports', async t => {
  const root = temp(t), tasks = makeTasks('ds1000',[ds]), scopes = new RequestScopes(), calls = [];
  const selected = { suite:{id:'ds1000-quick',name:'Quick sample',taskIds:tasks.map(t=>t.id)}, tasks,
    suiteHash:'fixture-data-hash',runtime:{python:'fixture-python'},library:{id:'ds1000',name:'DS-1000',revision:'fixture-revision'} };
  const manager = {busy:false,state:()=>[{id:'ds1000',name:'DS-1000',ready:true}],suites:()=>[],resolve:id=>id==='ds1000-quick'?selected:null};
  const router = {getState:()=>({enabled:true,running:true,usage:{},providers:[{id:'p',name:'Fixture',enabled:true,keys:[{id:'k',enabled:true}],models:[{id:'m',upstream:'m'}]}]}),
    createScope:opts=>scopes.create({...opts,upstream:'m'})};
  const runner = new BenchmarkRunner({directory:root,libraries:manager,runtimes:()=>({locate:()=>({version:'test'})}),node:()=>process.execPath,getRouter:()=>router,
    execute:async args=>{calls.push(args); assert.match(fs.readFileSync(path.join(args.cwd,'TASK.md'),'utf8'),/Public question/);return {ok:true}},
    verify:()=>{throw Error('Wrong verifier')},verifyPython:async task=>{assert.equal(task.sourceId,'42');return {passed:false,checks:{passed:2,total:3,evaluated:3,failures:[]}}}});
  t.after(()=>runner.shutdown());
  const {id}=runner.start({suite:'ds1000-quick',model:'m',providerId:'p',repeats:3}); await runner.pending;
  const report=runner.report(id);
  assert.equal(report.timeoutSeconds, 600);
  assert.equal(report.tokenBudget, null);
  assert.equal(report.maxTokensPerTask, 500000);
  assert.equal(runner.state().libraries.find(library => library.id === 'ds1000').defaultTimeoutSeconds, 600);
  assert.equal(calls.length,15);assert.ok(calls.every(c=>c.python==='fixture-python'&&!c.prompt.includes('SECRET')));
  assert.ok(calls.every(c => c.prompt.includes('-E -s -X utf8') && !c.prompt.includes('with -I')));
  assert.equal(report.configuration.pythonSelfTest, '-E -s -X utf8');
  assert.equal(report.trials.length,15);assert.ok(report.trials.every(t=>t.task==='ds1000:42'));
  assert.ok(report.engines.every(e=>e.checkScore===66.7&&e.score===0));
  assert.equal(report.library.revision,'fixture-revision');assert.equal(report.suiteHash,'fixture-data-hash');
  assert.doesNotMatch(JSON.stringify(report),/SECRET/);
  assert.deepEqual(report.tasks,[publicTask(tasks[0])]);
  calls.length = 0;
  runner.preflightPython = async () => { throw new Error('Missing official comparison helper'); };
  const stopped = runner.start({suite:'ds1000-quick',model:'m',providerId:'p'}); await runner.pending;
  assert.equal(calls.length, 0, 'A broken grader must be detected before any model request');
  assert.equal(runner.report(stopped.id).status, 'error');
  assert.match(runner.report(stopped.id).error, /Missing official comparison helper/);
  assert.ok(runner.report(stopped.id).trials.every(t => t.status === 'pending'));
  runner.preflightPython = async () => {};
  runner.verifyPython = async () => ({ passed: false, invalid: true, detail: 'Official target became unavailable', checks: { passed: 0, total: 3, evaluated: 0, failures: [] } });
  assert.throws(() => runner.start({suite:'ds1000-quick',model:'m',providerId:'p',timeoutSeconds:3601}), /between 30 and 3600/);
  assert.throws(() => runner.start({suite:'ds1000-quick',model:'m',providerId:'p',tokenBudget:1000000001}), /between 10000 and 1000000000/);
  assert.throws(() => runner.start({suite:'ds1000-quick',model:'m',providerId:'p',maxTokensPerTask:5000001}), /between 10000 and 5000000/);
  const invalid = runner.start({suite:'ds1000-quick',model:'m',providerId:'p',repeats:3,timeoutSeconds:3600,tokenBudget:1000000000,maxTokensPerTask:2000000}); await runner.pending;
  assert.equal(runner.report(invalid.id).timeoutSeconds, 3600);
  assert.equal(runner.report(invalid.id).tokenBudget, 1000000000);
  assert.equal(runner.report(invalid.id).maxTokensPerTask, 2000000);
  assert.ok(calls.length <= 5, 'A grader failure must stop subsequent attempts in every engine queue');
  assert.equal(runner.report(invalid.id).status, 'error');
  assert.ok(runner.report(invalid.id).trials.some(t => t.status === 'grader_error'));
  runner.active=null;manager.resolve=()=>null;
  assert.deepEqual(runner.report(id).tasks,report.tasks,'history remains readable without the current dataset');
});
