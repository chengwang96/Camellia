'use strict';

// Real production drivers and native runtimes; every inference response is
// loopback-only. Profiles and sanitized captures stay in ignored artifacts/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createEngineDrivers } = require('../src/cli/engine-drivers');
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

async function main() {
  const all = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok'];
  const engines = process.argv.slice(2).length ? process.argv.slice(2) : all;
  assert.ok(engines.every(engine => all.includes(engine)), 'Specify harness IDs');
  const repo = path.resolve(__dirname, '..');
  const root = path.join(repo, 'artifacts', 'harness-thinking-smoke-' + randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const manager = createRuntimeManager({ root: repo, node: process.execPath, discoverLocal: false,
    installRoot: process.env.CAMELLIA_RUNTIME_ROOT || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'camellia') });
  for (const engine of engines) assert.ok(manager.locate(engine, 'api'), `Install ${engine} or set CAMELLIA_RUNTIME_ROOT`);
  const requests = [], rows = [];
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
      onEvent(engine, event) {
        if (!pending || pending.engine !== engine) return;
        if (event.type === 'stream_event' && event.event?.delta?.thinking) pending.thinking++;
        if (event.type === 'result') pending.resolve(event);
      } });
    for (const engine of engines) for (const profile of profiles) {
      const levels = ['', ...profile.values.map(value => value === false ? 'none' : value === true ? 'high' : value)];
      for (const level of levels) {
        marker = 'THINKING_SMOKE_' + randomUUID().replaceAll('-', '_');
        const start = requests.length;
        const row = { engine, runtime: manager.locate(engine, 'api').version, model: profile.model, selected: level || 'default' };
        let timer;
        try {
          const done = new Promise(resolve => { pending = { engine, resolve, thinking: 0 }; });
          const settings = { connection: 'api', model: profile.model, permissionMode: 'ask', thinkingBudget: level };
          const session = host.drivers[engine].ensure({ conversationId: randomUUID(), cwd, settings });
          assert.notEqual(session.sendUserMessage(marker + ': Reply briefly. Do not use tools.'), false);
          const result = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native turn timed out')), 60000); })]);
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
          rows.push(row); fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
          await host.releaseRuntime(engine);
        }
        console.log(`PASS ${engine} ${profile.model} ${level || 'Default'}`);
      }
    }
    console.log(`${rows.length} native thinking-control cases passed. Evidence: ${root}`);
  } finally {
    if (host) await Promise.allSettled(Object.values(host.drivers).map(driver => driver.shutdown?.()));
    await router.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
