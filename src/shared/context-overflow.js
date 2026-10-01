'use strict';

// Recognizing a provider context error has to tolerate the many wordings
// suppliers use. Two classes of message matter: the model's declared window
// ("maximum context length is N tokens") and the per-request input cap
// ("the input token count (...) exceeds the maximum number of tokens
// allowed", Anthropic's "Input is too long.", and Codex's "exceeds the
// maximum length of N characters"). Anything else, such as rate limits or an
// output-budget error like "maximum tokens per request", must not match: a
// false positive triggers a summary the provider never asked for.
const CONTEXT_OVERFLOW_SOURCES = [
  'context[_ ]?(?:length|window)[^ ]*.{0,20}(?:exceed|too|limit)',
  'context overflow',
  'maximum context',
  'exceeds? the (?:maximum|model) context',
  'prompt is too long',
  'input is too long',
  'input length[^.]{0,20}(?:exceed|limit|too|should)',
  'input (?:length|size)[^.]{0,60}\\d{3,}',
  'input token count[^.]{0,60}(?:exceed|over|larger|greater|limit)',
  'token count[^.]{0,60}(?:exceed|over|larger|greater|limit)',
  '(?:exceed|over|larger than|greater than)[^.]{0,40}(?:maximum|model|allowed|permitted)[^.]{0,40}tokens?',
  'tokens?[^.]{0,40}(?:exceed|over|larger than|greater than)[^.]{0,40}(?:maximum|limit|allowed|permitted)',
  '(?:maximum|max)(?:imum)?[^.]{0,20}(?:number of )?tokens?[^.]{0,20}(?:allowed|supported|permitted)',
  'support(?:s|ed)? (?:at most|up to) [\\d,]+ (?:input )?tokens',
  'exceed\\w*[^.]{0,30}maximum (?:input|prompt) (?:length|tokens?)',
  '(?:input|prompt)[^.]{0,30}(?:longer|larger|greater) than[^.]{0,30}(?:context|limit|window)',
  'exceeds the maximum length of [\\d,]+ characters',
  'payload size exceeds',
  'too many tokens',
  'request.{0,10}too (?:large|long)',
];
const CONTEXT_OVERFLOW = new RegExp(CONTEXT_OVERFLOW_SOURCES.join('|'), 'i');

// "Request too large ... on tokens per min (TPM)" is an OpenAI rate limit, not
// a context error. Rate limits, quota and concurrency messages never trigger a
// compaction even though they mention size or limits.
const RATE_LIMIT = /tokens? per (?:min|minute|hour|day)|(?:TPM|RPM|RPD)\b|rate[ _-]?limit|too many requests|quota|concurren/i;

const textOf = value => typeof value?.result === 'string' ? value.result : String(value?.result ?? value ?? '');
// A provider error that names the limit is a budget signal; a bare rate limit or
// an unrelated failure is not. Both consumers share this predicate, so a
// message either is a context error everywhere or nowhere.
const contextOverflowText = value => {
  const text = String(value ?? '');
  return CONTEXT_OVERFLOW.test(text) && !RATE_LIMIT.test(text);
};
const contextOverflow = event => Boolean(event?.is_error) && contextOverflowText(textOf(event));

module.exports = { CONTEXT_OVERFLOW_SOURCES, RATE_LIMIT, contextOverflow, contextOverflowText };
