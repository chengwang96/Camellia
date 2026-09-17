'use strict';

// Explicit opt-in: this diagnostic uses the configured Ollama API quota.
// Reports and model answers are saved; credentials only live in an OS temp dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { loadConfig, normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { createLibraryManager } = require('../src/benchmark/libraries');
const { BenchmarkRunner } = require('../src/benchmark/runner');
const { TASKS, SUITES } = require('../src/benchmark/tasks');

async function main() {
  if (!process.argv.includes('--use-configured-api')) throw new Error('Pass --use-configured-api to authorize paid Ollama requests.');
  const appRoot = path.resolve(__dirname, '..');
  const profile = path.join(process.env.APPDATA || path.join(os.homedir(), 'Library/Application Support'), 'dsh-desktop');
  const desktop = JSON.parse(fs.readFileSync(path.join(profile, 'desktop-config.json'), 'utf8'));
  const original = loadConfig(path.join(desktop.dshHome || path.join(os.homedir(), '.dsh'), 'ollama-proxy.json'));
  const model = process.argv.find(arg => arg.startsWith('--model='))?.slice('--model='.length) || 'deepseek-v4.1-flash';
  const provider = original.providers.find(p => p.enabled && new URL(p.baseUrl).hostname === 'ollama.com' && p.models.some(m => m.id === model));
  if (!provider) throw new Error('The configured Ollama model is unavailable: ' + model);
  const selected = { ...provider, models: provider.models.filter(m => m.id === model),
    keys: provider.keys.filter(k => k.enabled && !original.usage[k.id]?.blocked) };
  if (!selected.keys.length) throw new Error('No enabled Ollama key is available');
  const runtimes = createRuntimeManager({ root: appRoot, installRoot: appRoot, node: () => process.execPath });
  const libraries = createLibraryManager({ directory: path.join(profile, 'benchmark-libraries') });
  const timeoutSeconds = Number(process.argv.find(arg => arg.startsWith('--timeout-seconds='))?.split('=')[1] || 180);
  const runs = process.argv.includes('--preview') ? [{ suite: 'quick', preview: true, label: 'Five-minute coding preview' }] : [
    { suite: 'scicode-full', ids: ['scicode:74'], label: 'Scientific solver control' },
    { suite: 'ds1000-full', ids: ['ds1000:354', 'ds1000:160'], label: 'NumPy and pandas controls' },
  ].filter(run => !process.argv.includes('--science-only') || run.suite.startsWith('scicode'));
  // Validate data/runtimes before creating any billable scope.
  const resolved = runs.map(run => ({ ...run, selection: run.preview ? null : libraries.resolve(run.suite) }));
  const codexOnly = process.argv.includes('--codex-only');
  for (const engine of ['claude', 'codex', 'dsh', 'kimi', 'antigravity']) if (!runtimes.locate(engine, 'api')) throw new Error('Missing runtime: ' + engine);
  const output = path.join(appRoot, 'dist', 'benchmark-audit', 'live-' + Date.now());
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-live-audit-'));
  fs.mkdirSync(output, { recursive: true });
  let router, runner;
  try {
    const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const configPath = path.join(temp, 'router.json');
    writeConfig(configPath, normalizeConfig({ ...original, port, providers: [selected] }));
    router = startApiRouter({ configPath }); await router.ready;
    const summaries = [];
    for (const run of resolved) {
      const tasks = run.preview ? SUITES.find(s => s.id === 'quick').taskIds.map(id => TASKS.find(t => t.id === id))
        : run.ids.map(id => run.selection.tasks.find(t => t.id === id));
      if (tasks.some(t => !t)) throw new Error('Audit task missing from the pinned dataset');
      const suite = run.preview ? { id: 'quick' } : { ...run.selection.suite, id: run.suite + '-audit', name: run.label, taskIds: run.ids };
      const selection = run.preview ? null : { ...run.selection, suite, tasks,
        suiteHash: createHash('sha256').update(JSON.stringify({ fingerprint: run.selection.runtime.fingerprint, ids: tasks.map(t => t.sourceId) })).digest('hex'),
        library: { ...run.selection.library, sample: 'audit-controls-1' } };
      const manager = run.preview ? null : { state: () => libraries.state(), suites: () => [{ ...suite, library: run.selection.library.id, count: tasks.length }],
        resolve: id => id === suite.id ? selection : null };
      const seen = new Set();
      runner = new BenchmarkRunner({ directory: output, runtimes: () => runtimes, node: () => process.execPath, getRouter: () => router, libraries: manager,
        onChange: state => {
          for (const trial of state.active?.trials || []) if (!['pending', 'running'].includes(trial.status) && (trial.durationMs != null || trial.status === 'skipped') && !seen.has(trial.id)) {
            seen.add(trial.id); console.log(JSON.stringify({ engine: trial.engine, task: trial.task, status: trial.status,
              score: trial.checkScore, checks: trial.verification?.checks && `${trial.verification.checks.passed}/${trial.verification.checks.total}`,
              requests: trial.usage?.requests, toolFailures: trial.toolFailureCount || 0,
              seconds: Math.round((trial.durationMs || 0) / 1000), allowedSeconds: trial.timeoutSeconds }));
          }
        } });
      const { id } = runner.start({ suite: suite.id, mode: run.preview ? 'preview' : 'custom', model, providerId: selected.id, repeats: 1, timeoutSeconds, tokenBudget: 1500000 });
      if (codexOnly) {
        // start() schedules execution in the next microtask. Restrict this
        // diagnostic before any engine launches; never publish it as a comparison.
        runner.active.trials = runner.active.trials.filter(trial => trial.engine === 'codex');
        runner.active.execution = { mode: 'single-engine-audit', maxConcurrentTrials: 1, perEngineConcurrency: 1 };
        runner.active.configuration.audit = 'Codex-only diagnostic; other engines were not evaluated';
        runner.save();
      }
      console.log('Started ' + run.label + ' · ' + tasks.length * (codexOnly ? 1 : 5) + ' trials' + (codexOnly ? ' · Codex only (not a comparative run)' : ''));
      await runner.pending;
      const report = runner.report(id);
      summaries.push({ id, status: report.status, engines: report.engines.filter(engine => engine.expected > 0),
        tokens: report.trials.reduce((sum, row) => sum + (row.usage?.input || 0) + (row.usage?.output || 0), 0) });
      await runner.shutdown(); runner = null;
      if (report.status !== 'completed') break;
    }
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ model, summaries }, null, 2));
    console.log('Audit reports: ' + output);
  } finally {
    await runner?.shutdown(); await router?.stop();
    if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('camellia-live-audit-')) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
