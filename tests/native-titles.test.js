'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const TOML = require('smol-toml');
const { CodexTitles, codexTitleSpec } = require('../src/engines/codex-title');
const { GrokSession } = require('../src/engines/grok-session');
const { InteractiveCli } = require('../src/engines/antigravity/cli-interactive.cjs');
const { AntigravitySession } = require('../src/engines/antigravity');
const { removeTree } = require('./test-fs.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camellia-native-title-test-'));
  t.after(() => removeTree(root)); return root;
}

function codexFixture(t, { complete = true, timeoutMs = 2000 } = {}) {
  const root = temporary(t), messages = [];
  fs.writeFileSync(path.join(root, 'config.toml'), '');
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const send = message => proc.stdout.write(JSON.stringify(message) + '\n');
  let buffer = '';
  proc.stdin.on('data', data => {
    buffer += data;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); messages.push(message);
      if (!message.id) continue;
      if (message.method === 'turn/start' && complete) {
        send({ method: 'item/completed', params: { threadId: 'unrelated-main-thread', item: { type: 'agentMessage', id: 'other', text: 'Wrong title' } } });
        send({ method: 'item/completed', params: { threadId: 'title-thread', item: { type: 'agentMessage', id: 'answer', text: '{"title":"原生订阅标题"}' } } });
        send({ method: 'turn/completed', params: { threadId: 'title-thread', turn: { id: 'title-turn', status: 'completed' } } });
      }
      send({ id: message.id, result: message.method === 'thread/start' ? { thread: { id: 'title-thread' } }
        : message.method === 'turn/start' ? { turn: { id: 'title-turn' } } : {} });
    }
  });
  proc.stdin.once('finish', () => { proc.exitCode = 0; proc.stdout.end(); proc.stderr.end(); proc.emit('close', 0); });
  const titles = new CodexTitles({ spec: { exe: 'fixture', env: { ...process.env, CODEX_HOME: root } }, model: 'gpt-6-astra',
    spawnProcess: () => proc, timeoutMs });
  t.after(() => titles.close(new Error('Test ended')));
  return { root, titles, messages, proc };
}

test('Codex title uses its owner account without rewriting native config or inheriting API credentials', t => {
  const root = temporary(t), source = path.join(root, 'account'), output = path.join(root, 'title'); fs.mkdirSync(source);
  const native = 'developer_instructions = "native"\n[mcp_servers."server.with.dots"]\ncommand = "node"\n';
  fs.writeFileSync(path.join(source, 'config.toml'), native);
  const launch = codexTitleSpec({ spec: { exe: 'codex', env: { ...process.env, CODEX_HOME: source,
    OPENAI_API_KEY: 'must-not-inherit', CAMELLIA_NETWORK_MODE: 'proxy', HTTPS_PROXY: 'http://127.0.0.1:7890' } }, root: output, model: 'gpt-6-astra' });
  assert.equal(launch.env.CODEX_HOME, source);
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  assert.equal(fs.readFileSync(path.join(source, 'config.toml'), 'utf8'), native);
  const mcpArg = launch.args.find(value => value.startsWith('mcp_servers='));
  assert.equal(TOML.parse(mcpArg).mcp_servers['server.with.dots'].enabled, false);
  const catalog = JSON.parse(fs.readFileSync(launch.titleConfig.model_catalog_json));
  assert.ok(catalog.models.every(model => !model.multi_agent_version && !model.apply_patch_tool_type && !model.experimental_supported_tools.length));
});

test('Codex deduplicates auxiliary title requests, handles early completion, and never uses a main-thread reply', async t => {
  const { titles, messages, proc } = codexFixture(t);
  const first = titles.generate('用户请求');
  assert.equal(titles.generate('用户请求'), first);
  assert.equal(await first, '原生订阅标题');
  const start = messages.find(message => message.method === 'thread/start');
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.modelProvider, 'openai');
  assert.equal(start.params.allowProviderModelFallback, false);
  assert.equal(start.params.sandbox, 'read-only');
  assert.equal(messages.find(message => message.method === 'turn/start').params.threadId, 'title-thread');
  assert.equal(proc.exitCode, 0);
  assert.equal(fs.existsSync(start.params.cwd), false, 'Remove the private title workspace');
});

