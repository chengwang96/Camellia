'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stopProcess } = require('./engines');
// Grader fixes do not change prompts or invalidate installed Python/data caches.
const PYTHON_GRADER_VERSION = 'python-checks-3';

function checksFor(task) {
  if (task.library === 'ds1000') {
    const cases = Array.from({ length: Math.max(1, task.record.metadata.test_case_cnt) }, (_, i) => i);
    if (/def test_string\s*\(/.test(task.record.code_context)) cases.push('constraint');
    return cases;
  }
  return task.record.sub_steps.flatMap(step => step.test_cases.map((_, i) => [step.step_number, i]));
}
function checkGroups(task) {
  const checks = checksFor(task);
  if (task.library === 'ds1000') return [checks.filter(c => c !== 'constraint'), ...(checks.includes('constraint') ? [['constraint']] : [])];
  return task.record.sub_steps.filter(s => s.test_cases.length).map(s => checks.filter(c => c[0] === s.step_number));
}
const caseName = check => Array.isArray(check) ? `${check[0]} / ${check[1] + 1}` : check === 'constraint' ? 'code constraint' : check + 1;
function runCheck({ task, solution, checks, runtime, cwd, env, signal, timeoutMs, caseMs = timeoutMs, preflightTasks }) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'python/check.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    const proc = spawn(runtime.python, ['-I', '-B', '-X', 'utf8', script], { cwd,
      env: { ...env, MPLBACKEND: 'Agg', MPLCONFIGDIR: path.join(cwd, '.matplotlib'), PYTHONDONTWRITEBYTECODE: '1',
        OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1',
        TF_NUM_INTEROP_THREADS: '1', TF_NUM_INTRAOP_THREADS: '1', TF_CPP_MIN_LOG_LEVEL: '3', CUDA_VISIBLE_DEVICES: '-1' },
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', stopped = '', killing, timer, received = 0;
    const results = [], started = Date.now();
    let caseStarted = started;
    const stop = reason => { stopped ||= reason; killing ||= stopProcess(proc); void killing.catch(() => {}); };
    const abort = () => stop('Verification cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => stop('Verification time limit reached'), Math.max(1, Math.min(caseMs, timeoutMs - (Date.now() - started)))); };
    arm();
    proc.stdout.on('data', bytes => {
      received += bytes.length; out += bytes;
      if (received > 1024 * 1024 || out.length > 64000) { stop('Verification output limit reached'); return; }
      let end;
      while ((end = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, end); out = out.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (results.length >= checks.length || JSON.stringify(result.check) !== JSON.stringify(checks[results.length])
            || typeof result.passed !== 'boolean' || typeof result.infrastructure !== 'boolean') throw new Error('Unexpected checker result');
          results.push({ ...result, evaluated: !result.infrastructure, durationMs: Date.now() - caseStarted });
          caseStarted = Date.now(); arm();
        } catch { stop('The checker returned an invalid result'); }
      }
    });
    proc.stderr.on('data', bytes => { err = (err + bytes).slice(-2000); });
    proc.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    proc.once('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); await killing;
      if (signal?.aborted) return reject(new Error('Verification cancelled'));
      // Keep already completed cases when a later case hangs. Cases after a
      // timeout cannot safely resume without their shared namespace/RNG state.
      const missing = checks.length - results.length;
      for (let i = 0; i < missing; i++) results.push({ passed: false, evaluated: false,
        kind: stopped?.includes('time limit') ? (i === 0 ? 'timeout' : 'not_evaluated') : 'execution',
        error: stopped || err || `The checker exited before reporting this case (${code})` });
      if (!missing && (code !== 0 || stopped || out.trim())) {
        // A protocol error after the last case is not a valid full pass.
        results[results.length - 1] = { passed: false, evaluated: false, infrastructure: true,
          error: stopped || err || 'The checker did not finish cleanly' };
      }
      resolve(results);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify({ library: task.library, problem: task.record, solution, checks,
      ...(preflightTasks ? { mode: 'preflight', problems: preflightTasks.map(t => t.record) } : {}),
      dataFile: task.library === 'scicode' ? path.join(runtime.directory, 'test_data.h5') : null }));
  });
}
async function preflightPythonTasks(tasks, runtime, env, signal) {
  if (tasks[0]?.library !== 'scicode') return;
  const [result] = await runCheck({ task: tasks[0], checks: ['preflight'], preflightTasks: tasks, runtime, cwd: runtime.directory, env, signal, timeoutMs: 60000 });
  if (!result.passed) throw new Error('SciCode grader is unavailable: ' + result.error);
}
async function verifyPythonTask(task, cwd, runtime, env, signal, { maxMs = 120000, caseMs = 30000 } = {}) {
  const cases = checksFor(task), checks = { total: cases.length, passed: 0, evaluated: 0, results: [], failures: [], omittedFailures: 0 };
  const failure = record => { if (checks.failures.length < 12) checks.failures.push(record); else checks.omittedFailures++; };
  let solution, invalid = false;
  try {
    const file = fs.realpathSync(path.join(cwd, 'solution.py'));
    if (path.dirname(file) !== fs.realpathSync(cwd) || fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid solution.py');
    solution = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) { failure({ kind: 'file', file: 'solution.py', error: error.message }); }
  const start = Date.now();
  if (solution !== undefined) for (const [index, group] of checkGroups(task).entries()) {
    if (signal?.aborted) throw new Error('Verification cancelled');
    const remaining = maxMs - (Date.now() - start);
    if (remaining <= 0) { failure({ kind: 'execution', file: 'solution.py', error: 'Verification time limit reached; remaining checks are unverified' }); break; }
    // Match the official state boundary: one DS-1000 execution loop or one
    // SciCode subproblem. Cases share globals/RNG in their original order.
    // Expected answers and tests stay outside the agent's workspace.
    const work = path.join(path.dirname(cwd), 'grading', String(index)); fs.mkdirSync(work, { recursive: true });
    let results;
    try { results = await runCheck({ task, solution, checks: group, runtime, cwd: work, env, signal, timeoutMs: remaining, caseMs }); }
    catch (error) {
      if (signal?.aborted) throw error;
      results = [{ passed: false, evaluated: false, infrastructure: true, error: error.message }];
    }
    for (const [caseIndex, result] of results.entries()) {
      const check = group[caseIndex];
      checks.results.push({ case: caseName(check), status: result.infrastructure ? 'grader_error' : result.passed ? 'passed'
        : result.evaluated ? 'failed' : result.kind === 'timeout' ? 'timeout' : 'not_evaluated', durationMs: result.durationMs || 0 });
      if (result.infrastructure) {
        invalid = true; failure({ kind: 'grader', file: 'solution.py', error: result.error }); break;
      }
      if (result.evaluated) checks.evaluated++;
      if (result.passed) checks.passed++;
      else failure({ kind: result.evaluated ? result.kind || 'exception' : result.kind || 'execution', file: 'solution.py',
        case: caseName(check), error: result.error || 'The official check did not pass',
        ...(result.location ? { location: result.location } : {}), ...(result.log ? { log: result.log } : {}) });
    }
    if (invalid) break;
  }
  const passed = checks.passed === checks.total;
  return { passed, ...(invalid ? { invalid: true } : {}), graderVersion: PYTHON_GRADER_VERSION, checks,
    detail: invalid ? 'Grader error: this attempt has no valid score. ' + checks.failures.at(-1).error
      : `${checks.passed}/${checks.total} official checks passed${checks.evaluated < checks.total ? `; ${checks.total - checks.evaluated} could not be evaluated` : ''}` };
}

module.exports = { checksFor, checkGroups, verifyPythonTask, preflightPythonTasks, PYTHON_GRADER_VERSION };
