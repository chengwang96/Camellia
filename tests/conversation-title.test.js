'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createConversationTitles, createTitleRequester, titleCandidates, titleErrorKind, TitleRequestError,
  MAX_TITLE_MODELS, MAX_OUTPUT_TOKENS, MAX_MESSAGE_CHARS, AUXILIARY_HEADER } = require('../src/main/conversation-title');
const { shortTitle, messageTitle } = require('../src/shared/conversation-title');

const router = (providers, enabled = true) => ({ enabled, providers });
const provider = (id, models, { enabled = true, keys = [{ id: 'k', enabled: true }] } = {}) => ({ id, enabled, keys, models: models.map(model => ({ id: model })) });

test('candidate models put the conversation model first and only keep routable ones', () => {
  const cfg = router([provider('p', ['a', 'b', 'c', 'd'])]);
  assert.deepEqual(titleCandidates('c', { fallback: 'a', router: cfg }), ['c', 'a', 'b']);
  // A model with no enabled route is skipped instead of costing an attempt.
  assert.deepEqual(titleCandidates('gone', { fallback: 'b', router: cfg }), ['b', 'a', 'c']);
  assert.deepEqual(titleCandidates('b', { router: router([provider('p', ['a'], { enabled: false })]) }), []);
  assert.deepEqual(titleCandidates('b', { router: router([provider('p', ['a'], { keys: [{ id: 'k', enabled: false }] })]) }), []);
  assert.deepEqual(titleCandidates('b', { router: router([], false) }), []);
  assert.ok(titleCandidates('a', { router: router([provider('p', ['a', 'b', 'c', 'd', 'e'])]) }).length <= MAX_TITLE_MODELS);
});

test('fallback candidates cover different providers before more models in the same pool', () => {
  const cfg = router([provider('pool', ['a', 'b', 'c', 'd']), provider('other', ['e', 'f']), provider('third', ['g'])]);
  assert.deepEqual(titleCandidates('a', { fallback: 'b', router: cfg }), ['a', 'e', 'g']);
  assert.deepEqual(titleCandidates('a', { fallback: 'f', router: cfg }), ['a', 'f', 'g']);
});

test('live quota, key blocks and per-model cooldowns exclude unavailable routes', () => {
  const cfg = router([
    provider('spent', ['a', 'b'], { keys: [{ id: 'spent', enabled: true }] }),
    provider('paused', ['c'], { keys: [{ id: 'paused', enabled: true }] }),
    provider('cooling', ['d', 'e'], { keys: [{ id: 'cooling', enabled: true }] }),
    provider('ready', ['f'], { keys: [{ id: 'ready', enabled: true }] }),
  ]);
  const state = { running: true, quota: { spent: { exhausted: true } },
    usage: { paused: { blocked: true }, cooling: { models: { d: { until: 101 } } } } };
  assert.deepEqual(titleCandidates('a', { fallback: 'd', router: cfg, state, now: 100 }), ['e', 'f']);
  assert.deepEqual(titleCandidates('d', { router: cfg, state, now: 101 }), ['d', 'f', 'e']);
  assert.deepEqual(titleCandidates('f', { router: cfg, state: { running: false } }), []);
  // A model is still usable when a second provider has a healthy key.
  cfg.providers.push(provider('alternate', ['a'], { keys: [{ id: 'alternate', enabled: true }] }));
  assert.deepEqual(titleCandidates('a', { router: cfg, state, now: 100 }), ['a', 'e', 'f']);
});

test('a quota failure in a large pool still reaches a healthy later provider', async () => {
  const cfg = router([provider('pool', ['a', 'b', 'c', 'd']), provider('healthy', ['e'])]), tried = [];
  const titles = createConversationTitles({ candidates: model => titleCandidates(model, { router: cfg }), normalize: shortTitle,
    request: async ({ model }) => { tried.push(model); if (model !== 'e') throw new TitleRequestError('limited', 'HTTP 429'); return '恢复会话命名'; } });
  assert.equal(await titles.generate('请修复会话命名', 'a'), '恢复会话命名');
  assert.deepEqual(tried, ['a', 'e']);
});

