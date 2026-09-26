'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createHeadlessHost } = require('../src/cli/host');
const { normalizeConfig, writeConfig } = require('../src/api/api-router-config');

async function main() {
  if (process.platform !== 'linux') throw new Error('Run the real server native smoke on Linux');
  const root = path.resolve(process.argv[2]);
  const engines = process.argv.slice(3);
  if (!engines.length || engines.some(engine => !['dsh', 'kimi', 'codex', 'claude', 'antigravity'].includes(engine))) throw new Error('Specify installed engine IDs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-native-'));
  assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
  const requests = [];
  const backend = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks)); requests.push(payload);
    assert.equal(request.headers.authorization, 'Bearer fixture-only');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Server native fixture passed.' } }] },
      { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  writeConfig(path.join(dataDir, 'api-routes.json'), normalizeConfig({ port, providers: [{ id: 'fixture', type: 'custom', baseUrl: `http://127.0.0.1:${backend.address().port}/v1`, protocol: 'openai',
    models: [{ id: 'fixture-model', upstream: 'fixture-model', contextWindow: 131072 }], keys: [{ id: 'fixture-key', key: 'fixture-only' }] }] }));
  let target, transport;
  const network = { snapshot: { state: 'Stopped' }, async start() { this.snapshot = { state: 'Running', address: '100.80.1.2' }; },
    async status() { return this.snapshot; }, async listen(url, token) { target = url; transport = token; }, async stop() { this.snapshot = { state: 'Stopped' }; } };
  const host = createHeadlessHost({ dataDir, root, networkFactory: () => network });
  const request = (endpoint, payload, bearer) => new Promise((resolve, reject) => {
    const operation = http.request(target + endpoint, { method: payload ? 'POST' : 'GET', headers: { host: '100.80.1.2:43127', 'x-camellia-transport': transport,
      'x-camellia-peer': '100.90.1.2', ...(payload ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) } }, response => {
      let output = ''; response.on('data', chunk => { output += chunk; }); response.on('end', () => {
        try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
      });
    });
    operation.on('error', reject); operation.setTimeout(20000, () => operation.destroy(new Error('Fixture request timed out')));
    operation.end(payload ? JSON.stringify(payload) : undefined);
  });
  try {
    assert.equal((await host.command('start')).ok, true);
    const invitation = (await host.command('invite')).result;
    const pending = await request('/v1/pair/request', { code: invitation.code, name: 'Fixture GUI' });
    assert.equal((await host.command('approve', { id: pending.id })).ok, true);
    const credential = await request('/v1/pair/claim', pending);
    const state = await request('/v1/status', null, credential.token);
    for (const engine of engines) {
      console.log('Testing real headless ' + engine);
      const selected = await host.command('engine-settings', { engine, connection: 'api', model: 'fixture-model' });
      assert.equal(selected.ok, true, selected.error);
      const native = await request(`/v1/native-settings/${engine}`, null, credential.token);
      const nativeText = { claude: '{"language":"English"}', codex: 'web_search="disabled"', kimi: 'telemetry=false', dsh: 'camellia-fixture-option: true', antigravity: '{"instructions":"Reply briefly."}' }[engine];
      assert.equal((await request(`/v1/native-settings/${engine}`, { engine, id: 'settings', text: nativeText, revision: native.files[0].revision, confirmed: true }, credential.token)).ok, true);
      const created = await host.command('create-conversation', { engine }); assert.equal(created.ok, true, created.error);
      const id = created.result.id;
      const send = await request(`/v1/conversations/${id}/commands`, { action: 'send', prompt: 'Reply with a short plain text answer. Do not use tools.', expectedSeq: 0,
        attachments: [{ name: 'fixture-notes.txt', data: Buffer.from('Server attachment fixture.').toString('base64'), isImage: false }],
        requestId: randomUUID(), instanceId: state.instanceId }, credential.token);
      assert.ok(send.ok || send.state === 'pending', JSON.stringify(send));
      const deadline = Date.now() + 90000;
      let snapshot;
      do {
        await new Promise(resolve => setTimeout(resolve, 250));
        snapshot = await request(`/v1/conversations/${id}`, null, credential.token);
        if (!snapshot.live && !snapshot.conversation.activity) break;
      } while (Date.now() < deadline);
      assert.ok(!snapshot.live && !snapshot.conversation.activity, engine + ' did not finish');
      assert.match(JSON.stringify(snapshot.messages), /Server native fixture passed/, engine + ': ' + JSON.stringify(snapshot.messages));
      const changed = await request(`/v1/native-settings/${engine}`, null, credential.token);
      const nextText = { claude: '{"language":"English","outputStyle":"default"}', codex: 'web_search="disabled"\nmodel_reasoning_effort="low"', kimi: 'telemetry=false\n[loop_control]\nmax_attempts_per_step=5', dsh: 'camellia-fixture-option: false', antigravity: '{"instructions":"Continue replying briefly."}' }[engine];
      assert.equal((await request(`/v1/native-settings/${engine}`, { engine, id: 'settings', text: nextText, revision: changed.files[0].revision, confirmed: true }, credential.token)).ok, true);
      const second = await request(`/v1/conversations/${id}/commands`, { action: 'send', prompt: 'Continue with a short reply. Do not use tools.', expectedSeq: snapshot.conversation.seq,
        requestId: randomUUID(), instanceId: state.instanceId }, credential.token);
      assert.ok(second.ok || second.state === 'pending', JSON.stringify(second));
      const secondDeadline = Date.now() + 90000;
      do {
        await new Promise(resolve => setTimeout(resolve, 250));
        snapshot = await request(`/v1/conversations/${id}`, null, credential.token);
        if (!snapshot.live && !snapshot.conversation.activity) break;
      } while (Date.now() < secondDeadline);
      assert.ok(!snapshot.live && !snapshot.conversation.activity, engine + ' did not finish after native config change');
      assert.match(snapshot.messages.at(-1)?.text || '', /Server native fixture passed/, engine + ': ' + JSON.stringify(snapshot.messages));
      console.log('PASS headless ' + engine + ': paired remote send, real native process, server history');
    }
    assert.ok(requests.length >= engines.length);
    assert.ok(requests.every(request => JSON.stringify(request).includes('fixture-notes.txt')), 'Native requests must see attachment references');
  } finally {
    await host.close();
    await new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
