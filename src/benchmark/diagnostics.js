'use strict';

// Keep notices separate from pinned data/environment hashes. They do not alter
// upstream prompts, expected answers, tolerances or historical scores.
const SCICODE_REVISION = '4510f6a6aa27c43fad7b43da2c59602a86e88480';
const LIMITATIONS = {
  'scicode:15': {
    code: 'missing-physical-constant', title: 'Incomplete constant in source',
    message: 'SciCode #15 omits the coefficient of the reduced Planck constant in its original prompt. Solvers must infer a numerical convention that can affect the frozen-target checks. Treat the raw score with caution.',
    affectedSteps: ['15.1', '15.2'],
  },
  'scicode:46': {
    code: 'seeded-monte-carlo-trajectory', title: 'Seed-sensitive test',
    message: 'SciCode #46 compares a fixed Monte Carlo trajectory. Equivalent sampling rules can fail steps 46.3 and 46.4. The raw score is retained, but this task alone cannot establish which harness is stronger.',
    affectedSteps: ['46.3', '46.4'],
  },
};
function taskWarnings(id, library) {
  if (library?.revision && library.revision !== SCICODE_REVISION) return [];
  return LIMITATIONS[id] ? [structuredClone(LIMITATIONS[id])] : [];
}
function comparisonNotes(report) {
  const notes = [];
  const runtimeErrors = (report.trials || []).filter(trial => trial.status === 'error');
  if (runtimeErrors.length) {
    const counts = new Map();
    for (const trial of runtimeErrors) counts.set(trial.engine, (counts.get(trial.engine) || 0) + 1);
    notes.push({ kind: 'execution_errors', message: `${runtimeErrors.length} execution errors (${[...counts].map(([engine, count]) => engine + ': ' + count).join(', ')}). These engines did not finish their tasks; this is different from failing the checker. Open an error cell for its cause.` });
  }
  const outputLimited = runtimeErrors.filter(trial => trial.failureKind === 'output_limit').length;
  if (outputLimited) notes.push({ kind: 'output_limit', message: `${outputLimited} tasks ended at the model's single-response output limit. Raising the total time or per-task token allowance does not change this separate limit.` });
  if (report.configuration?.dsh === 'shipped headless profile' && runtimeErrors.some(trial => trial.engine === 'dsh' && !trial.lastRequest)) {
    notes.push({ kind: 'legacy_dsh_output_limit', message: 'This older DSH adapter used an 8,192-token single-response cap, which could cut off reasoning before code was written. New runs use the pinned native default of 32,768 and record stop reasons. This report lacks those reasons, so individual historical exits cannot be classified conclusively.' });
  }
  const quotaFailures = (report.trials || []).filter(trial => trial.apiFailures?.quota || /monthly usage limit|quota exhausted|insufficient.quota/i.test(trial.apiError || '')).length;
  if (quotaFailures) notes.push({ kind: 'provider_quota', message: `Provider quota errors were reported in ${quotaFailures} trials. Another key may have allowed work to continue; a recovered quota error alone does not explain a task's score.` });
  for (const task of report.tasks || []) for (const warning of task.warnings || taskWarnings(task.id, report.library)) {
    notes.push({ kind: 'test_limitation', task: task.id, message: warning.message });
  }
  const groups = new Map();
  for (const trial of report.trials || []) {
    if (!['passed', 'failed'].includes(trial.status) || trial.verification?.invalid) continue;
    const key = `${trial.task}:${trial.repeat}`;
    if (!groups.has(key)) groups.set(key, { task: trial.task, repeat: trial.repeat, cases: new Map() });
    const group = groups.get(key);
    for (const failure of trial.verification?.checks?.failures || []) {
      if (failure.case == null || !['assertion', 'output', 'exception'].includes(failure.kind)) continue;
      const label = String(failure.case);
      if (!group.cases.has(label)) group.cases.set(label, new Set());
      group.cases.get(label).add(trial.engine);
    }
  }
  for (const group of groups.values()) {
    const shared = [...group.cases].filter(([, engines]) => engines.size >= 3);
    if (!shared.length) continue;
    notes.push({ kind: 'shared_failures', task: group.task, repeat: group.repeat, cases: shared.map(([id]) => id),
      message: `${group.task} · attempt ${group.repeat}: at least 3 engines failed the same ${shared.length} check${shared.length === 1 ? '' : 's'} (${shared.slice(0, 6).map(([id]) => id).join(', ')}${shared.length > 6 ? ', …' : ''}). Inspect the task requirements and checks as well as the generated code; a shared failure is not an engine ranking.` });
  }
  return notes;
}
module.exports = { taskWarnings, comparisonNotes };
