'use strict';

// Real production drivers and native runtimes; every inference response is
// loopback-only. Profiles and sanitized captures stay in ignored artifacts/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { createEngineDrivers } = require('./fixtures/engine-drivers');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { isolatedEnvironment } = require('../src/engines/isolated-environment');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { startApiRouter } = require('../src/api/api-router');

const profiles = [
  { model: 'deepseek-flash', type: 'deepseek', values: ['none', 'low', 'high', 'max'] },
  { model: 'glm-5.3', type: 'custom', values: ['low', 'high', 'max'] },
  { model: 'kimi-k3', type: 'kimi', values: ['low', 'high', 'max'] },
  { model: 'kimi-k2.6', type: 'kimi', values: [false, true] },
  { model: 'gemini-3-flash-preview', type: 'gemini', values: ['minimal', 'low', 'high'] },
  { model: 'fixed-control-fixture', type: 'custom', values: [] },
];
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
});
async function freePort() {
  const server = http.createServer(); await listen(server);
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

const allEngines = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok'];
function casesFor(engines = allEngines) {
  assert.ok(engines.length && new Set(engines).size === engines.length
    && engines.every(engine => allEngines.includes(engine)), 'Specify distinct harness IDs');
  return engines.flatMap(engine => profiles.flatMap(profile =>
    ['', ...profile.values.map(value => value === false ? 'none' : value === true ? 'high' : value)]
      .map(level => ({ engine, profile, level }))));
}
const caseId = row => JSON.stringify([row.engine, row.profile?.model || row.model, row.level ?? (row.selected === 'default' ? '' : row.selected)]);
function partitionCases(cases, count) {
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 8, 'Choose 1 to 8 workers');
  return Array.from({ length: count }, (_, index) => cases.filter((_, at) => at % count === index));
}
function verifyCoverage(rows, expected) {
  assert.equal(rows.length, expected.length, 'Every native thinking case must finish');
  assert.ok(rows.every(row => row.ok === true), 'Every native thinking case must pass');
  assert.equal(new Set(rows.map(caseId)).size, rows.length, 'Native thinking cases must not run twice');
  assert.deepEqual(rows.map(caseId).sort(), expected.map(caseId).sort(), 'Native thinking coverage changed');
}

