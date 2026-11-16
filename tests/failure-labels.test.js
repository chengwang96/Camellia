'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { failureKind } = require('../src/api/api-router');
const { FAILURE_LABELS, failureText, failureLabel } = require('../src/shared/failure-labels');
const { translate } = require('../src/shared/i18n');

const KIND_CASES = [
  ['401 is authentication', 401, '', 'auth'],
  ['402 is quota', 402, '', 'quota'],
  ['429 usage limit is quota', 429, 'you have reached your monthly usage limit', 'quota'],
  ['429 quota text is quota', 429, 'quota exceeded', 'quota'],
  ['429 plain is rate limit', 429, 'slow down', 'rate_limit'],
  ['403 plan text is quota', 403, 'plan limit reached', 'quota'],
  ['403 other is unknown', 403, 'forbidden', null],
  ['400 model not found', 400, 'unsupported_model', 'model_unavailable'],
  ['404 model not found', 404, 'model_not_found', 'model_unavailable'],
  ['422 model unavailable', 422, 'model temporarily unavailable', 'model_unavailable'],
  ['400 other is unknown', 400, 'bad request', null],
  ['500 is upstream', 500, '', 'upstream'],
  ['503 is upstream', 503, 'busy', 'upstream'],
];

test('failureKind maps status and body to one stable kind', () => {
  for (const [name, status, body, expected] of KIND_CASES) {
    assert.equal(failureKind(status, body), expected, name);
  }
});

test('every kind has a default English label and a Chinese translation', () => {
  for (const [kind, english] of Object.entries(FAILURE_LABELS)) {
    assert.equal(failureText(kind), english, kind);
    assert.notEqual(translate(english, 'zh-CN'), english, kind);
  }
});

test('a new record uses its kind, not the stored English sentence', () => {
  const entry = { kind: 'quota', reason: 'Key authentication failed' };
  assert.equal(failureLabel(entry), FAILURE_LABELS.quota);
  assert.equal(failureLabel(entry, text => translate(text, 'zh-CN')), '额度已用完或订阅套餐不可用');
});

test('an old record without a kind keeps its stored reason', () => {
  assert.equal(failureLabel({ reason: 'Connection failed or timed out' }),
    'Connection failed or timed out');
});

test('an unknown kind falls back to the stored reason, then to empty', () => {
  assert.equal(failureLabel({ kind: 'future_kind', reason: 'Stored text' }), 'Stored text');
  assert.equal(failureLabel({ kind: 'future_kind' }), '');
  assert.equal(failureLabel(null), '');
});

test('status classification is exhaustive for the documented bands', () => {
  const cases = [
    [401, 'auth'], [402, 'quota'], [403, null], [404, null],
    [408, null], [413, null], [429, 'rate_limit'], [500, 'upstream'],
    [501, 'upstream'], [502, 'upstream'], [503, 'upstream'], [504, 'upstream'],
  ];
  for (const [status, expected] of cases) {
    assert.equal(failureKind(status, ''), expected, String(status));
  }
});

test('model-specific text only downgrades the documented statuses', () => {
  assert.equal(failureKind(500, 'unsupported_model'), 'upstream');
  assert.equal(failureKind(400, 'unsupported_model'), 'model_unavailable');
  assert.equal(failureKind(429, 'unsupported_model'), 'rate_limit');
});
