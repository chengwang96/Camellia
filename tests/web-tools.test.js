'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { normalizeConfig, publicState, writeConfig, loadConfig } = require('../src/api/api-router-config');
const { createWebTools } = require('../src/api/web-tools');
const { availableProviders } = require('../src/shared/web-tools');
const { validateTool } = require('../src/engines/goal-tools');
const { createGoalToolBridge } = require('../src/engines/goal-tool-bridge');
const { removeTree } = require('./test-fs.cjs');

const provider = (id = 'official', baseUrl = 'https://api.deepseek.com/v1') => ({ id, name: id, baseUrl,
  enabled: true, models: [], keys: [{ id: id + '-key', key: 'private-' + id, enabled: true }] });
const configured = () => normalizeConfig({ providers: [provider()], webTools: { provider: 'deepseek', providerId: 'official' } });
const row = { title: 'Source', url: 'https://example.com/article', summary: 'Grounded facts', content: '# Article', date: '2026-10-20T00:00:00Z' };

test('web settings default to native, survive restart and partial saves, and never publish credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-tools-')); t.after(() => removeTree(root));
  assert.deepEqual(normalizeConfig({}).webTools, { provider: 'native' });
  const selected = configured();
  const partial = normalizeConfig({ providers: publicState(selected).providers }, selected);
  const file = path.join(root, 'routes.json'); writeConfig(file, partial);
  assert.deepEqual(loadConfig(file).webTools, selected.webTools);
  const state = publicState(partial);
  assert.equal(JSON.stringify(state).includes('private-official'), false);
  assert.equal(availableProviders(state)[0].id, 'official');
  for (const webTools of [null, [], {}, { provider: 'other' }, { provider: 'deepseek' }, { provider: 'deepseek', providerId: '__proto__' }])
    assert.throws(() => normalizeConfig({ providers: [], webTools }));
  assert.deepEqual(normalizeConfig({ providers: [], webTools: { provider: 'native' } }, selected).webTools, { provider: 'native' });
});

test('only enabled official HTTPS accounts qualify, including accounts with no model routes', () => {
  const candidates = [provider(), provider('relay', 'https://relay.example/v1'), provider('http', 'http://api.deepseek.com/v1'),
    provider('spoof', 'https://api.deepseek.com.example/v1'), provider('port', 'https://api.deepseek.com:444/v1'),
    provider('password', 'https://user:pass@api.deepseek.com/v1'), provider('path', 'https://api.deepseek.com/proxy'),
    { ...provider('disabled'), enabled: false }, { ...provider('empty'), keys: [] },
    { ...provider('key-disabled'), keys: [{ key: 'secret', enabled: false }] }, provider('custom-official', 'https://api.deepseek.com/anthropic/v1')];
  assert.deepEqual(availableProviders({ providers: candidates }).map(p => p.id), ['official', 'custom-official']);
});

test('search and fetch call the fixed official endpoints with the current selected account key', async () => {
  let config = configured(); const calls = [];
  const service = createWebTools({ getConfig: () => config, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return Response.json(url.endsWith('/search') ? { results: [row] } : { title: row.title, content: row.content });
  } });
  const found = await service.call('camellia_web_search', { query: 'Camellia site:example.com', count: 3 });
  assert.equal(found.results[0].url, row.url); assert.equal(found.results[0].summary, row.summary);
  assert.equal(found.truncated, false);
  assert.deepEqual(calls[0].body, { query: 'Camellia site:example.com', count: 3, need_content: false });
  assert.equal(calls[0].headers.Authorization, 'Bearer private-official');
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].redirect, 'error');
  config.providers[0].keys[0].key = 'rotated-key';
  const page = await service.call('camellia_web_fetch', { url: row.url });
  assert.equal(page.content, row.content); assert.equal(page.url, row.url);
  assert.deepEqual(calls[1].body, { url: row.url });
  assert.equal(calls[1].headers.Authorization, 'Bearer rotated-key');
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(JSON.stringify([found, page]).includes('rotated-key'), false);
  config = normalizeConfig({ providers: [provider('second')], webTools: { provider: 'deepseek', providerId: 'second' } });
  await service.call('camellia_web_search', { query: 'second account' });
  assert.equal(calls[2].headers.Authorization, 'Bearer private-second');
});