test('a failing model falls through to the next candidate instead of leaving the conversation unnamed', async () => {
  const tried = [];
  const titles = createConversationTitles({ candidates: () => ['bad', 'good'], delay: async () => {}, normalize: shortTitle,
    request: async ({ model }) => { tried.push(model); if (model === 'bad') throw new TitleRequestError('transient', 'HTTP 503'); return '  修复命名稳定性。 '; } });
  assert.equal(await titles.generate('message', 'bad'), '修复命名稳定性');
  assert.deepEqual(tried, ['bad', 'bad', 'good']);
});

test('transient trouble is retried, rejected requests are retried smaller, and auth moves on', async () => {
  const bodies = [];
  const transient = createConversationTitles({ candidates: () => ['m'], delay: async () => {}, normalize: shortTitle,
    request: async ({ minimal }) => { bodies.push(minimal); if (bodies.length === 1) throw new TitleRequestError('transient', 'connection failed'); return '稳定标题'; } });
  assert.equal(await transient.generate('message', 'm'), '稳定标题');
  assert.deepEqual(bodies, [false, false]);

  const rejected = createConversationTitles({ candidates: () => ['m'], delay: async () => {}, normalize: shortTitle,
    request: async ({ minimal }) => { bodies.push(minimal); if (!minimal) throw new TitleRequestError('rejected', 'HTTP 400'); return '短标题'; } });
  assert.equal(await rejected.generate('message', 'm'), '短标题');
  assert.deepEqual(bodies.slice(-2), [false, true]);

  const tried = [];
  const auth = createConversationTitles({ candidates: () => ['dead', 'live'], delay: async () => {}, normalize: shortTitle,
    request: async ({ model }) => { tried.push(model); if (model === 'dead') throw new TitleRequestError('auth', 'HTTP 401'); return '换模型标题'; } });
  assert.equal(await auth.generate('message', 'dead'), '换模型标题');
  assert.deepEqual(tried, ['dead', 'live']);
});

test('an empty answer or exhausted candidates returns no title instead of throwing', async () => {
  const empty = createConversationTitles({ candidates: () => ['m'], delay: async () => {}, request: async () => '   ' });
  assert.equal(await empty.generate('message', 'm'), '');
  const failing = createConversationTitles({ candidates: () => ['m'], delay: async () => {},
    request: async () => { throw new TitleRequestError('transient', 'HTTP 503'); } });
  await assert.doesNotReject(async () => assert.equal(await failing.generate('message', 'm'), ''));
});

test('an answer truncated by the output cap is retried without a cap', async () => {
  const bodies = [];
  const titles = createConversationTitles({ candidates: () => ['reasoner'], delay: async () => {}, normalize: shortTitle,
    request: async ({ minimal }) => { bodies.push(minimal);
      return minimal ? { text: '  推理模型标题  ', truncated: false } : { text: '', truncated: true }; } });
  assert.equal(await titles.generate('message', 'reasoner'), '推理模型标题');
  assert.deepEqual(bodies, [false, true]);
});

test('a truncated answer that stays empty is logged, then another model is tried', async () => {
  const logs = [], tried = [];
  const titles = createConversationTitles({ candidates: () => ['reasoner', 'plain'], delay: async () => {}, normalize: shortTitle,
    log: message => logs.push(message),
    request: async ({ model }) => { tried.push(model);
      return model === 'reasoner' ? { text: '', truncated: true } : { text: '普通标题', truncated: false }; } });
  assert.equal(await titles.generate('message', 'reasoner'), '普通标题');
  assert.deepEqual(tried, ['reasoner', 'reasoner', 'plain']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reasoner/);
});

test('a reasoning model needs room for thinking plus the title', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= 1024);
});

test('status codes map to the retry decision that actually helps', () => {
  assert.equal(titleErrorKind(400), 'rejected');
  assert.equal(titleErrorKind(422), 'rejected');
  assert.equal(titleErrorKind(401), 'auth');
  assert.equal(titleErrorKind(403), 'auth');
  assert.equal(titleErrorKind(404), 'unavailable');
  assert.equal(titleErrorKind(429), 'limited');
  assert.equal(titleErrorKind(503), 'transient');
});

