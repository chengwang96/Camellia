'use strict';

// End-to-end check of the router-backed portable summary against a real
// OpenAI-compatible route: it starts the real API router from the local router
// configuration and summarizes through it, so it spends real provider quota.
// Not part of `npm test` or CI.
//
//   node tests/compaction-router-smoke.cjs deepseek-v4.1-flash
//   node tests/compaction-router-smoke.cjs <model> [router-config.json]
//
// Size knobs (the defaults are the cheap run):
//   COMPACTION_SMOKE_STEPS=10 COMPACTION_SMOKE_NOTES=200 node tests/compaction-router-smoke.cjs deepseek-v4.1-flash
//   COMPACTION_SMOKE_WINDOW=128000 node tests/compaction-router-smoke.cjs deepseek-v4.1-flash

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-fs.cjs');
const routerConfig = require('../src/api/api-router-config.js');
const { startApiRouter } = require('../src/api/api-router.js');
const { createCompactionSummarizer } = require('../src/api/compaction-summarizer.js');
const { planCompaction } = require('../src/engines/compaction-plan.js');
const { runSummaryPipeline } = require('../src/engines/compaction-summary.js');
const { SharedConversations, ENGINES } = require('../src/engines/shared-conversations');

const model = String(process.argv[2] || '').trim();
const configPath = process.argv[3] || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'ollama-proxy.json');
if (!model) {
  console.error('Usage: node tests/compaction-router-smoke.cjs <model> [router-config.json]');
  console.error('This sends real provider requests through the configured router key.');
  process.exit(2);
}

// The declared window drives the fragment count: the default is deliberately
// small so a moderate history still exercises many fragments, while
// COMPACTION_SMOKE_WINDOW can model a real model window instead.
const DECLARED_WINDOW = Math.max(4096, Number(process.env.COMPACTION_SMOKE_WINDOW) || 8000);
const STEPS = Math.max(2, Number(process.env.COMPACTION_SMOKE_STEPS) || 5);
const NOTES = Math.max(1, Number(process.env.COMPACTION_SMOKE_NOTES) || 80);

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

// Varied, marker-carrying text so the summary can be checked for the facts it
// must keep; a single repeated character would make that meaningless.
function stepRow(index) {
  return 'TASK-STEP-' + index + ' changed file src/feature-' + index + '.js\n'
    + 'Ran: node tests/step-' + index + '.cjs\n'
    + 'Outcome: PASS-' + index + ', duration ' + index * 120 + 'ms, tokens ' + index * 1000 + '.\n'
    + 'Notes: ' + ('Step ' + index + ' keeps the parser table in sync with the router catalog and records the provider fallback path. ').repeat(NOTES);
}

// The newest turn stays under the recent-retention limit, so the run exercises
// both halves: every older step is summarized, the last one is kept verbatim.
const finalRow = () => 'TASK-STEP-' + STEPS + ' wrapped up: node tests/step-' + STEPS + '.cjs passed and the change is ready to commit.';

