'use strict';
// Uses installed, checksum-pinned data and reference solutions. No API calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLibraryManager, makeTasks } = require('../src/benchmark/libraries');
const { prepareTask } = require('../src/benchmark/tasks');
const { verifyPythonTask, preflightPythonTasks } = require('../src/benchmark/python-verifier');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { summarize } = require('../src/benchmark/runner');
const { PYTHON_SCRATCH_FLAGS } = require('../src/benchmark/runner');
const { spawnSync } = require('node:child_process');

const directory = process.argv[2] || path.join(process.env.APPDATA || path.join(os.homedir(), 'Library/Application Support'), 'dsh-desktop/benchmark-libraries');
const manager = createLibraryManager({ directory });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-science-smoke-'));
let number = 0;
async function check(task, source, options, signal = new AbortController().signal) {
  const parent = path.join(root, String(number++)), cwd = path.join(parent, 'workspace');
  prepareTask(task, cwd); fs.writeFileSync(path.join(cwd, 'solution.py'), source);
  return verifyPythonTask(task, cwd, manager.locate(task.library), isolatedEnvironment(path.join(parent, 'profile'), process.execPath), signal, options);
}
async function main() {
  assert.ok(manager.locate('ds1000'), 'Prepare DS-1000 in Camellia first');
  assert.ok(manager.locate('scicode'), 'Prepare SciCode in Camellia first');
  const scratch = path.join(root, 'local-import-control'); fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, 'solution.py'), 'def f(): return 42\n');
  fs.writeFileSync(path.join(scratch, 'scratch.py'), 'from solution import f\nassert f() == 42\nimport numpy\n');
  const localImport = spawnSync(manager.locate('scicode').python, [...PYTHON_SCRATCH_FLAGS, 'scratch.py'],
    { cwd: scratch, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(localImport.status, 0, localImport.stderr);
  console.log('PASS: prepared Python self-tests can import workspace modules');
  const scienceCatalog = manager.resolve('scicode-full').tasks;
  await preflightPythonTasks(scienceCatalog, manager.locate('scicode'), process.env);
  console.log('PASS: all SciCode test-split imports and numerical target keys');
  const heliumRecord = structuredClone(scienceCatalog.find(t => t.sourceId === '46').record);
  heliumRecord.sub_steps = heliumRecord.sub_steps.slice(0, 2);
  const [helium] = makeTasks('scicode', [heliumRecord]);
  const analyticSource = fs.readFileSync(path.join(__dirname, 'fixtures/scicode-helium.py'), 'utf8');
  const heliumVerdict = await check(helium, analyticSource);
  assert.equal(heliumVerdict.passed, true, JSON.stringify(heliumVerdict));
  assert.equal(heliumVerdict.checks.passed, 6, 'Official #46 tuple/array checks require the SciCode comparison helper');
  const badImport = await check(helium, 'import missing_candidate_dependency');
  assert.equal(badImport.invalid, undefined, 'A missing candidate dependency is a solution failure');
  assert.equal(badImport.checks.evaluated, 6); assert.equal(badImport.checks.passed, 0);
  const brokenRecord = structuredClone(heliumRecord);
  brokenRecord.sub_steps[0].test_cases[0] += '\nfrom scicode.compare.missing import unavailable';
  const [broken] = makeTasks('scicode', [brokenRecord]);
  await assert.rejects(preflightPythonTasks([broken], manager.locate('scicode'), process.env), /grader is unavailable/);
  const brokenVerdict = await check(broken, analyticSource);
  assert.equal(brokenVerdict.invalid, true, 'Broken official imports invalidate grading');
  assert.equal(brokenVerdict.checks.evaluated, 0);
  console.log('PASS: SciCode #46 official comparisons and grader/candidate failure distinction');
  const fullHelium = scienceCatalog.find(t => t.sourceId === '46');
  const sampler = fs.readFileSync(path.join(__dirname, 'fixtures/scicode-helium-sampling.py'), 'utf8');
  const standardSampler = await check(fullHelium, analyticSource + '\n' + sampler);
  const equivalentSampler = await check(fullHelium, analyticSource + '\n' + sampler.replace('COMPLEMENT_DRAW = False', 'COMPLEMENT_DRAW = True'));
  assert.equal(standardSampler.checks.passed, 7);
  assert.equal(equivalentSampler.checks.passed, 14);
  console.log('PASS: #46 limitation reproduced: equivalent acceptance probabilities receive 7/14 versus 14/14');
  const ds = manager.resolve('ds1000-extended').tasks;
  for (const task of ds.slice(0, 7)) {
    const verdict = await check(task, task.record.reference_code);
    assert.equal(verdict.passed, true, `${task.id} ${task.category}: ${JSON.stringify(verdict)}`);
    console.log(`PASS ${task.id} ${task.category}: ${verdict.checks.passed}/${verdict.checks.total} official checks`);
  }
  const science = makeTasks('scicode', require('./fixtures/benchmark-scicode.json').problems);
  for (const task of science) {
    const source = task.record.required_dependencies + '\n' + task.record.sub_steps.map(s => s.ground_truth_code).join('\n\n');
    const verdict = await check(task, source);
    assert.equal(verdict.passed, true, `${task.id}: ${JSON.stringify(verdict)}`);
    console.log(`PASS ${task.id}: ${verdict.checks.passed}/${verdict.checks.total} official numerical checks`);
    const failed = await check(task, 'raise ValueError("deliberately wrong candidate")');
    assert.equal(failed.passed, false); assert.equal(failed.checks.passed, 0); assert.equal(failed.checks.evaluated, failed.checks.total);
  }
  const [partialTask] = makeTasks('ds1000', [{ prompt: 'fixture', metadata: { problem_id: 0, library: 'Numpy', test_case_cnt: 3 },
    code_context: 'def test_execution(solution):\n    for i in range(3):\n        namespace = {"x": i}\n        exec(solution, namespace)\n        assert namespace["result"] == i + 1\n', reference_code: 'result=x+1' }]);
  const partial = await check(partialTask, 'result = x + 1 if x < 2 else 0');
  assert.equal(partial.checks.passed, 2); assert.equal(partial.checks.total, 3); assert.equal(partial.checks.evaluated, 3);
  assert.equal(partial.checks.failures[0].kind, 'assertion');
  assert.match(partial.checks.failures[0].location, /official_ds1000_test.py:/);
  assert.equal(partial.checks.results.length, 3);
  assert.equal(summarize({ versions: {}, trials: [{ engine: 'claude', status: 'failed', verification: partial }] })[0].checkScore, 66.7);
  const utf8 = await check(partialTask, '\uFEFF# 中文 · café\nresult = x + 1');
  assert.equal(utf8.passed, true, 'UTF-8 and Windows editor BOMs preserve Python source');
  const spoofed = await check(partialTask, 'print(\'{"passed": true}\'); raise ValueError("invalid")');
  assert.equal(spoofed.checks.passed, 0);
  const timed = await check(partialTask, 'while True: pass', { maxMs: 1200, caseMs: 1000 });
  assert.equal(timed.checks.passed, 0); assert.equal(timed.checks.evaluated, 0);
  const [statefulDS] = makeTasks('ds1000', [{ prompt: 'Stateful fixture', metadata: { problem_id: 0, library: 'Numpy', test_case_cnt: 3 },
    code_context: 'def test_execution(solution):\n    namespace = {"value": 0}\n    for i in range(3):\n        exec(solution, namespace)\n        assert namespace["value"] == i + 1\n' }]);
  assert.equal((await check(statefulDS, 'value += 1')).checks.passed, 3, 'Preserve official loop setup and shared state');
  const logged = await check(statefulDS, 'print("candidate diagnostic"); value += 2');
  assert.match(logged.checks.failures[0].log, /candidate diagnostic/);
  const scienceState = structuredClone(science[0].record);
  scienceState.sub_steps[0].test_cases = [
    'np.random.seed(7)\ncontext = [1]\nassert draw() == 47',
    'assert context == [1]\ncontext.append(2)\nassert draw() == 68',
    'assert context == [1, 2]\nassert draw() == 25',
  ];
  const [statefulScience] = makeTasks('scicode', [scienceState]);
  const sequential = await check(statefulScience, 'import numpy as np\ndef draw(): return np.random.randint(100)');
  assert.equal(sequential.checks.passed, 3, 'Preserve official SciCode namespace and RNG between cases');
  const laterHang = await check(statefulDS, 'value += 1\nif value == 2:\n    while True: pass', { maxMs: 6000, caseMs: 1500 });
  assert.equal(laterHang.checks.passed, 1, 'Keep a completed check when a later check times out');
  assert.equal(laterHang.checks.results[1].status, 'timeout');
  assert.equal(laterHang.checks.results[2].status, 'not_evaluated');
  console.log('PASS: ordered cases, shared RNG/globals, diagnostic logs, and partial credit before a later timeout');
  const controller = new AbortController(); const pending = check(partialTask, 'while True: pass', {}, controller.signal);
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending, /cancelled/);
  console.log('PASS: all seven DS-1000 libraries, real SciCode numerical targets, partial credit, incorrect solutions, timeout and cancellation; no API usage.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('camellia-science-smoke-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