test('disabled, removed, empty and relay keys cannot trigger calls or silently use another account', async () => {
  let config = configured(), requests = 0;
  const service = createWebTools({ getConfig: () => config, fetchImpl: async () => { requests++; return Response.json({ results: [] }); } });
  const attempts = [
    () => { config.webTools = { provider: 'native' }; },
    () => { config.providers = [provider('another')]; },
    () => { config.providers[0].enabled = false; },
    () => { config.providers[0].keys[0].enabled = false; },
    () => { config.providers[0].baseUrl = 'https://relay.example/v1'; },
    () => { config.providers[0].keys[0].key = ''; },
  ];
  for (const mutate of attempts) { config = configured(); mutate(); await assert.rejects(service.call('camellia_web_search', { query: 'news' })); }
  assert.equal(requests, 0);
});

test('web arguments are bounded before any paid request and Unicode query lengths match the API', async () => {
  let requests = 0;
  const service = createWebTools({ getConfig: configured, fetchImpl: async () => { requests++; return Response.json({ results: [] }); } });
  for (const args of [{ query: ' ' }, { query: 'x'.repeat(129) }, { query: 'x', count: 0 }, { query: 'x', count: 51 }, { query: 'x', need_content: 'yes' }])
    await assert.rejects(service.call('camellia_web_search', args));
  for (const url of ['file:///secret', 'javascript:alert(1)', 'https://user:secret@example.com/', 'relative', 'https://example.com/' + 'x'.repeat(8192), 'https://example.com/' + '中'.repeat(2000)])
    await assert.rejects(service.call('camellia_web_fetch', { url }));
  assert.equal(requests, 0);
  const args = { query: '🌸'.repeat(128), run_token: 'current' };
  assert.doesNotThrow(() => validateTool('camellia_web_search', args));
  assert.deepEqual((await service.call('camellia_web_search', args)).results, []);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.call('camellia_web_search', { query: 'cancelled' }, { signal: abort.signal }), /cancelled/);
  assert.equal(requests, 1);
});

test('large Markdown and search responses fit the IPC limit without broken Unicode or secret fields', async () => {
  const large = ('🌸\n\u0000"\\').repeat(20000);
  const service = createWebTools({ getConfig: configured, fetchImpl: async url => Response.json(url.endsWith('/fetch')
    ? { title: large, content: large, secret: 'hidden' } : { results: Array.from({ length: 50 }, () => ({ ...row, summary: large.slice(0, 12000), content: large.slice(0, 12000) })) }) });
  for (const [name, args] of [['camellia_web_fetch', { url: row.url }], ['camellia_web_search', { query: 'large', count: 50, need_content: true }]]) {
    const result = await service.call(name, args), json = JSON.stringify(result);
    assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(json) < 100000);
    assert.ok(!json.includes('hidden')); assert.ok(!json.includes('�'));
    assert.doesNotThrow(() => JSON.parse(json));
  }
});

test('Fetch 404 describes an unreadable page and 403 a blocked page, without exposing upstream secrets or retrying', async () => {
  for (const [status, code] of [[404, 'web_page_unavailable'], [403, 'web_fetch_blocked']]) {
    const calls = [];
    const service = createWebTools({ getConfig: configured, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ error: { message: 'private-official: raw provider details', type: 'not_found_error' } }, { status });
    } });
    await assert.rejects(service.call('camellia_web_fetch', { url: row.url }), error => {
      assert.match(error.message, new RegExp('HTTP ' + status));
      assert.doesNotMatch(error.message, /does not offer this endpoint|private-official|raw provider details/);
      assert.equal(error.status, status); assert.equal(error.code, code);
      assert.equal(error.provider, 'deepseek'); assert.equal(error.operation, 'fetch');
      assert.equal(error.url, row.url); assert.equal(error.retryable, false);
      if (status === 404) assert.match(error.message, /could not retrieve readable content/);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/fetch');
  }
});

test('a failed page does not disable Fetch or prevent another page from succeeding', async () => {
  let requests = 0;
  const service = createWebTools({ getConfig: configured, fetchImpl: async (_url, options) => {
    requests++;
    return JSON.parse(options.body).url.includes('/missing') ? new Response('Not found', { status: 404 })
      : Response.json({ title: row.title, content: row.content });
  } });
  await assert.rejects(service.call('camellia_web_fetch', { url: 'https://example.com/missing' }), { code: 'web_page_unavailable' });
  const page = await service.call('camellia_web_fetch', { url: row.url });
  assert.equal(page.ok, true); assert.equal(page.content, row.content); assert.equal(requests, 2);
});

