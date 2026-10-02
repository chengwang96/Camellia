'use strict';

// The installed runtime talks only to a local model fixture. This observes the
// actual tool surface; it is not evidence of a working ChatGPT subscription.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { CodexClient } = require('../src/engines/codex-client');
const { isolatedEnvironment } = require('../src/benchmark/engines');
const { createRuntimeManager } = require('../src/main/runtime-manager');
const { codexTextSpec } = require('../src/engines/discussions/codex-text-policy');
const assert = require('node:assert/strict');

async function main() {
  const runtime = createRuntimeManager({ root: path.resolve(__dirname, '..'), installRoot: path.resolve(__dirname, '..') }).locate('codex');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-discussion-codex-'));
  const home = path.join(root, 'codex'), cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const requests = [], logs = []; let client, resolveTurn, rejectTurn;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const forced = requests.length === 1 && process.argv.includes('--force-tool');
      const item = forced ? { id: 'tool_fixture', type: 'custom_tool_call', call_id: 'call_fixture', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: forbidden.txt\n+must-not-exist\n*** End Patch' }
        : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Text-only fixture reply', annotations: [] }] };
      const response = { id: 'resp_fixture', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const value of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], content: [] } },
        ...(forced ? [] : [{ type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'Text-only fixture reply' }]),
        { type: 'response.output_item.done', output_index: 0, item: response.output[0] }, { type: 'response.completed', response }]) res.write('data: ' + JSON.stringify(value) + '\n\n');
      res.end();
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = isolatedEnvironment(path.join(root, 'profile'), process.execPath);
    const spec = codexTextSpec({ runtime, home, cwd, model: 'gpt-6-astra', connection: 'api', inherited: env, route: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
    client = new CodexClient({ ...spec, log: line => logs.push(line),
      onNotification(method, value) { if (method === 'turn/completed') value.turn.status === 'completed' ? resolveTurn(value) : rejectTurn(new Error(JSON.stringify(value.turn.error))); },
      onClose(error) { rejectTurn?.(error); } });
    await client.ready;
    const thread = await client.request('thread/start', { cwd, model: 'gpt-6-astra', modelProvider: 'camellia', approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'You are a text discussion participant.' });
    const done = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    const timer = setTimeout(() => rejectTurn(new Error('Turn timeout')), 30000);
    try { await client.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Hello' }] }); await done; }
    finally { clearTimeout(timer); }
    assert.ok(requests.length); assert.ok(requests.every(request => !request.tools?.length), 'Production policy must expose no tools');
    assert.equal(fs.existsSync(path.join(cwd, 'forbidden.txt')), false, 'Unadvertised patch calls must not execute');
    if (process.argv.includes('--force-tool')) assert.match(JSON.stringify(requests.slice(1)), /unsupported|unknown|unrecognized/i);
    console.log(JSON.stringify({ root, requests: requests.length, tools: requests.map(r => r.tools), logs: logs.slice(-4) }, null, 2));
  } finally { await client?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
