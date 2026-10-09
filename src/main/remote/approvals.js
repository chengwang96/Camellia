'use strict';

const { createHash } = require('node:crypto');
const { fail } = require('./access');
const fingerprint = event => createHash('sha256').update(JSON.stringify(event)).digest('hex');
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

// Both clients answer the original engine request. Neither transport grants
// permission by itself, nor translates a question into a blanket approval.
function approval(event) {
  const details = JSON.stringify(event.input || {}, null, 2);
  const questions = Array.isArray(event.questions) ? event.questions : [];
  const options = Array.isArray(event.options) ? event.options.filter(option => ['allow_once', 'reject_once'].includes(option.kind)) : [];
  const supported = details.length <= 32000 && questions.length <= 12 && JSON.stringify(questions).length <= 48000
    && (!event.options?.length || options.length > 0);
  return { requestId: event.requestId, fingerprint: fingerprint(event), toolName: String(event.toolName || 'Tool approval'),
    ...(event.subagentId ? { subagentId: event.subagentId } : {}),
    details: details.slice(0, 32000), reason: String(event.reason || '').slice(0, 4000),
    actionable: !questions.length && supported, responseSupported: supported,
    questions: supported ? questions.map(q => ({ ...pick(q, ['id', 'header', 'question', 'multiSelect', 'isSecret']),
      options: (q.options || []).map(o => pick(o, ['label', 'description'])) })) : [],
    options: options.map(o => pick(o, ['optionId', 'kind', 'name'])) };
}

function answer(event, payload) {
  const view = approval(event);
  if (payload.fingerprint !== view.fingerprint || !view.responseSupported) fail(409, 'This request changed; refresh before answering');
  if (typeof payload.allow !== 'boolean') fail(400, 'Choose whether to allow this request');
  const result = { allow: payload.allow };
  if (event.questions?.length && payload.allow) {
    const input = payload.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 64000
      || Object.keys(input).some(key => !event.questions.some(q => q.id === key))) fail(400, 'Invalid question answers');
    for (const question of event.questions) {
      const value = input[question.id];
      if (question.multiSelect ? !Array.isArray(value) || !value.length || value.length > 100 || value.some(v => typeof v !== 'string' || !v.trim())
        : typeof value !== 'string' || !value.trim()) fail(400, 'Answer each question before submitting');
    }
    result.input = input;
  } else if (payload.input !== undefined) fail(400, 'This request does not accept question answers');
  if (event.options?.length) {
    const option = payload.optionId === undefined ? view.options.find(o => o.kind === (payload.allow ? 'allow_once' : 'reject_once'))
      : view.options.find(o => o.optionId === payload.optionId && o.kind === (payload.allow ? 'allow_once' : 'reject_once'));
    if (!option) fail(400, 'This approval option is unavailable');
    result.optionId = option.optionId;
  } else if (payload.optionId !== undefined) fail(400, 'Unexpected approval option');
  return result;
}
module.exports = { approval, answer, fingerprint };
