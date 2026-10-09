'use strict';

// Conversation titles are advisory, so they must never delay the first turn,
// trip the shared route pool's per-model cooldown, or add to the user's usage
// totals. Naming used to be a single attempt against the conversation's own
// model, which is why it looked intermittent: one unhealthy or unsupported
// model left the conversation named "New session" until it recovered. Titles
// are therefore attempted against a bounded list of routable models, and a
// model that cannot answer is skipped instead of ending the attempt.

const MAX_TITLE_MODELS = 3;
const ATTEMPTS_PER_MODEL = 2;
const RETRY_DELAY_MS = 500;
const MAX_MESSAGE_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 20000;

// Reasoning models spend output on thinking before they emit any text, so the
// cap must cover the thinking plus the title. 256 did not: the common reasoning
// routes (deepseek-flash, kimi-k3, deepseek-v4-pro) spent the whole budget on
// thinking, stopped with `finish_reason: length` and an empty answer, and the
// conversation silently stayed "New session". A larger cap costs nothing for
// models that answer immediately, since it is a ceiling rather than a target.
const MAX_OUTPUT_TOKENS = 2048;

const TITLE_INSTRUCTION = 'Write a short, accurate title for the conversation that starts with the user message below. '
  + 'Output only the title: no quotes, no trailing punctuation, no explanation, at most 10 characters. '
  + 'Use the language of the message.';

// Newer OpenAI reasoning models reject the legacy cap field outright, so the
// retry after a rejected request omits the cap and shortens the message.
const MINIMAL_INSTRUCTION = 'Reply with one short title for this message, nothing else. Use the language of the message.';

const AUXILIARY_HEADER = 'x-camellia-aux';

// Failures are classified so a retry is only spent where it can help: a
// rejected request is retried with a smaller body, transient trouble is
// retried as-is, and a rejected credential moves on to the next model.
function titleErrorKind(status) {
  if (status === 400 || status === 422) return 'rejected';
  if (status === 404) return 'unavailable';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'limited';
  return 'transient';
}

class TitleRequestError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TitleRequestError';
    this.kind = kind;
  }
}

// Ordered candidates: the conversation's model first, then the workbench
// default, then other models with an available route. Provider diversity takes
// precedence over a second model in the same pool. Removed, disabled and
// known unhealthy routes cost no attempt; the cap bounds background traffic.
function titleCandidates(preferred, { fallback, router, state, now = Date.now() } = {}) {
  if (!router || router.enabled === false || state?.running === false) return [];
  const usage = state?.usage || router.usage || {};
  const routable = new Map();
  for (const provider of router.providers || []) {
    if (!provider || provider.enabled === false) continue;
    for (const model of provider.models || []) {
      const id = String(model?.id || '').trim();
      if (!id || !(provider.keys || []).some(key => key && key.enabled !== false && !usage[key.id]?.blocked
        && !(usage[key.id]?.models?.[id]?.until > now) && !state?.quota?.[key.id]?.exhausted)) continue;
      if (!routable.has(id)) routable.set(id, new Set());
      routable.get(id).add(provider);
    }
  }
  const ordered = [...new Set([preferred, fallback, ...routable.keys()]
    .map(value => String(value || '').trim()).filter(Boolean))];
  const available = ordered.filter(id => routable.has(id)), selected = [], covered = new Set();
  const add = id => { selected.push(id); for (const provider of routable.get(id)) covered.add(provider); };
  if (available.length) add(available[0]);
  // Spending every fallback on one exhausted provider prevented the healthy
  // providers later in settings from ever receiving a naming request.
  for (const id of available.slice(1)) {
    if (selected.length >= MAX_TITLE_MODELS) break;
    if ([...routable.get(id)].some(provider => !covered.has(provider))) add(id);
  }
  for (const id of available) {
    if (selected.length >= MAX_TITLE_MODELS) break;
    if (!selected.includes(id)) add(id);
  }
  return selected;
}

// Kept outside Electron so tests and live probes use the production request.
function createTitleRequester({ getRoute, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return async ({ model, message, minimal }) => {
    const route = getRoute();
    const body = { model, stream: false, messages: [
      { role: 'system', content: minimal ? MINIMAL_INSTRUCTION : TITLE_INSTRUCTION },
      { role: 'user', content: JSON.stringify(String(message || '').slice(0, minimal ? 600 : MAX_MESSAGE_CHARS)) },
    ] };
    if (!minimal) body.max_tokens = MAX_OUTPUT_TOKENS;
    const response = await fetchImpl(route.baseUrl + '/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${route.authToken}`, 'Content-Type': 'application/json', [AUXILIARY_HEADER]: 'title' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try { detail = JSON.parse(text)?.error?.message || text; } catch {}
      throw new TitleRequestError(titleErrorKind(response.status), `HTTP ${response.status}: ${String(detail).slice(0, 200)}`);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new TitleRequestError('transient', 'The title response was not valid JSON'); }
    const choice = data?.choices?.[0], content = choice?.message?.content;
    return { text: typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '',
    truncated: choice?.finish_reason === 'length' };
  };
}

function createConversationTitles({ candidates, request, normalize = value => String(value || '').trim(),
  log = () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  async function generate(message, model) {
    for (const candidate of candidates(model)) {
      // A rejected request is retried in its most compatible form: no output
      // cap and a shorter message. Transient trouble is retried unchanged,
      // since shrinking the request would not help it.
      let minimal = false;
      for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
        try {
          const answer = await request({ model: candidate, message, minimal });
          // A reasoning model can burn the whole output cap on thinking and
          // stop before writing the title, so the request succeeds with an
          // empty answer. That is not a reason to give up on the conversation's
          // own model; ask it once more without the cap.
          const truncated = typeof answer !== 'string' && Boolean(answer?.truncated);
          const title = normalize(typeof answer === 'string' ? answer : answer?.text);
          if (title) return title;
          if (!minimal && truncated) { minimal = true; continue; }
          // The model answered without usable text and did not run out of room;
          // another model is a better bet than asking the same one again.
          log(`conversation title: ${candidate} answered without usable text`);
          break;
        } catch (error) {
          const kind = error?.kind || 'transient';
          if (['auth', 'limited', 'unavailable'].includes(kind)) {
            log(`conversation title: ${candidate} unavailable (${error.message}), trying another model`);
            break;
          }
          if (attempt + 1 >= ATTEMPTS_PER_MODEL) {
            log(`conversation title: ${candidate} unavailable (${error.message})`);
            break;
          }
          if (kind === 'rejected') minimal = true;
          else await delay(RETRY_DELAY_MS);
        }
      }
    }
    return '';
  }
  return { generate };
}

module.exports = { createConversationTitles, createTitleRequester, titleCandidates, titleErrorKind, TitleRequestError,
  TITLE_INSTRUCTION, MINIMAL_INSTRUCTION, AUXILIARY_HEADER, MAX_MESSAGE_CHARS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, MAX_TITLE_MODELS };
