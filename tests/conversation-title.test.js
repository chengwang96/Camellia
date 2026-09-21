'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationTitles, titleCandidates, titleErrorKind, TitleRequestError, MAX_TITLE_MODELS } = require('../src/main/conversation-title');
const { shortTitle } = require('../src/engines/shared-conversations');

const router = (providers, enabled = true) => ({ enabled, providers });
const provider = (id, models, { enabled = true, keys = [{ id: 'k', enabled: true }] } = {}) => ({ id, enabled, keys, models: models.map(model => ({ id: model })) });

test('candidate models put the conversation model first and only keep routable ones', () => {
  const cfg = router([provider('p', ['a', 'b', 'c', 'd'])]);
  assert.deepEqual(titleCandidates('c', { fallback: 'a', router: cfg }), ['c', 'a', 'b']);
  // A model with no enabled route is skipped instead of costing an attempt.
  assert.deepEqual(titleCandidates('gone', { fallback: 'b', router: cfg }), ['b', 'a', 'c']);
  assert.deepEqual(titleCandidates('b', { router: router([provider('p', ['a'], { enabled: false })]) }), ['b']);
  assert.deepEqual(titleCandidates('b', { router: router([provider('p', ['a'], { keys: [{ id: 'k', enabled: false }] })]) }), ['b']);
  assert.deepEqual(titleCandidates('b', { router: router([], false) }), []);
  assert.ok(titleCandidates('a', { router: router([provider('p', ['a', 'b', 'c', 'd', 'e'])]) }).length <= MAX_TITLE_MODELS);
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

test('status codes map to the retry decision that actually helps', () => {
  assert.equal(titleErrorKind(400), 'rejected');
  assert.equal(titleErrorKind(422), 'rejected');
  assert.equal(titleErrorKind(401), 'auth');
  assert.equal(titleErrorKind(403), 'auth');
  assert.equal(titleErrorKind(429), 'transient');
  assert.equal(titleErrorKind(503), 'transient');
});

test('generated titles share the short-title normalization used everywhere else', () => {
  assert.equal(shortTitle('  "修复会话默认标题生成逻辑。"  '), '修复会话默认标题生成');
  assert.ok([...shortTitle('a'.repeat(40))].length <= 10);
});
