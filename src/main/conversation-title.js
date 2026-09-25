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
  if (status === 400 || status === 404 || status === 422) return 'rejected';
  if (status === 401 || status === 403) return 'auth';
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
// default, then other models that currently have an enabled route. Only
// models the router can actually reach are considered when the pool knows its
// routes, so a removed or disabled model costs no attempt. The cap keeps the
// whole feature to a few small requests that no longer outlive the first turn.
function titleCandidates(preferred, { fallback, router } = {}) {
  if (!router || router.enabled === false) return [];
  const routable = new Set((router.providers || [])
    .filter(provider => provider?.enabled !== false && (provider.keys || []).some(key => key?.enabled !== false))
    .flatMap(provider => (provider.models || []).map(model => model?.id))
    .filter(Boolean));
  const ordered = [...new Set([preferred, fallback, ...routable]
    .map(value => String(value || '').trim()).filter(Boolean))];
  return (routable.size ? ordered.filter(id => routable.has(id)) : ordered).slice(0, MAX_TITLE_MODELS);
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
          if (kind === 'auth') {
            log(`conversation title: ${candidate} rejected the credential, trying another model`);
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

module.exports = { createConversationTitles, titleCandidates, titleErrorKind, TitleRequestError,
  TITLE_INSTRUCTION, MINIMAL_INSTRUCTION, AUXILIARY_HEADER, MAX_MESSAGE_CHARS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, MAX_TITLE_MODELS };
