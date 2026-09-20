'use strict';

const api = window.dshDesktop;
const t = text => window.CamelliaI18n.t(text);
const $ = id => document.getElementById(id);
const engines = ['claude', 'codex', 'dsh', 'kimi', 'antigravity'];
const names = { claude: 'Claude Code', codex: 'Codex CLI', dsh: 'DeepSeek Harness', kimi: 'Kimi Code', antigravity: 'Antigravity SDK' };
// Presentation copy stays outside the versioned data/environment specifications.
const libraryDescriptions = {
  builtin: 'File editing, data processing and multi-file fixes.',
  ds1000: 'Python data science across seven libraries, including NumPy and pandas.',
  scicode: 'Scientific programming, numerical methods and simulations.',
};
const statusLabels = { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', error: 'Error', timeout: 'Timeout',
  grader_error: 'Grader error',
  limit: 'Limit reached', cancelled: 'Stopped', skipped: 'Not started', cancelling: 'Stopping…', completed: 'Completed', interrupted: 'Interrupted', budget_exceeded: 'Token limit reached', time_limit_reached: 'Preview time budget reached' };
let state, selectedId = '', selectedReport = null, modelSignature = '', installing = '', starting = false, selectedTrial = null;
let librarySignature = '', suiteSignature = '', preparingLibrary = false, matrixPage = 0, matrixKey = '';
const PAGE_SIZE = 25;
const preferredLimits = { timeout: 'auto', tokensPerTask: 'auto', budget: '' };
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const ui = (tag, text, className) => { const el = node(tag, text, className); el.dataset.i18n = ''; return el; };
const uiOption = (text, value) => { const el = new Option(text, value); el.dataset.i18n = ''; return el; };
const fmt = n => new Intl.NumberFormat(window.CamelliaI18n.locale, { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n || 0);
const duration = ms => ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;
const partial = trial => trial.status === 'failed' && trial.checkScore > 0;
const trialLabel = trial => partial(trial) ? 'Partial' : trial.failureKind === 'output_limit' ? 'Output limit' : statusLabels[trial.status];
function mark(id) {
  const mark = node('span', undefined, 'engine-mark'), img = node('img'); mark.dataset.engine = id;
  img.src = '../../../assets/brands/' + (id === 'dsh' ? 'deepseek' : id) + (id === 'codex' ? '.png' : '.svg'); img.alt = ''; mark.append(img); return mark;
}
function notice(message = '') { $('notice').textContent = message; }
async function checked(promise) { const result = await promise; if (!result.ok) throw new Error(result.error || 'The operation failed'); return result; }
function busy() { return starting || state?.busy || ['running', 'cancelling'].includes(state?.active?.status); }
function selectedLibrary() { return (state?.libraries || [{id:'builtin',name:'Camellia built-in',ready:true}]).find(l => l.id === $('library').value); }
const runMode = () => document.querySelector('input[name="runMode"]:checked')?.value || 'preview';
const timeLimitLabel = seconds => seconds % 60 ? `${Math.round(seconds * 10) / 10} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
function recommendedTimeout() { return selectedLibrary()?.defaultTimeoutSeconds || 300; }
function selectedTimeout() { return $('timeout').value === 'auto' ? recommendedTimeout() : Number($('timeout').value); }
function recommendedTokensPerTask() { return selectedLibrary()?.defaultTokensPerTask || 250000; }
function selectedTokensPerTask() { return $('tokensPerTask').value === 'auto' ? recommendedTokensPerTask() : Number($('tokensPerTask').value); }
function selectedBudget() { return $('budget').value === '' ? null : Number($('budget').value); }
function updateControls() {
  const running = busy();
  const preparing = preparingLibrary || state?.libraryBusy;
  $('timeout').querySelector('[value="auto"]').textContent = `Recommended · ${timeLimitLabel(recommendedTimeout())}`;
  $('tokensPerTask').querySelector('[value="auto"]').textContent = `Recommended · ${fmt(recommendedTokensPerTask())} tokens`;
  const active = running && ['running', 'cancelling'].includes(state?.active?.status) ? state.active : null;
  const preview = runMode() === 'preview';
  const fixed = { timeout: String(state?.preview?.timeoutSeconds || 270), tokensPerTask: String(state?.preview?.maxTokensPerTask || 250000), budget: '' };
  const sharedTime = active ? active.timeAllocation?.mode === 'shared-preview' : preview;
  $('timeoutLabel').textContent = sharedTime ? 'Time shared by each engine’s tasks' : 'Time per task';
  for (const [id, field] of [['timeout', 'timeoutSeconds'], ['tokensPerTask', 'maxTokensPerTask'], ['budget', 'tokenBudget']]) {
    const value = active && id === 'budget' ? String(active[field] ?? '') : active?.[field] > 0 ? String(active[field]) : preview ? fixed[id] : preferredLimits[id];
    if (![...$(id).options].some(option => option.value === value)) {
      $(id).append(uiOption(id === 'timeout' ? timeLimitLabel(Number(value)) : `${fmt(Number(value))} tokens`, value));
    }
    $(id).value = value;
  }
  for (const id of ['model', 'library', 'suite', 'repeats', 'timeout', 'tokensPerTask', 'budget']) $(id).disabled = running || preparing;
  for (const input of document.querySelectorAll('input[name="runMode"]')) input.disabled = running || preparing;
  if (preview) for (const id of ['library', 'suite', 'repeats', 'timeout', 'tokensPerTask', 'budget']) $(id).disabled = true;
  if (runMode() === 'full') $('suite').disabled = true;
  $('start').disabled = running || preparing || Boolean(installing) || !selectedLibrary()?.ready || !state?.routerReady || !$('model').value || state.engines.some(e => !e.ready);
  $('start').hidden = running; $('cancel').hidden = !running;
  $('cancel').disabled = starting || state?.active?.status === 'cancelling';
  const suite = state?.suites.find(s => s.id === $('suite').value);
  const tasks = suite?.count || suite?.taskIds.length || 3;
  const attempts = active?.trials.length || tasks * engines.length * Number($('repeats').value);
  $('runHint').textContent = `${attempts} attempts · uses your API quota`;
  $('start').textContent = preview ? 'Start 5-minute preview' : runMode() === 'full' ? 'Run full library' : 'Run benchmark';
  const taskAllowances = tasks * Number($('repeats').value) * (selectedTimeout() + (selectedLibrary()?.id === 'builtin' ? 10 : 120));
  const allowanceLabel = taskAllowances >= 3600 ? `${(taskAllowances / 3600).toFixed(1)} hours` : `${Math.ceil(taskAllowances / 60)} minutes`;
  $('modeGuide').textContent = preview
    ? 'Preview: 4.5 minutes shared by each engine’s three tasks, plus 30 seconds for checks and cleanup.'
    : runMode() === 'full'
      ? `Task and check allowances: ${allowanceLabel} per engine, plus startup and cleanup. Keep Camellia open; results save after each attempt.`
      : 'Limits apply to each task. No whole-run time limit.';
  const budget = selectedBudget();
  const perTask = selectedTokensPerTask();
  $('limitHint').textContent = `${timeLimitLabel(selectedTimeout())} ${sharedTime ? 'shared across each engine’s 3 tasks' : 'per task'} · ${fmt(perTask)} tokens per task attempt`;
  $('budgetAdvice').textContent = `${attempts} task budgets: up to ${fmt(perTask * attempts)} reported tokens. ${budget == null
    ? 'Whole-run cap: off.'
    : `Whole-run cap: ${fmt(budget)} tokens.`}`;
  const library = selectedLibrary();
  $('prepareLibrary').hidden = !library || library.ready;
  $('prepareLibrary').disabled = running || preparing || Boolean(installing);
  $('prepareLibrary').textContent = library?.status === 'installing' || preparingLibrary ? 'Preparing…' : 'Prepare library';
  $('libraryDescription').textContent = library?.id === 'builtin' && $('suite').value === 'standard'
    ? 'Code repair, Unicode edge cases, algorithms and configuration tracing.' : libraryDescriptions[library?.id] || library?.description || '';
  $('libraryCaveat').textContent = library?.id === 'scicode'
    ? 'Short samples omit #15 and #46 due to known test limitations. Full library includes both.' : '';
  $('libraryStatus').textContent = library?.message || (library?.ready ? library.id === 'builtin' ? '' : 'Ready' : library?.downloadSize || '');
}
function renderSetup() {
  const libraries = state.libraries || [{id:'builtin',name:'Camellia built-in',ready:true}];
  const libraryKey = JSON.stringify(libraries.map(l => [l.id, l.name]));
  if (librarySignature !== libraryKey) {
    librarySignature = libraryKey;
    const previous = $('library').value;
    $('library').replaceChildren(...libraries.map(l => uiOption(l.name, l.id)));
    if (libraries.some(l => l.id === previous)) $('library').value = previous;
  }
  if (busy()) {
    const report = state.active;
    const selectedMode = document.querySelector(`input[name="runMode"][value="${['preview', 'full'].includes(report?.mode) ? report.mode : 'custom'}"]`);
    if (report && selectedMode) selectedMode.checked = true;
    if (report && libraries.some(l => l.id === (report.library?.id || 'builtin'))) $('library').value = report.library?.id || 'builtin';
  }
  if (runMode() === 'preview') $('library').value = 'builtin';
  const suites = state.suites.filter(s => (s.library || 'builtin') === $('library').value);
  const suiteKey = JSON.stringify(suites.map(s => [s.id, s.name, s.count || s.taskIds.length]));
  if (suiteSignature !== suiteKey) {
    suiteSignature = suiteKey;
    const previous = $('suite').value;
    $('suite').replaceChildren(...suites.map(s => uiOption(`${s.name} · ${s.count || s.taskIds.length} tasks`, s.id)));
    if (suites.some(s => s.id === previous)) $('suite').value = previous;
  }
  if (busy()) {
    const report = state.active;
    if (report && suites.some(s => s.id === report.suite)) $('suite').value = report.suite;
  }
  if (runMode() === 'preview') { $('suite').value = 'quick'; $('repeats').value = '1'; }
  if (runMode() === 'full') $('suite').value = $('library').value === 'builtin' ? 'standard' : `${$('library').value}-full`;
  const signature = JSON.stringify(state.models);
  if (modelSignature !== signature) {
    modelSignature = signature;
    const previous = $('model').value;
    $('model').replaceChildren();
    if (!state.models.length) $('model').append(uiOption('Add an API key and model to begin', ''));
    for (const model of state.models) $('model').append(new Option(`${model.id} · ${model.provider}`, JSON.stringify([model.providerId, model.id])));
    if ([...$('model').options].some(o => o.value === previous)) $('model').value = previous;
  }
  $('runtimeStatus').replaceChildren();
  for (const engine of state.engines) {
    const item = node('div', undefined, 'runtime-item'); item.append(mark(engine.id), node('span', engine.name));
    if (engine.ready) item.append(node('span', '✓', 'ready'));
    else {
      const button = ui('button', installing === engine.id ? 'Downloading…' : 'Download');
      button.disabled = Boolean(installing) || busy(); button.dataset.install = engine.id;
      button.addEventListener('click', async () => {
        installing = engine.id; notice(); renderSetup(); updateControls();
        try { const result = await checked(api.benchmarkInstall(engine.id)); if (!result.canceled) render(result); }
        catch (error) { notice(error.message); }
        finally { installing = ''; await refresh(); }
      });
      item.append(button);
    }
    $('runtimeStatus').append(item);
  }
  $('history').querySelectorAll('option').forEach(option => option.remove());
  $('history').append(uiOption('Run history', ''));
  for (const report of state.history) $('history').append(new Option(`${new Date(report.startedAt).toLocaleString(window.CamelliaI18n.locale)} · ${report.model} · ${t(statusLabels[report.status] || report.status)}`, report.id));
  $('history').value = selectedId;
  updateControls();
}
function renderResults(report) {
  const currentSuite = state.suites.find(s => s.id === (report?.suite || $('suite').value));
  // Saved metadata keeps old runs readable even when a library is unavailable
  // or a newer application ships a different task catalog.
  const suite = report?.tasks ? { name: report.suiteName || currentSuite?.name || report.suite, tasks: report.tasks } : currentSuite || { name: report?.suite || '', tasks: [] };
  $('export').disabled = !report;
  $('deleteRun').disabled = !report || report.status === 'running' || report.status === 'cancelling';
  if (deleteArmed && deleteArmed !== report?.id) { deleteArmed = null; $('deleteRun').textContent = t('Delete'); }
  const scheduling = report?.execution?.mode === 'parallel-engines' ? `${report.execution.maxConcurrentTrials} engines in parallel` : 'Sequential run';
  const metadata = report ? [report.model, report.provider, t(report.library?.name || 'Camellia built-in'), t(suite.name)] : [];
  const configuration = report ? [t(`${report.repeats} attempt${report.repeats > 1 ? 's' : ''} per task`),
    t(scheduling), new Date(report.startedAt).toLocaleString(window.CamelliaI18n.locale)] : [];
  const builtinVersion = !report?.library || report.library.id === 'builtin' ? /^camellia-bench-(\d+)$/.exec(report?.version || '')?.[1] : null;
  if (builtinVersion) metadata.push(t(`Built-in v${builtinVersion}`));
  if (report?.timeoutSeconds) configuration.push(t(`${timeLimitLabel(report.timeoutSeconds)} ${report.timeAllocation?.mode === 'shared-preview' ? 'shared across each engine’s tasks' : 'per task'}`));
  if (report?.maxTokensPerTask) configuration.push(t(`${fmt(report.maxTokensPerTask)} tokens per task attempt`));
  if (report?.tokenBudget) configuration.push(t(`${fmt(report.tokenBudget)} whole-run token cap`));
  if (report?.regradedAt) configuration.push(t(`Saved answers rechecked ${new Date(report.regradedAt).toLocaleString(window.CamelliaI18n.locale)} (no model calls)`));
  if (report?.mode === 'preview') configuration.push(t('5-minute preview'));
  if (report?.mode === 'full') configuration.push(t('Full library'));
  $('runMeta').textContent = report ? metadata.join(' · ') : 'Choose a model to start your first comparison.';
  $('runDetails').hidden = !report;
  $('runConfiguration').textContent = configuration.join(' · ');
  renderClock(report);
  $('progressSection').hidden = !report;
  $('reportError').textContent = report?.error || '';
  const timeouts = report?.trials.filter(trial => trial.status === 'timeout').length || 0;
  $('runLimitNote').textContent = [
    timeouts && report?.status !== 'time_limit_reached' ? `${timeouts} timed out. Open a result for details.` : '',
    report?.status === 'budget_exceeded' ? `Whole-run token cap reached (${fmt(report.tokenBudget)} tokens).` : '',
    report?.status === 'time_limit_reached' ? 'Preview ended; unstarted tasks have no score.' : '',
    report?.engines.some(e => e.completed < e.expected && e.observedCheckScore != null) ? 'Scores cover completed attempts only.' : '',
  ].filter(Boolean).map(t).join(' ');
  $('comparisonNotes').replaceChildren(...(report?.comparisonNotes || []).slice(0, 8).map(note => node('p', note.message, 'benchmark-note')));
  if (report?.comparisonNotes?.length > 8) $('comparisonNotes').append(node('p', `${report.comparisonNotes.length - 8} additional notices are included in Export JSON.`, 'score-note'));
  if (report) {
    const finished = report.trials.filter(t => !['pending', 'running', 'skipped'].includes(t.status)).length;
    const running = report.trials.filter(t => t.status === 'running').length;
    $('progress').max = report.trials.length; $('progress').value = finished;
    $('progressText').textContent = `${finished} / ${report.trials.length} attempts finished${running ? ` · ${running} running` : ''}`;
    $('runStatus').textContent = report.status === 'running' && report.activity ? report.activity : statusLabels[report.status] || report.status;
  }
  $('scoreboard').replaceChildren();
  for (const id of engines) {
    const result = report?.engines.find(e => e.id === id);
    const card = node('article', undefined, 'score');
    const title = node('div', undefined, 'score-name'); title.append(mark(id), node('span', names[id]));
    const shownScore = result?.checkScore ?? result?.observedCheckScore;
    const shownPassRate = result?.score ?? result?.observedPassRate;
    const preliminary = result && result.completed < result.expected;
    const score = node('div', shownScore != null ? String(shownScore) : '—', 'score-number'); score.append(node('small', ' / 100'));
    card.append(title, ui('p', preliminary ? 'Preliminary check score' : 'Check score', 'score-label'), score);
    if (result) card.append(
      ui('p', `Full-task pass rate: ${shownPassRate != null ? shownPassRate + '%' : '—'}`, 'score-stat strict-score'),
      ui('p', `${result.passed} passed · ${result.completed}/${result.expected} evaluated`, 'score-stat'));
    if (result?.invalid) card.append(ui('p', 'Grader error · score unavailable', 'score-stat'));
    else if (result && result.completed === result.expected && result.checkScore == null) card.append(ui('p', 'Some check counts were not saved', 'score-stat'));
    if (result) {
      card.append(ui('p', `${duration(result.durationMs)} · ${fmt(result.tokens)} tokens${result.unreported ? ' + unreported usage' : ''}`, 'score-stat'));
      if (result.version) card.append(ui('p', `v${result.version}`, 'score-version'));
    }
    $('scoreboard').append(card);
  }
  const head = node('tr'); head.append(ui('th', 'Task'));
  for (const id of engines) head.append(node('th', id === 'dsh' ? 'DSH' : id === 'antigravity' ? 'Antigravity' : names[id]));
  $('matrix').tHead.replaceChildren(head); const body = $('matrix').tBodies[0]; body.replaceChildren();
  const key = report?.id || $('suite').value;
  if (matrixKey !== key) { matrixKey = key; matrixPage = 0; }
  const tasks = suite.tasks || [];
  const pages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE)); matrixPage = Math.min(matrixPage, pages - 1);
  $('matrixPager').hidden = pages < 2;
  $('previousTasks').disabled = matrixPage === 0; $('nextTasks').disabled = matrixPage === pages - 1;
  $('taskPage').textContent = `${matrixPage * PAGE_SIZE + 1}–${Math.min(tasks.length, (matrixPage + 1) * PAGE_SIZE)} of ${tasks.length} tasks`;
  const trialsByTask = new Map();
  for (const trial of report?.trials || []) {
    const k = trial.task + ':' + trial.engine;
    if (!trialsByTask.has(k)) trialsByTask.set(k, []);
    trialsByTask.get(k).push(trial);
  }
  for (const task of tasks.slice(matrixPage * PAGE_SIZE, (matrixPage + 1) * PAGE_SIZE)) {
    const row = node('tr'), label = node('td', task.name); label.append(node('span', task.category, 'task-category')); row.append(label);
    if (task.warnings?.length) label.append(ui('span', 'Test limitation · see details', 'task-category task-caveat'));
    for (const id of engines) {
      const cell = node('td'), trials = trialsByTask.get(task.id + ':' + id) || [];
      if (!trials.length) cell.append(node('span', '—'));
      for (const trial of trials) {
        const button = ui('button', `${trials.length > 1 ? trial.repeat + ': ' : ''}${trialLabel(trial)}`, 'cell ' + (partial(trial) ? 'partial' : trial.status));
        if (trial.checkScore != null && trial.status !== 'passed') button.append(node('small', `${trial.checkScore} / 100`, 'case-score'));
        const checks = trial.verification?.checks;
        if (checks) button.append(ui('small', `${checks.passed}/${checks.total} checks`, 'case-count'));
        button.disabled = ['pending', 'skipped'].includes(trial.status); button.setAttribute('aria-label', `${names[id]} · ${task.name} · attempt ${trial.repeat} · ${trialLabel(trial)}`);
        button.addEventListener('click', () => showTrial(task, trial)); cell.append(button);
      }
      row.append(cell);
    }
    body.append(row);
  }
  if (!$('trialDetail').hidden && selectedTrial?.report === report?.id) {
    const trial = report.trials.find(t => t.id === selectedTrial.id), task = tasks.find(t => t.id === trial?.task);
    if (trial && task) showTrial(task, trial);
  }
}
function showTrial(task, trial) {
  selectedTrial = { report: selectedReport?.id, id: trial.id };
  $('trialDetail').hidden = false;
  $('detailTitle').textContent = `${names[trial.engine]} · ${task.name} · ${t(`attempt ${trial.repeat}`)}`;
  $('detailSummary').textContent = `${t(trialLabel(trial))}${trial.checkScore != null ? ' · ' + t(`Check score: ${trial.checkScore} / 100`) : ''} · ${duration(trial.durationMs || 0)} · ${t(`${fmt((trial.usage?.input || 0) + (trial.usage?.output || 0))} reported tokens`)}`;
  if (trial.timeoutSeconds != null) $('detailSummary').textContent += ' · ' + t(`Time allowance: ${timeLimitLabel(trial.timeoutSeconds)}`);
  $('timeoutContext').textContent = trial.timeoutContext ? `Stopped during: ${trial.timeoutContext.activity}. ${trial.timeoutContext.requestsInFlight} API request(s) were still in flight. Cancellation can leave their token usage unreported.` : '';
  if (trial.toolFailureCount) $('timeoutContext').textContent += ` ${trial.toolFailureCount} tool call${trial.toolFailureCount === 1 ? '' : 's'} failed during this attempt. Inspect the activity timeline and tool errors below.`;
  $('trialTimeline').hidden = !trial.timeline?.length;
  $('timelineText').textContent = (trial.timeline || []).map(event => `${(event.atMs / 1000).toFixed(1)}s · ${event.detail}`).join('\n');
  if (trial.omittedEvents) $('timelineText').textContent = `${trial.omittedEvents} earlier events omitted.\n` + $('timelineText').textContent;
  $('taskCaveat').textContent = (task.warnings || []).map(warning => warning.message).join(' ');
  const checks = trial.verification?.checks;
  $('checkSummary').textContent = checks ? `Independent checks: ${checks.passed}/${checks.total} passed${checks.evaluated < checks.total ? ` · ${checks.total - checks.evaluated} could not be evaluated` : ''}` : '';
  $('detailVerdict').textContent = trial.error || trial.detail || (trial.status === 'running' ? 'The engine is working on this task.' : 'No checker result was recorded.');
  $('caseFailures').replaceChildren();
  const kinds = { output: 'Output mismatch', exception: 'Function error', input_mutated: 'Input mutated', input_changed: 'Required input file changed',
    assertion: 'Check mismatch', invalid_json: 'Invalid JSON', file: 'Result file unavailable', execution: 'Check could not run',
    timeout: 'Check timed out', not_evaluated: 'Check not evaluated', grader: 'Grader environment error' };
  for (const failure of checks?.failures || []) {
    const item = node('article', undefined, 'case-failure');
    item.append(node('h4', `${failure.file}${failure.case ? ' · case ' + failure.case : ''} · ${kinds[failure.kind] || 'Check failed'}`));
    const values = node('dl', undefined, 'case-values');
    for (const [key, label] of [['input', 'Arguments'], ['expected', 'Expected'], ['actual', 'Actual']]) {
      if (failure[key] === undefined) continue;
      const group = node('div'), value = node('dd'); value.append(node('pre', failure[key])); group.append(ui('dt', label), value); values.append(group);
    }
    item.append(values);
    if (failure.error) item.append(node('p', failure.error, 'case-error'));
    if (failure.location) item.append(node('p', failure.location, 'case-error'));
    if (failure.log) { const log = node('details'); log.append(ui('summary', 'Captured test output'), node('pre', failure.log)); item.append(log); }
    $('caseFailures').append(item);
  }
  if (checks?.omittedFailures) $('caseFailures').append(node('p', `${checks.omittedFailures} further failures omitted from this report.`));
  if (trial.toolFailures?.length) {
    const errors = node('details'); errors.append(ui('summary', `Tool errors (${trial.toolFailureCount || trial.toolFailures.length})`));
    errors.append(node('pre', trial.toolFailures.map(failure => `${(failure.atMs / 1000).toFixed(1)}s · ${failure.tool}\n${failure.input}\n${failure.output}`).join('\n\n')));
    $('caseFailures').append(errors);
  }
  const advice = trial.status === 'grader_error' ? 'The evaluator could not run correctly, so this attempt has no valid score. Repair the grader and recheck the saved solution; no model call is needed.'
    : trial.status === 'failed'
    ? checks ? 'Passed checks earn partial credit in the check score. A full task pass requires every check to pass. Inspect the remaining failures and changed files.'
      : 'This older report has no per-check details. Inspect its saved files and log. New runs record the failed arguments, expected output and actual output.'
    : trial.failureKind === 'run_time_limit' ? 'The five-minute whole-run budget ended. Choose a custom or full-library run to allow more time.'
    : trial.failureKind === 'preview_time_limit' ? 'This engine used the time budget shared across its three tasks. Choose a custom or full-library run to allow more time.'
    : trial.status === 'timeout' ? 'The task exceeded its time limit. To try a longer limit, start a new comparison using that same limit for all engines.'
    : trial.status === 'limit' ? 'The task reached its API request or token limit. Review usage before starting another comparison.'
    : trial.failureKind === 'output_limit' ? 'A single model response was cut off before the engine completed. This is separate from the per-task time and token limits.'
    : trial.status === 'error' ? trial.apiError ? 'The API request failed. Check model access, key permissions, quota and provider connectivity in API settings.'
      : 'The harness did not finish. Check the engine log and installed runtime.'
    : trial.status === 'passed' ? 'All independent checks passed.' : '';
  $('detailAdvice').textContent = advice;
  $('detailText').textContent = [trial.apiError, trial.text, trial.log].filter(Boolean).join('\n\n') || 'No engine output was recorded.';
  $('detailChanges').textContent = (trial.changes || []).map(change => `${change.path}\n${change.after}`).join('\n\n') || 'No changed files were captured.';
}
function render(next) {
  state = next;
  if (!selectedId) selectedId = state.active?.id || state.latest?.id || '';
  if (state.active?.id === selectedId) selectedReport = state.active;
  else if (state.latest?.id === selectedId) selectedReport = state.latest;
  renderSetup(); renderResults(selectedReport);
}
async function refresh() { try { render(await checked(api.benchmarkState())); } catch (error) { notice(error.message); } }
window.addEventListener('camellia:language', () => { if (state) render(state); });
function renderClock(report = selectedReport) {
  if (!report) { $('runClock').textContent = ''; return; }
  const elapsed = Math.max(0, (report.finishedAt ? Date.parse(report.finishedAt) : Date.now()) - Date.parse(report.startedAt));
  const remaining = Math.max(0, (report.maxDurationSeconds || 0) * 1000 - elapsed);
  $('runClock').textContent = `Elapsed ${duration(elapsed)}${report.maxDurationSeconds && !report.finishedAt ? ` · ${duration(remaining)} remaining in the whole-run budget` : ''}`;
}
setInterval(() => { if (selectedReport && !selectedReport.finishedAt) renderClock(); }, 1000);
for (const input of document.querySelectorAll('input[name="runMode"]')) input.addEventListener('change', () => {
  notice(); renderSetup(); if (!selectedReport) renderResults(null);
});
$('home').addEventListener('click', () => api.switchMode('home'));
$('settings').addEventListener('click', () => api.openSettingsWindow({ page: 'providers' }));
$('library').addEventListener('change', () => { notice(); renderSetup(); if (!selectedReport) renderResults(null); });
$('prepareLibrary').addEventListener('click', async () => {
  preparingLibrary = true; notice(); updateControls();
  try { render(await checked(api.benchmarkPrepareLibrary($('library').value))); }
  catch (error) { notice(error.message); }
  finally { preparingLibrary = false; await refresh(); }
});
$('previousTasks').addEventListener('click', () => { matrixPage--; renderResults(selectedReport); });
$('nextTasks').addEventListener('click', () => { matrixPage++; renderResults(selectedReport); });
for (const id of ['model', 'suite', 'repeats', 'timeout', 'tokensPerTask', 'budget']) $(id).addEventListener('change', () => {
  if (id in preferredLimits) preferredLimits[id] = $(id).value;
  updateControls(); if (!selectedReport) renderResults(null);
});
$('start').addEventListener('click', async () => {
  notice(); starting = true; updateControls();
  try {
    const [providerId, model] = JSON.parse($('model').value);
    const result = await checked(api.benchmarkStart({ providerId, model, mode: runMode(), library: $('library').value, suite: $('suite').value, repeats: Number($('repeats').value),
      timeoutSeconds: selectedTimeout(), maxTokensPerTask: selectedTokensPerTask(), tokenBudget: selectedBudget() }));
    selectedId = result.id; selectedReport = null; $('trialDetail').hidden = true;
  } catch (error) { notice(error.message); }
  finally { starting = false; await refresh(); }
});
$('cancel').addEventListener('click', async () => { try { await checked(api.benchmarkCancel()); await refresh(); } catch (error) { notice(error.message); } });
$('history').addEventListener('change', async () => {
  const id = $('history').value;
  if (!id) return;
  selectedId = id; $('trialDetail').hidden = true;
  try { const result = await checked(api.benchmarkReport(id)); if (selectedId === id) { selectedReport = result.report; renderResults(selectedReport); } }
  catch (error) { notice(error.message); }
});
$('export').addEventListener('click', async () => { try { await checked(api.benchmarkExport(selectedId)); } catch (error) { notice(error.message); } });
// Two-step delete: first click arms the button, second click removes the run.
let deleteArmed = null;
$('deleteRun').addEventListener('click', async () => {
  if (!selectedId) return;
  if (deleteArmed !== selectedId) {
    deleteArmed = selectedId;
    $('deleteRun').textContent = t('Delete this run?');
    setTimeout(() => { if (deleteArmed) { deleteArmed = null; $('deleteRun').textContent = t('Delete'); } }, 3000);
    return;
  }
  deleteArmed = null;
  try {
    await checked(api.benchmarkDelete(selectedId));
    selectedId = ''; selectedReport = null; $('trialDetail').hidden = true;
    await refresh();
  } catch (error) { notice(error.message); }
});
$('closeDetail').addEventListener('click', () => { $('trialDetail').hidden = true; });
api.onBenchmarkState(render);
api.onApiRouterState(() => { void refresh(); });
api.onRuntimeState(() => { void refresh(); });
void refresh();