test('a stalled Codex title request times out and closes its private process', async t => {
  const { titles, proc } = codexFixture(t, { complete: false, timeoutMs: 25 });
  await assert.rejects(titles.generate('标题'), /timed out/);
  assert.equal(proc.exitCode, 0);
});

test('closing the owner session cancels pending Codex title work', async t => {
  const { titles, messages, proc } = codexFixture(t, { complete: false });
  const pending = titles.generate('标题');
  const rejected = assert.rejects(pending, /Owner signed out/);
  while (!messages.some(message => message.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
  await titles.close(new Error('Owner signed out'));
  await rejected;
  assert.equal(proc.exitCode, 0);
});

test('Grok waits for its own native generated title and ignores previews, other sessions and manual titles', async t => {
  const home = temporary(t), sessionId = '00000000-0000-4000-8000-000000000001';
  const session = Object.assign(Object.create(GrokSession.prototype), { spec: { env: { GROK_HOME: home } }, sessionId });
  const dir = path.join(home, 'sessions', 'workspace', sessionId); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');
  const file = path.join(dir, 'summary.json');
  fs.writeFileSync(file, JSON.stringify({ session_summary: 'Provisional user message' }));
  let waits = 0;
  assert.equal(await session.generateTitle('', { attempts: 2, delay: async () => {
    waits++; fs.writeFileSync(file, JSON.stringify({ generated_title: 'Grok 模型标题', title_is_manual: false }));
  } }), 'Grok 模型标题');
  assert.equal(waits, 1);
  fs.writeFileSync(file, JSON.stringify({ generated_title: 'Manual name', title_is_manual: true }));
  assert.equal(await session.generateTitle('', { attempts: 1 }), '');
  session.sessionId = '00000000-0000-4000-8000-000000000002';
  assert.equal(await session.generateTitle('', { attempts: 1 }), '');
});

test('Antigravity title reads only the root native summary and waits past the startup placeholder', async () => {
  const bridge = new InteractiveCli({}, () => {}); bridge.session = { id: 'agy-test', conversationId: 'root' };
  let reads = 0;
  bridge.rpc = async method => {
    assert.equal(method, 'GetAllCascadeTrajectories'); reads++;
    return { trajectorySummaries: { root: { summary: reads === 1 ? 'Starting a Conversation' : 'Google 原生标题' }, child: { summary: 'Wrong child title' } } };
  };
  assert.deepEqual(await bridge.generateTitle({ attempts: 2, delayTitle: async () => {} }), { title: 'Google 原生标题' });
  assert.equal(reads, 2);
  bridge.turn = { running: true };
  assert.deepEqual(await bridge.generateTitle(), { title: 'Google 原生标题' }, 'Metadata remains available if the user has already started the next turn');
  await assert.rejects(bridge.handle('session/camellia_generate_title', { sessionId: 'different-session' }), /identity mismatch/);
  bridge.closed = true;
  assert.deepEqual(await bridge.generateTitle(), { title: '' });
});

test('Antigravity subscription title requests use ACP without appending a user turn', async () => {
  const session = Object.assign(Object.create(AntigravitySession.prototype), { settings: { connection: 'subscription' }, sessionId: 'agy-test' });
  const calls = [];
  session.request = async (method, params) => { calls.push({ method, params }); return { title: '原生标题' }; };
  assert.equal(await session.generateTitle(), '原生标题');
  assert.deepEqual(calls, [{ method: 'session/camellia_generate_title', params: { sessionId: 'agy-test' } }]);
  session.dead = true; assert.equal(await session.generateTitle(), '');
});
