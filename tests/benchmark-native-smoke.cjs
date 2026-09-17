'use strict';

// Exercise each installed, real harness with a loopback model fixture. This
// validates integration, not model quality, and never uses paid credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { ENGINES, runEngine, isolatedEnvironment } = require('../src/benchmark/engines');
const { TASKS, prepareTask, verifyTask } = require('../src/benchmark/tasks');
const { createLibraryManager } = require('../src/benchmark/libraries');
const { verifyPythonTask } = require('../src/benchmark/python-verifier');

async function main() {
  const appRoot = path.resolve(__dirname, '..');
  const runtimes = createRuntimeManager({ root: appRoot, installRoot: appRoot, node: () => process.execPath });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-bench-native-'));
  const scientific = process.argv.includes('--science');
  const library = scientific ? createLibraryManager({ directory: path.join(process.env.APPDATA || path.join(os.homedir(), 'Library/Application Support'), 'dsh-desktop/benchmark-libraries') }) : null;
  const task = scientific ? library.resolve('ds1000-quick').tasks.find(t => t.category === 'Numpy') : TASKS.find(t => t.id === 'reconcile');
  let router;
  const contexts = new Map(), arrived = new Set(), allStarted = Promise.withResolvers(), stopAll = new AbortController();
  const diagnostics = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const engine = ENGINES.find(id => JSON.stringify(body).includes('BENCH_FIXTURE_' + id + '_'));
      const current = contexts.get(engine);
      assert.ok(current, 'Request must identify its isolated engine fixture');
      assert.equal(body.model, 'fixture-upstream');
      assert.equal(req.headers.authorization, 'Bearer loopback-only');
      const record = { engine: current.engine, url: req.url, body }; diagnostics.push(record);
      if (current.waiting) { current.onRequest(res); return; }
      // Hold the first response until every native runtime has a concurrent
      // request against the same provider. A serial runner cannot pass this.
      arrived.add(engine);
      if (arrived.size === ENGINES.length) allStarted.resolve();
      await allStarted.promise;
      const lastUser = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('BENCH_SMOKE'));
      const hasTool = lastUser >= 0 && body.messages.slice(lastUser).some(m => m.role === 'tool');
      let tool;
      if (lastUser >= 0 && (!hasTool || (scientific && engine === 'dsh' && !current.written)) && body.tools?.length) {
        const tools = body.tools?.map(t => t.function) || [];
        const readFirst = scientific && engine === 'dsh' && !current.read;
        const declared = tools.find(t => readFirst ? /^read$/i.test(t.name) : current.engine === 'codex' ? /shell_command$|exec_command$/.test(t.name)
          : /^write$/i.test(t.name) || /write_to_file$|^write_file$|^file_write$/.test(t.name));
        assert.ok(declared, 'Missing native write tool: ' + JSON.stringify(tools));
        const properties = declared.parameters.properties;
        const target = path.join(current.cwd, scientific ? 'solution.py' : task.output);
        const content = scientific ? task.record.reference_code : JSON.stringify([{ customer: 'Amy', count: 2, cents: 200 }, { customer: 'Zoe', count: 2, cents: 700 }]);
        const command = process.platform === 'win32' ? "New-Item -ItemType Directory -Force -Path '" + path.dirname(target).replace(/'/g, "''") + "' | Out-Null\nSet-Content " + (scientific ? '-Encoding utf8 ' : '') + "-LiteralPath '" + target.replace(/'/g, "''") + "' -Value '" + content.replace(/'/g, "''") + "'"
          : "mkdir -p '" + path.dirname(target).replace(/'/g, "'\\''") + "'\nprintf '%s\\n' '" + content.replace(/'/g, "'\\''") + "' > '" + target.replace(/'/g, "'\\''") + "'";
        const args = readFirst ? { [properties.file_path ? 'file_path' : 'path']: target }
          : current.engine === 'codex' ? { [properties.cmd ? 'cmd' : 'command']: command, login: false }
          : properties.TargetFile ? { TargetFile: target, CodeContent: content, Overwrite: scientific, Description: 'Write the fixture solution', toolAction: 'Writing solution', toolSummary: 'Save the solution' }
          : properties.file_path ? { file_path: target, content } : { path: target, content };
        tool = { id: 'fixture-' + diagnostics.length, type: 'function', function: { name: declared.name, arguments: JSON.stringify(args) } };
        if (readFirst) current.read = true; else current.written = true;
      }
      const message = { role: 'assistant', content: tool ? null : 'Completed the fixture task.', ...(tool ? { tool_calls: [tool] } : {}) };
      const inputTokens = 50 * (ENGINES.indexOf(engine) + 1);
      const usage = { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: { ...message, reasoning_content: 'Check the fixture.', ...(tool ? { tool_calls: [{ ...tool, index: 0 }] } : {}) } }] }));
        res.write(frame({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }));
        res.end(frame('[DONE]'));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }));
      }
    } catch (error) {
      diagnostics.push({ error: error.message });
      res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const file = path.join(root, 'router.json');
  writeConfig(file, normalizeConfig({ port, providers: [{ id: 'fixture', name: 'Loopback fixture', type: 'custom',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', protocol: 'openai', enabled: true,
    models: [{ id: 'bench-model', upstream: 'fixture-upstream' }], keys: [{ id: 'fixture-key', key: 'loopback-only', enabled: true }] }] }));
  try {
    router = startApiRouter({ configPath: file, timeoutMs: 30000 }); await router.ready;
    const results = await Promise.allSettled(ENGINES.map(async engine => {
      const runtime = runtimes.locate(engine, 'api');
      assert.ok(runtime, `Run npm run setup:${engine} first`);
      const cwd = path.join(root, engine, 'Project With Spaces'), home = path.join(root, engine, 'profile');
      prepareTask(task, cwd); contexts.set(engine, { engine, cwd });
      const usage = [], events = [];
      const control = new AbortController(), timer = setTimeout(() => control.abort('Native smoke timed out'), 60000);
      const route = router.createScope({ model: 'bench-model', providerId: 'fixture', onUsage: record => usage.push(record) });
      console.log('Running ' + engine);
      let result;
      try {
        result = await runEngine({ engine, runtime, node: process.execPath, cwd, home, model: 'bench-model', route,
          python: scientific ? library.locate('ds1000').python : undefined,
          prompt: 'BENCH_FIXTURE_' + engine + '_ BENCH_SMOKE: Read TASK.md and complete its task in ' + cwd,
          signal: AbortSignal.any([control.signal, stopAll.signal]), onEvent: event => events.push(event) });
      } finally { clearTimeout(timer); await route.close(); }
      const verdict = scientific ? await verifyPythonTask(task, cwd, library.locate('ds1000'), isolatedEnvironment(home, process.execPath), stopAll.signal)
        : await verifyTask(task, cwd, process.execPath, isolatedEnvironment(home, process.execPath));
      diagnostics.push({ engine, result, verdict, usage, events });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(verdict.passed, true, engine + ': ' + JSON.stringify({ verdict, result, requests: diagnostics.filter(d => d.error || d.engine === engine).slice(-3) }));
      assert.ok(usage.length >= 2 && usage.every(r => r.tokens.input === 50 * (ENGINES.indexOf(engine) + 1) && r.tokens.output === 10));
      console.log('PASS ' + engine + ': native tool write, independent grader, scoped model and token usage');

      // A stopped native process must not keep its upstream request alive.
      let reached;
      const entered = new Promise(resolve => { reached = resolve; });
      contexts.set(engine, { engine, cwd, waiting: true, onRequest: reached });
      const cancel = new AbortController();
      const stopRoute = router.createScope({ model: 'bench-model', providerId: 'fixture' });
      const deadline = setTimeout(() => cancel.abort('Cancellation fixture timed out'), 30000);
      try {
        const pending = runEngine({ engine, runtime, node: process.execPath, cwd, home: home + '-cancel', model: 'bench-model', route: stopRoute,
          prompt: 'BENCH_FIXTURE_' + engine + '_ BENCH_WAIT: Wait for a response from the local fixture.',
          signal: AbortSignal.any([cancel.signal, stopAll.signal]) });
        const upstream = await Promise.race([entered, pending.then(result => { throw new Error('Engine ended before its cancellation request: ' + JSON.stringify(result)); })]);
        const closed = once(upstream, 'close'); cancel.abort('User stopped the benchmark');
        const cancelled = await pending; await stopRoute.close(); await closed;
        assert.equal(cancelled.cancelled, true);
        assert.equal(stopRoute.scope.closed, true);
        console.log('PASS ' + engine + ': cancellation closes the native process and upstream request');
      } finally { clearTimeout(deadline); await stopRoute.close(); }
    }).map(pending => pending.catch(error => { stopAll.abort('Parallel smoke failed'); allStarted.resolve(); throw error; })));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    assert.equal(arrived.size, ENGINES.length);
    assert.equal(router.getState().activeRequests, 0);
    console.log('PASS: all five native engines overlapped on one provider with isolated usage and cancellation');
  } finally {
    await router?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const artifact = path.join(appRoot, 'dist', 'benchmark-native-smoke.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(diagnostics, null, 2));
    console.log('Diagnostics: ' + artifact);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('camellia-bench-native-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
