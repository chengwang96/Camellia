# Context capacity evidence

Settings → Providers & Keys → select a provider → Context capacity evidence.
Select a model using the existing validation-model selector, then choose **Detect
context capacity**. A confirmation dialog selects the saved account, protocol,
maximum estimated input and request count. Nothing is probed automatically.

## Evidence, not a model specification

- Catalog `maxContext` remains the provider's declaration.
- Normal routed requests record their largest reported accepted input and the
  output budget used. Explicit structured context errors may add a declared limit.
  This does not send any additional requests or retain conversation content.
- Active probes double approximate input sizes, then bisect an explicit rejection
  boundary to within 2,048 estimated tokens. A cap reached without rejection is
  only an accepted lower bound, not a discovered maximum.
- Input generation uses deterministic varied synthetic words. Search sizes use
  four characters per estimated token, not a provider tokenizer. Reported usage
  stays separate from these estimates; Anthropic cache input is included.
- Start/middle/end markers provide a weak retention check. Missing markers do not
  prove truncation, and returned markers do not prove full retention. No result
  automatically changes the configured context window or compaction threshold.

## Limits and compatibility

Defaults: 65,536 estimated input tokens per request, eight requests, 128 output
tokens per request. Hard caps: 262,144 estimated tokens per request, twelve
requests, 524,288 cumulative estimated input tokens, five minutes overall and
sixty seconds per request. Estimates exclude framing overhead and are not a
monetary spending guarantee. Actual usage and charges can be higher.

Probes directly use the chosen Chat Completions or Messages endpoint, model and
credential: no router fallback, compatibility retry, rate-limit retry or scheduler.
The request uses `max_tokens`; providers requiring another output parameter stop
with an API error rather than automatically sending another paid request.
HTTP 413, 429, authentication errors, timeouts and gateway errors do not establish
a context boundary. Only structured HTTP 400/422 context errors do.

Cancel aborts the in-flight fetch and prevents later requests; it cannot undo
upstream charges. A settings window may be reopened to view/cancel a running
probe. App restart marks interrupted probes and never resumes them automatically.

## Persistence

`context-capacity.json` under application user data stores numerical evidence and
timestamps keyed by a SHA-256 fingerprint of provider ID, endpoints, credential,
key ID, canonical/upstream model IDs and effective protocol. Changes invalidate
old evidence. Neither API keys nor prompt/response bodies are persisted. Model
and account results are never merged across routes. Only the latest probe per
route is retained; normal-request evidence coexists with it.

Probe traffic bypasses router usage totals. The evidence panel reports input
usage when returned, but is not a billing ledger; consult the supplier for charges.

## Verification

`node --test tests/context-capacity.test.js tests/api-router.test.js`

`python tests/context-capacity-ui.py`

All verification uses mocked/local providers and no paid credentials.

## Conversation migration

Native compaction remains the first choice for an unchanged, synchronized native
session. Segments persist the model, connection and configured context window
used to open them. A changed profile is not assumed to be safe merely because
the harness supports native compaction. Claude can reject `/compact` with
`Not enough messages to compact.` after a fresh session receives a large replay:
many logical history rows still form only one native user message. This temporary
failure falls back to portable summarization without permanently disabling native
compaction. Unrelated native errors and cancellation do not trigger this fallback.

Before sending oversized history to a different model or harness, portable
compaction separates the summarizer's input capacity from the destination's
summary budget. A previously used larger model on the same connection can write
the summary; if it fails, the selected model receives bounded history fragments
instead. This fallback never changes credentials or the user's selected model.
Destination budgets reserve room for the pending message, Camellia instructions,
request framing and output. Dense non-ASCII text uses a more cautious estimate
than ASCII. These are conservative heuristics, not provider-tokenizer guarantees;
hidden CLI prompts, tools and multimodal inputs can still cause provider overflow.

New or stale harness segments consume the latest available portable checkpoint
and subsequent history, not the entire pre-checkpoint transcript. Original rows
remain on disk. A missing checkpoint falls back to earlier available history.
Portable compaction replaces the destination binding only after generating and
checking the summary; cancellation or summarization failure leaves it intact.
Markdown handoffs also use the destination budget and shorten oversized drafts
before asking the target harness to accept them.

The router pipeline repacks overflowing merge batches under the learned budget
and splits individual oversized summaries. Retries, nesting and requests remain
bounded. Summaries are lossy: successful capacity checks do not certify complete
retention of every fact. The persisted original transcript remains the source for
recovering details.

Migration regressions: `node --test tests/compaction-plan.test.js tests/shared-conversations.test.js`.
