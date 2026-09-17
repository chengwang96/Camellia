'use strict';
// Re-evaluate captured solution.py files with the current checker, without model
// requests. The original report is backed up and its former verdicts retained.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibraryManager } = require('../src/benchmark/libraries');
const { prepareTask } = require('../src/benchmark/tasks');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { verifyPythonTask, preflightPythonTasks, PYTHON_GRADER_VERSION } = require('../src/benchmark/python-verifier');
const { writeJson } = require('../src/shared/json-store');

async function regrade(file, { write = false, onResult = () => {} } = {}) {
  file = fs.realpathSync(file);
  const original = fs.readFileSync(file, 'utf8'), report = JSON.parse(original);
  if (['running', 'cancelling'].includes(report.status)) throw new Error('Wait for the run to finish before rechecking');
  const manager = createLibraryManager({ directory: path.join(path.dirname(file), '..', 'benchmark-libraries') });
  // Resolve saved task IDs against the full pinned catalog: short samples may
  // change after a question is found to have unreliable tests.
  const selected = manager.resolve(report.library?.id + '-full');
  if (!selected || selected.library.id !== report.library?.id || selected.library.revision !== report.library.revision
      || selected.library.environmentHash !== report.library.environmentHash
      || JSON.stringify(selected.library.dataHashes) !== JSON.stringify(report.library.dataHashes)) {
    throw new Error('Rechecking requires the original installed data and Python environment');
  }
  const tasks = new Map(selected.tasks.map(t => [t.id, t]));
  const trials = report.trials.filter(t => t.verification && ['passed', 'failed', 'grader_error'].includes(t.status));
  if (!trials.length) throw new Error('No saved answers with check results are available');
  for (const trial of trials) {
    if (!tasks.has(trial.task) || typeof trial.changes?.find(c => c.path === 'solution.py')?.after !== 'string') {
      throw new Error('The complete saved solution is unavailable for attempt ' + trial.id);
    }
  }
  await preflightPythonTasks([...tasks.values()], selected.runtime, process.env);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-regrade-'));
  const previous = [], at = new Date().toISOString();
  try {
    for (const trial of trials) {
      const task = tasks.get(trial.task), dir = path.join(root, String(trial.id)), cwd = path.join(dir, 'workspace');
      prepareTask(task, cwd);
      fs.writeFileSync(path.join(cwd, 'solution.py'), trial.changes.find(c => c.path === 'solution.py').after);
      const verdict = await verifyPythonTask(task, cwd, selected.runtime, isolatedEnvironment(path.join(dir, 'profile'), process.execPath), undefined, report.verificationLimits);
      if (verdict.invalid) throw new Error(verdict.detail);
      previous.push({ id: trial.id, status: trial.status, detail: trial.detail, verification: trial.verification });
      trial.verification = verdict; trial.detail = verdict.detail; trial.status = verdict.passed ? 'passed' : 'failed';
      onResult({ id: trial.id, engine: trial.engine, task: trial.task, before: previous.at(-1).verification.checks.passed,
        passed: verdict.checks.passed, total: verdict.checks.total });
    }
    report.regrades = [...(report.regrades || []), { at, from: report.graderVersion, to: PYTHON_GRADER_VERSION,
      source: 'saved-solutions', modelRequests: 0, previous }];
    report.regradedAt = at; report.graderVersion = PYTHON_GRADER_VERSION;
    let backup = null;
    if (write) {
      if (fs.readFileSync(file, 'utf8') !== original) throw new Error('The report changed during rechecking; no results written');
      const backupDir = path.join(path.dirname(file), 'regrade-backups'); fs.mkdirSync(backupDir, { recursive: true });
      backup = path.join(backupDir, path.basename(file, '.json') + '-' + Date.now() + '.json');
      fs.writeFileSync(backup, original, { flag: 'wx' });
      writeJson(file, report);
    }
    return { report, backup, written: write };
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('camellia-regrade-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
if (require.main === module) {
  const args = process.argv.slice(2), file = args.find(a => a !== '--write');
  if (!file || args.some(a => a !== file && a !== '--write')) {
    console.error('Usage: node scripts/regrade-benchmark.cjs <saved-report.json> [--write]'); process.exitCode = 1;
  } else regrade(file, { write: args.includes('--write'), onResult: row => console.log(JSON.stringify(row)) })
    .then(({ backup, written }) => console.log(JSON.stringify({ written, backup, modelRequests: 0 })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { regrade };