async function runCases(cases, root) {
  const repo = path.resolve(__dirname, '..');
  fs.mkdirSync(root, { recursive: true });
  const manager = createRuntimeManager({ root: repo, node: process.execPath, discoverLocal: false,
    installRoot: process.env.CAMELLIA_RUNTIME_ROOT || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'camellia') });
  for (const engine of new Set(cases.map(row => row.engine)))
    assert.ok(manager.locate(engine, 'api'), `Install ${engine} or set CAMELLIA_RUNTIME_ROOT`);
  const requests = [], rows = [], logs = [];
  let marker, pending;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, 'Bearer local-thinking-fixture');
    requests.push({ model: body.model, marker: JSON.stringify(body.messages || []).includes(marker) ? marker : null,
      reasoning_effort: body.reasoning_effort, thinking: body.thinking });
    const reasoning = body.thinking?.type !== 'disabled' && !['none', 'off'].includes(body.reasoning_effort);
    const response = { id: 'thinking-smoke', model: body.model, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Thinking control passed.', ...(reasoning ? { reasoning_content: 'Local fixture reasoning.' } : {}) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ ...response, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    if (reasoning) res.write(frame({ role: 'assistant', reasoning_content: 'Local fixture reasoning.' }));
    res.write(frame({ content: 'Thinking control passed.' }));
    res.end(frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await listen(server);
  const config = normalizeConfig({ port: await freePort(), providers: profiles.map(profile => ({
    id: profile.model, type: profile.type, protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: profile.model, upstream: profile.model, thinking: { values: profile.values } }],
    keys: [{ key: 'local-thinking-fixture' }],
  })) });
  const configPath = path.join(root, 'routes.json'); writeConfig(configPath, config);
  const router = startApiRouter({ configPath, modelDiscovery: { enabled: false } });
  let host;
  try {
    await router.ready;
    const dataDir = path.join(root, 'app'), cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
    const state = {};
    const env = { ...isolatedEnvironment(path.join(root, 'environment'), process.execPath),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    host = createEngineDrivers({ root: repo, dataDir, runtimeManager: manager, loadConfig: () => state,
      saveConfig: patch => Object.assign(state, patch), isBusy: () => false, router: () => config,
      getRoute: () => ({ baseUrl: router.url, authToken: 'proxy-managed' }), environment: () => env,
      log(message) { logs.push(String(message).slice(-2000)); if (logs.length > 20) logs.shift(); },
      onEvent(engine, event) {
        if (!pending || pending.engine !== engine) return;
        if (event.type === 'stream_event' && event.event?.delta?.thinking) pending.thinking++;
        if (event.type === 'result') pending.resolve(event);
      } });
    for (const { engine, profile, level } of cases) {
        const started = performance.now();
        marker = 'THINKING_SMOKE_' + randomUUID().replaceAll('-', '_');
        const start = requests.length;
        const row = { engine, runtime: manager.locate(engine, 'api').version, model: profile.model, selected: level || 'default' };
        let timer;
        try {
          const done = new Promise(resolve => { pending = { engine, resolve, thinking: 0 }; });
          const settings = { connection: 'api', model: profile.model, permissionMode: 'ask', thinkingBudget: level };
          const session = host.drivers[engine].ensure({ conversationId: randomUUID(), cwd, settings });
          assert.notEqual(session.sendUserMessage(marker + ': Reply briefly. Do not use tools.'), false);
          const result = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(
            `Native turn timed out: ${engine} ${profile.model} ${level || 'Default'}; captured ${requests.length - start} requests\n${logs.slice(-8).join('\n')}`)), 60000); })]);
          assert.equal(Boolean(result.is_error), false, result.result || result.subtype);
          assert.match(String(result.result), /Thinking control passed/);
          const sent = requests.slice(start).filter(request => request.marker === marker);
          assert.ok(sent.length, 'No main inference request captured');
          const boolean = profile.values.length && profile.values.every(value => typeof value === 'boolean');
          for (const request of sent) {
            assert.equal(request.model, profile.model);
            assert.equal(request.reasoning_effort, !level || boolean || profile.type === 'deepseek' && level === 'none' ? undefined : level);
            assert.deepEqual(request.thinking, level && (boolean || profile.type === 'deepseek')
              ? { type: level === 'none' ? 'disabled' : 'enabled' } : undefined);
          }
          Object.assign(row, { ok: true, thinkingDeltas: pending.thinking, sent });
        } catch (error) { Object.assign(row, { ok: false, error: error.stack }); throw error; }
        finally {
          clearTimeout(timer); pending = null;
          row.turnMs = Math.round(performance.now() - started);
          const closing = performance.now();
          try { await host.releaseRuntime(engine); }
          catch (error) { row.ok = false; row.error = error.stack; throw error; }
          finally {
            row.teardownMs = Math.round(performance.now() - closing);
            rows.push(row); fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
          }
        }
        console.log(`PASS ${engine} ${profile.model} ${level || 'Default'}`);
    }
    verifyCoverage(rows, cases);
    console.log(`${rows.length} native thinking-control cases passed. Evidence: ${root}`);
  } finally {
    if (host) await Promise.allSettled(Object.values(host.drivers).map(driver => driver.shutdown?.()));
    await router.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

async function runWorkers(engines, jobs, root, { executable = process.execPath, script = __filename, env = process.env } = {}) {
  const expected = casesFor(engines), groups = partitionCases(expected, jobs);
  const results = await Promise.allSettled(groups.map((_, index) => new Promise((resolve, reject) => {
    const child = spawn(executable, [script, ...engines, '--worker-index', String(index), '--worker-count', String(jobs),
      '--worker-root', path.join(root, 'worker-' + index)], { env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve()
      : reject(new Error(`Thinking worker ${index + 1}/${jobs} failed (${signal || code})`)));
  })));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Native thinking workers failed');
  const rows = groups.flatMap((_, index) => JSON.parse(fs.readFileSync(path.join(root, 'worker-' + index, 'results.json'), 'utf8')));
  verifyCoverage(rows, expected);
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(`PASS: all ${rows.length} native thinking-control cases across ${jobs} isolated workers. Evidence: ${root}`);
}

async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    jobs: { type: 'string', default: '1' }, 'worker-index': { type: 'string' },
    'worker-count': { type: 'string' }, 'worker-root': { type: 'string' },
  } });
  const engines = positionals.length ? positionals : allEngines, cases = casesFor(engines);
  const jobs = Number(values.jobs);
  partitionCases(cases, jobs);
  if (values['worker-index'] !== undefined) {
    const count = Number(values['worker-count']), index = Number(values['worker-index']);
    const groups = partitionCases(cases, count);
    assert.ok(Number.isInteger(index) && index >= 0 && index < count && values['worker-root'], 'Invalid thinking worker');
    return runCases(groups[index], path.resolve(values['worker-root']));
  }
  assert.equal(values['worker-count'], undefined, 'Worker count requires a worker index');
  assert.equal(values['worker-root'], undefined, 'Worker root requires a worker index');
  const root = path.join(__dirname, '..', 'artifacts', 'harness-thinking-smoke-' + randomUUID());
  fs.mkdirSync(root, { recursive: true });
  if (jobs === 1) return runCases(cases, root);
  return runWorkers(engines, jobs, root);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { casesFor, partitionCases, verifyCoverage, runCases, runWorkers };