// The pipeline is the same module the manager uses, so running it against an
// in-memory request predicts the exact request count of the paid run instead of
// hard-coding a number that only holds for one history size.
async function predictRequests(units, budget) {
  const counts = { map: 0, reduce: 0 };
  await runSummaryPipeline({ units, budget, request: async () => ({ text: 'stub' }),
    onProgress: update => { if (update.stage === 'running') counts[update.kind] += 1; } });
  return counts;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-router-'));
  const config = routerConfig.loadConfig(configPath);
  const port = await freePort();
  const tempConfig = path.join(dir, 'router.json');
  routerConfig.writeConfig(tempConfig, { ...config, port });
  const router = startApiRouter({ configPath: tempConfig, log: message => console.log('[router] ' + message) });
  let manager;
  try {
    await router.ready;
    console.log('router listening on ' + router.url + ', model ' + model);
    const summarizer = createCompactionSummarizer({ getConfig: () => routerConfig.loadConfig(tempConfig),
      getRoute: () => ({ baseUrl: router.url, authToken: 'proxy-managed' }), isRunning: () => true,
      log: message => console.log('[summarizer] ' + message) });
    if (!summarizer.available(model)) throw new Error('The router configuration has no route for ' + model);

    const drivers = Object.fromEntries(ENGINES.map(engine => [engine, { settings: () => ({ model }), saveSettings: value => value,
      ensure() { throw new Error('The engine session path must not be used for a router summary'); } }]));
    manager = new SharedConversations({ dir: path.join(dir, 'conversations'), loadConfig: () => ({}), saveConfig: () => {},
      drivers, onEvent: () => {}, log: () => {}, modelContextWindow: () => DECLARED_WINDOW, summarize: summarizer });

    const conversation = manager.create('claude');
    for (let index = 1; index <= STEPS; index++) manager.append(conversation, { role: 'user', text: index === STEPS ? finalRow() : stepRow(index) });
    const chars = manager.rows(conversation).reduce((total, row) => total + row.text.length, 0);
    // Mirrors the manager: cap comes from the declared window, the character
    // budget is 1.8x the cap, and nothing is compacted yet.
    const budget = Math.floor(DECLARED_WINDOW * 1.8);
    const plan = planCompaction(manager.rows(conversation).filter(row => !row.internal), budget);
    const predicted = await predictRequests(plan.units, budget);
    console.log('history ' + chars + ' chars, declared window ' + DECLARED_WINDOW + ' tokens, budget ' + budget + ' chars');
    console.log('plan: ' + plan.units.length + ' summarized unit(s), ' + plan.recent.length + ' retained row(s) (' + plan.recentChars
      + ' chars); predicted ' + predicted.map + ' map + ' + predicted.reduce + ' merge request(s)');

    const startedAt = Date.now();
    const result = await manager.compact(conversation.id);
    const elapsedMs = Date.now() - startedAt;
    const compaction = conversation.lastCompaction;
    console.log('\ntransport=' + compaction.transport + ' requests=' + compaction.requests + ' retries=' + (compaction.retries || 0)
      + ' retainedChars=' + compaction.retainedChars + ' totalMs=' + compaction.totalMs);
    for (const chunk of compaction.chunks) {
      console.log('  ' + String(chunk.kind).padEnd(6) + ' request=' + String(chunk.request).padEnd(3) + ' inputChars=' + String(chunk.inputChars).padEnd(7)
        + ' maxTokens=' + String(chunk.summaryLimit).padEnd(6) + ' outputChars=' + String(chunk.outputChars).padEnd(6)
        + ' totalMs=' + String(chunk.totalMs).padEnd(7) + (chunk.usage ? 'usage=' + JSON.stringify(chunk.usage) : ''));
    }
    const markdown = fs.readFileSync(result.file, 'utf8');
    const [summary, recent] = markdown.split('## Recent conversation (verbatim JSON data)');
    console.log('\nsummary (' + summary.length + ' chars):\n' + summary.slice(0, 1200) + '\n…');

    const maps = compaction.chunks.filter(chunk => chunk.kind === 'map');
    const reduces = compaction.chunks.filter(chunk => chunk.kind === 'reduce');
    // An answer over its target is asked for again, so one fragment can produce
    // a rejected attempt plus its shorter replacement.
    const shortened = maps.filter(chunk => chunk.outcome === 'shortened');
    const answered = maps.filter(chunk => chunk.outcome !== 'shortened');
    const failures = [];
    const notices = [];
    if (compaction.transport !== 'router') failures.push('expected the router transport, saw ' + compaction.transport);
    // A provider context limit re-splits a fragment under a smaller budget, so
    // only an unshrunk run has to match the predicted counts exactly.
    if (!compaction.retries && answered.length !== predicted.map) failures.push('expected ' + predicted.map + ' summarized fragments, saw ' + answered.length);
    if (compaction.retries && maps.length < predicted.map) failures.push('the shrunk run sent fewer map requests than the full-size plan, which would have dropped text');
    // Longer answers need more merge batches, so the stub count is a lower bound.
    if (reduces.length < predicted.reduce) failures.push('expected at least ' + predicted.reduce + ' merge request(s), saw ' + reduces.length);
    if (compaction.requests > 128) failures.push('the request cap was exceeded: ' + compaction.requests);
    if (plan.recent.length) {
      if (!/## Recent conversation/.test(markdown)) failures.push('the newest turn was not retained verbatim');
      if (!new RegExp('TASK-STEP-' + STEPS + '\\b').test(recent || '')) failures.push('the retained turn is missing');
    } else if (/## Recent conversation/.test(markdown)) failures.push('a verbatim section was written although nothing was retained');
    if (!summary.trim()) failures.push('the summary is empty');
    // A request the provider rejected for context length legitimately has no
    // output; only an unshrunk run has to answer every request.
    const produced = compaction.chunks.filter(chunk => chunk.totalMs >= 0 && chunk.outputChars > 0);
    if (!produced.length) failures.push('no summary request produced output');
    if (!compaction.retries && shortened.length === 0 && produced.length !== compaction.chunks.length)
      failures.push('an unshrunk run had a request without usable output');
    // Facts inside a model-written summary depend on the model, so they are
    // reported rather than treated as transport failures.
    if (compaction.retries) notices.push('the budget shrank ' + compaction.retries + ' time(s)');
    if (shortened.length) notices.push(shortened.length + ' answer(s) exceeded the target and were asked for again');
    if (!/TASK-STEP-1\b/.test(summary)) notices.push('the summary dropped the earliest step');
    if (!new RegExp('TASK-STEP-' + (STEPS - 1) + '\\b').test(summary)) notices.push('the summary dropped the last summarized step');

    const spent = compaction.chunks.reduce((total, chunk) => total + (chunk.usage?.total_tokens || 0), 0);
    console.log('\nrequests=' + compaction.requests + ' reportedTokens=' + spent + ' (wall clock ' + elapsedMs + 'ms)');
    console.log('conversation segments: ' + JSON.stringify(conversation.segments[conversation.currentEngine]));
    for (const notice of notices) console.log('note: ' + notice);
    if (failures.length) throw new Error('router compaction smoke test failed:\n- ' + failures.join('\n- '));
    console.log('\nOK: ' + answered.length + ' summarized fragments + ' + reduces.length + ' merge request(s) in ' + elapsedMs + 'ms');
  } finally {
    if (manager) manager.pauseGoals();
    await router.stop();
    removeTree(dir);
  }
}

main().catch(error => { console.error('\nFAILED: ' + error.message); process.exitCode = 1; });