test('DOCX fetch failures identify the attachment and retain safe API response diagnostics', async () => {
  for (const url of ['https://media.springernature.com/files/attachment.docx', 'https://example.com/ATTACHMENT%2eDOCX?download=1']) {
    const service = createWebTools({ getConfig: configured, fetchImpl: async () => new Response('private-official', { status: 404,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-123', server: 'private-official',
        'set-cookie': 'private-cookie', authorization: 'private-official', 'x-private-header': 'private-header-value' } }) });
    await assert.rejects(service.call('camellia_web_fetch', { url }), error => {
      assert.equal(error.status, 404); assert.equal(error.code, 'web_attachment_requires_download');
      assert.equal(error.download_url, url); assert.equal(error.retryable, false);
      assert.equal(error.api_url, 'https://api.deepseek.com/v1/tools/fetch');
      assert.match(error.message, /Word \(DOCX\) attachment/); assert.match(error.message, /Download the attachment/);
      assert.doesNotMatch(error.message, /different page URL|does not offer this endpoint/);
      assert.deepEqual(error.response_headers, { 'content-type': 'application/json', 'x-request-id': 'request-123', server: '[redacted]' });
      const diagnostic = JSON.stringify({ ...error, message: error.message });
      assert.doesNotMatch(diagnostic, /private-official|private-cookie|private-header-value/);
      return true;
    });
  }
});

test('a DOCX-looking URL remains readable when the provider returns valid extracted content', async () => {
  const service = createWebTools({ getConfig: configured, fetchImpl: async () => Response.json({ title: 'Attachment', content: 'Extracted content' }) });
  const result = await service.call('camellia_web_fetch', { url: 'https://example.com/attachment.docx' });
  assert.equal(result.ok, true); assert.equal(result.content, 'Extracted content');
});

test('HTTP diagnostic API URLs distinguish search failures from target-page fetch failures', async () => {
  const service = createWebTools({ getConfig: configured, fetchImpl: async () => new Response('Not found', { status: 404,
    headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(service.call('camellia_web_search', { query: 'news' }), error => {
    assert.equal(error.api_url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(error.operation, 'search'); assert.equal(error.status, 404);
    assert.equal(error.download_url, undefined); assert.equal(error.code, undefined);
    return true;
  });
});

test('HTTP failures, malformed responses, oversized bodies and timeouts report errors without retrying', async () => {
  for (const status of [401, 402, 403, 404, 429, 500]) {
    let calls = 0;
    const service = createWebTools({ getConfig: configured, fetchImpl: async () => { calls++; return new Response('private-api-key', { status }); } });
    await assert.rejects(service.call('camellia_web_search', { query: 'news' }), error => error.message.includes('HTTP ' + status) && !error.message.includes('private-api-key'));
    assert.equal(calls, 1);
  }
  for (const payload of [{}, { results: [{}] }]) {
    const service = createWebTools({ getConfig: configured, fetchImpl: async () => Response.json(payload) });
    await assert.rejects(service.call('camellia_web_search', { query: 'news' }), /invalid search/);
  }
  const oversized = createWebTools({ getConfig: configured, fetchImpl: async () => Response.json({ title: '', content: 'x'.repeat(5 * 1024 * 1024) }) });
  await assert.rejects(oversized.call('camellia_web_fetch', { url: row.url }), /too large/);
  const timeout = createWebTools({ getConfig: configured, fetchImpl: async () => { throw Object.assign(new Error('network details'), { name: 'TimeoutError' }); } });
  await assert.rejects(timeout.call('camellia_web_search', { query: 'news' }), /timed out/);
});

for (const enabled of [false, true]) test('stdio MCP exposes web tools only when selected: ' + enabled, { timeout: 10000 }, async t => {
  const calls = [];
  const service = createWebTools({ getConfig: configured, fetchImpl: async () => Response.json({ results: [row] }) });
  const bridge = await createGoalToolBridge({ node: process.execPath, webTools: enabled,
    call: (name, args, options) => { calls.push(args); return service.call(name, args, options); } });
  const child = spawn(bridge.config.command, bridge.config.args, { env: { ...process.env, ...bridge.config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  t.after(async () => { child.kill(); lines.close(); await bridge.close(); });
  const request = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await request('initialize', { protocolVersion: '2025-06-18' });
  const catalog = (await request('tools/list')).result.tools;
  assert.equal(catalog.filter(tool => tool.name.startsWith('camellia_web_')).length, enabled ? 2 : 0);
  assert.equal(catalog.some(tool => tool.name === 'camellia_get_goal'), true);
  const result = (await request('tools/call', { name: 'camellia_web_search', arguments: { query: 'test', run_token: 'current' } })).result;
  assert.equal(result.isError, !enabled);
  assert.equal(calls.length, enabled ? 1 : 0);
  if (enabled) assert.equal(JSON.parse(result.content[0].text).results[0].url, row.url);
  assert.equal(JSON.stringify(bridge.config).includes('private-official'), false);
});
