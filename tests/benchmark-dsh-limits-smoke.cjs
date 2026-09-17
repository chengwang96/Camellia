'use strict';
// Real DSH, loopback responses: reproduce the former 8K cutoff and verify the
// native 32K default and structured finish diagnostics without paid API calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const YAML = require('yaml');
const { startApiRouter } = require('../src/api/api-router');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');
const { frame } = require('../src/api/api-protocol');
const { dshSpec, runEngine, isolatedEnvironment, stopProcess } = require('../src/benchmark/engines');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-dsh-output-'));
  const runtime = { file: path.resolve(__dirname, '../runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js') };
  let router, forceLimit = false;
  const caps = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const agentRequest = Boolean(body.tools?.length);
    if (agentRequest) caps.push(body.max_tokens);
    const limited = agentRequest && (forceLimit || body.max_tokens < 16384);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Fixture reasoning.' } }] }));
    if (!limited) res.write(frame({ choices: [{ index: 0, delta: { content: 'Completed.' } }] }));
    res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: limited ? 'length' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: limited ? body.max_tokens : 20 } }));
    res.end(frame('[DONE]'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  try {
    const file = path.join(root, 'router.json');
    writeConfig(file, normalizeConfig({ port, providers: [{ id: 'local', name: 'Fixture', type: 'custom', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', upstream: 'fixture' }], keys: [{ id: 'local-key', key: 'local-only' }] }] }));
    router = startApiRouter({ configPath: file, timeoutMs: 5000 }); await router.ready;
    for (const mode of ['legacy', 'fixed', 'truncated']) {
      const home = path.join(root, mode, 'profile'), cwd = path.join(root, mode, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
      const usage = [], route = router.createScope({ model: 'fixture', providerId: 'local', onUsage: record => usage.push(record) });
      forceLimit = mode === 'truncated';
      const control = new AbortController(), timer = setTimeout(() => control.abort('Fixture timeout'), 20000);
      try {
        let result;
        if (mode === 'legacy') {
          const spec = dshSpec({ runtime, home, cwd, model: 'fixture', route, env: isolatedEnvironment(home, process.execPath) });
          const configFile = path.join(home, '.dsh/settings.yaml'), config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
          config['llm-pi-ai'].providers['api-pool'].defaultMaxTokens = 8192;
          fs.writeFileSync(configFile, YAML.stringify(config));
          const proc = spawn(process.execPath, [...spec.args, 'Reply briefly.'], { cwd, env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = ''; proc.stdout.resume(); proc.stderr.on('data', data => { stderr += data; });
          const abort = () => { void stopProcess(proc); }; control.signal.addEventListener('abort', abort, { once: true });
          const [code] = await once(proc, 'close'); control.signal.removeEventListener('abort', abort);
          assert.equal(code, 1); assert.match(stderr, /Fixture reasoning/);
          assert.doesNotMatch(stderr, /dsh: [A-Z][A-Z_]+:/, 'Headless emits no error reason for a max-token stop');
          result = { ok: code === 0 };
        } else result = await runEngine({ engine: 'dsh', runtime, node: process.execPath, cwd, home, model: 'fixture', route,
          prompt: 'Reply briefly.', signal: control.signal });
        await route.close(); assert.ok(usage.length >= 1);
        assert.equal(caps.at(-1), mode === 'legacy' ? 8192 : 32768);
        assert.equal(result.ok, mode === 'fixed');
        const taskRequest = usage.findLast(record => record.hasTools);
        assert.equal(taskRequest.finishReason, mode === 'fixed' ? 'stop' : 'length', JSON.stringify(usage));
        if (mode === 'truncated') { assert.equal(result.exitCode, 1); assert.doesNotMatch(result.error, /Fixture reasoning/); }
        console.log(`PASS ${mode}: max_tokens=${caps.at(-1)}, finish=${taskRequest.finishReason}, completed=${result.ok}, requests=${usage.length}`);
      } finally { clearTimeout(timer); await route.close(); }
    }
  } finally {
    await router?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('bench-dsh-output-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