test('generated titles share the short-title normalization used everywhere else', () => {
  assert.equal(shortTitle('  "修复会话默认标题生成逻辑。"  '), '修复会话默认标题生成');
  assert.ok([...shortTitle('a'.repeat(40))].length <= 10);
});

test('provisional titles use the visible topic, skip empty lines and count Unicode characters', () => {
  assert.equal(messageTitle('\n\n请帮我修复远程会话命名失败\nMore context'), '修复远程会话命名失败');
  assert.equal(messageTitle('Could you fix naming failures?'), 'fix naming');
  assert.equal(messageTitle('😀'.repeat(12)), '😀'.repeat(10));
  assert.equal(messageTitle('   '), '');
});

test('production requester marks auxiliary traffic and retries with a smaller uncapped body', async () => {
  const requests = [];
  const request = createTitleRequester({ getRoute: () => ({ baseUrl: 'http://router', authToken: 'managed' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '修复命名' }] }, finish_reason: 'stop' }] }));
    } });
  assert.deepEqual(await request({ model: 'm', message: 'x'.repeat(5000), minimal: false }), { text: '修复命名', truncated: false });
  await request({ model: 'm', message: 'x'.repeat(5000), minimal: true });
  assert.equal(requests[0].url, 'http://router/v1/chat/completions');
  assert.equal(requests[0].options.headers[AUXILIARY_HEADER], 'title');
  assert.equal(requests[0].body.max_tokens, MAX_OUTPUT_TOKENS);
  assert.equal(JSON.parse(requests[0].body.messages[1].content).length, MAX_MESSAGE_CHARS);
  assert.equal(requests[1].body.max_tokens, undefined);
  assert.equal(JSON.parse(requests[1].body.messages[1].content).length, 600);
});

test('production requester classifies upstream errors and detects empty truncated answers', async () => {
  let response;
  const request = createTitleRequester({ getRoute: () => ({ baseUrl: 'http://router', authToken: 'managed' }),
    fetchImpl: async () => response });
  response = new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 });
  await assert.rejects(request({ model: 'm', message: 'Hello' }), error => error.kind === 'limited' && /quota exhausted/.test(error.message));
  response = new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
  assert.deepEqual(await request({ model: 'm', message: 'Hello' }), { text: '', truncated: true });
  response = new Response('not JSON');
  await assert.rejects(request({ model: 'm', message: 'Hello' }), error => error.kind === 'transient');
});

function rendererFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/claude.js'), 'utf8');
  const handler = source.slice(source.indexOf('  function handleEvent(ev)'), source.indexOf("    if (ev.type === 'conversation:remote-queue')")) + '\n  }';
  const header = { textContent: 'Open conversation', dataset: {} }, state = { loads: 0 };
  const context = { context: { sessionId: 'open' }, restoringRun: false, eventsDuringRestore: [],
    sidebar: { load: async () => { state.loads++; } }, $: () => header };
  vm.runInNewContext(handler, context);
  return { context, state, header, event: (id, title) => context.handleEvent({ type: 'conversation:title', session_id: id, title }) };
}

test('desktop refreshes titles generated for a background or remotely created conversation', () => {
  const f = rendererFixture();
  f.event('remote', '远程命名修复');
  assert.equal(f.state.loads, 1);
  assert.equal(f.header.textContent, 'Open conversation');
  f.event('open', '当前会话标题');
  assert.equal(f.state.loads, 2);
  assert.equal(f.header.textContent, '当前会话标题');
  assert.equal(f.header.dataset.titled, '1');
});

test('desktop retains titles emitted before the first send returns its conversation ID', () => {
  const f = rendererFixture();
  f.context.restoringRun = true;
  f.event('new', '首条消息标题');
  assert.equal(f.header.textContent, 'Open conversation');
  assert.equal(f.context.eventsDuringRestore.length, 1);
  f.context.context.sessionId = 'new'; f.context.restoringRun = false;
  f.context.handleEvent(f.context.eventsDuringRestore.shift());
  assert.equal(f.header.textContent, '首条消息标题');
  assert.equal(f.state.loads, 1);
});
