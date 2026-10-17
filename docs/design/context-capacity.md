# Context budgets

Normal API requests record provider-reported input counts and explicit context
limits for conversation budgeting. This does not send additional requests or
change the configured context window. The capacity testing panel and active
probe endpoints have been removed.

## Runtime budgets

Runtime evidence distinguishes **accepted input lower bounds** separately from
**confirmed upper bounds**, both in provider-reported tokens. Only explicit token
limits in structured HTTP 400/422 context errors establish a confirmed upper bound.
An input-only limit keeps its scope; it is not a model's total
context-window specification. Estimated accepted/rejected search sizes, character
or byte caps, and successful requests alone never become confirmed maxima.

Desktop and headless conversation budgets read this evidence on each decision:

- Resolve each enabled provider, upstream model and effective protocol
  independently, using the same route enumeration as the router and sharing
  evidence across that provider's keys. An OpenAI client
  routed to a Messages provider uses that provider's Messages evidence.
- Start with the configured window, then catalog metadata, then a confirmed limit.
  Confirmed limits constrain even an explicitly configured or native-reported
  larger window. A smaller user-configured budget stays smaller.
- If all those limits are absent, a reported accepted input of at least 4,096
  tokens supplies a provisional operating budget. Otherwise use a conservative
  32,768-token fallback, labelled unknown. Neither is a verified maximum.
- Take the minimum of the independently resolved budgets across enabled fallback
  routes. Unknown routes participate with their own provisional budget; they do
  not inherit another provider's window. Temporary cooldowns do not exclude a
  candidate that could recover before dispatch or failover.
- Keep the existing compaction headroom. When native auto-compaction still uses a
  larger window, Camellia performs early compaction. Router summaries resolve
  their Chat Completions transport separately from the continuing engine.

API evidence does not constrain subscription connections. Replacing an endpoint,
upstream model or effective protocol invalidates its evidence and the conversation's
associated backoff key. Adding, removing, reordering or replacing keys does not
invalidate shared evidence or change the backoff key while the same provider routes
remain enabled. Generic conversation overflow backoff is still a heuristic, separate from
confirmed upper bounds. These budgets do not guarantee retention or exact token
fit for different tools, output allowances, or multimodal input.

## Persistence

`context-capacity.json` under application user data stores numerical evidence and
timestamps keyed by a SHA-256 fingerprint of provider ID, endpoints,
canonical/upstream model IDs and effective protocol. API keys are excluded from
this identity, and neither credentials nor conversation bodies are persisted.
Different providers, models and protocols keep separate evidence.

Legacy files remain readable. Per-key fingerprints for currently saved keys merge
into shared entries, retaining the largest reported accepted input and the
smallest explicit limit per scope. Historical probe records are kept as data;
only actual token counts and explicit limits contribute to budgets. Estimated
search sizes never become confirmed limits. No old probe or batch is resumed.

Regression coverage: `node --test tests/context-capacity.test.js tests/api-router.test.js`.

## Conversation migration

Native compaction remains the first choice for a synchronized native session on
the same model, connection and account. Segments retain the last reported native
window separately from input-token usage: confirmed compaction invalidates the
old token count, but keeps the window across restart. Replacing the native ID
clears both. Raising the configured budget can reuse a smaller native window;
lowering it below the native window still requires a portable handoff. A changed
binding is not assumed safe merely because the harness supports compaction.
Confirmed native compaction also records the global account preference at the
start of that operation. While that preference remains unchanged, the next turn
keeps the just-compacted thread's usable account instead of immediately rebuilding
its history on another account. This continuation does not reset the global
preference. A new account choice after compaction still takes effect, as do
explicit recovery overrides. Selection revisions are compared within the same
runtime; after restart the persisted account ID is used. Automatic switching can
still migrate an exhausted, signed-out, pending-login or removed owner.

Claude can reject `/compact` with
`Not enough messages to compact.` after a fresh session receives a large replay:
many logical history rows still form only one native user message. This temporary
failure falls back to portable summarization without permanently disabling native
compaction. A transient connection failure before native progress is retried once
after 250 ms on the same thread and account. Errors after progress, authentication
or storage failures, exhausted connection retries and cancellation retain the
native binding and report failure; `/compact` does not silently replace it with
a local handoff that omits old context. Explicitly unsupported native compaction,
a lost session, context overflow and the native request timeout can use portable
summarization.

Markdown handoffs also respect native ownership. A large archived transcript
alone does not trigger an extra portable summary when the source thread already
contains it. If the handoff request overflows, native compaction is attempted
first when eligible, then the source writes the portable Markdown for the target.
Oversized history that the source thread has not seen still needs a bounded
portable replay.

`context routing` logs the before-send native reuse decision and subscription
selection. `context compaction route` records the decision before preparation or
summary requests begin; final compaction metrics persist it under
`nativeCompaction`. The decision includes `eligible`, the exact `reason`, native
ID/cursor, bound and requested model/connection/account/window, and relevant
native/route limits. Reasons distinguish missing native state, model, connection
or account changes, undersized configured/route windows, unsupported compaction,
unsafe shared profiles and unsynchronized public history. `triggerReason` explains
why compaction was requested, even when the high-level route is
`portable-requested`. Account selection records retention or the owner's quota,
login or removal failure. Actual recovery logs its old/new account IDs and auth
or quota reason. These records contain no prompts, tool output or credentials.

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

User `/compact` retains a five-minute total budget, including a native-to-portable
fallback. Automatic and programmatic compaction have a 30-minute total limit so
large batches can continue while making progress. Engine requests additionally
have a two-minute timeout; router
requests and lack of router progress are bounded at three minutes. Both
transports allow at most 128 summary attempts, with existing overflow,
shortening and nesting limits still in force.
Accepted fragment and merge answers are checkpointed with hashes of their exact
inputs, instructions and output limits. Appending turns or repacking fragments
does not invalidate unrelated accepted requests; changed requests are generated
again. Cache scopes isolate the workspace, engine, model, connection, account,
route set and summary transport. Older checkpoints with a whole-history hash
remain reusable only when that original hash matches; text-only checkpoints
cannot be resumed safely. Partial checkpoint text never replaces the conversation.
The complete summary must pass the destination budget check before it is committed.

Stopping a long Goal does not discard its native context. Codex's acknowledged
turn interruption advances the logical cursor, so an ordinary follow-up does
not replay already-consumed tool history. An edit of an in-turn steering message
forks at that native turn's saved boundary and replays only the records before
the edited message within that turn. Later records and the superseded message
are excluded; earlier native compactions remain available in the fork. Repeated
edits persist this replay boundary. Missing or stale anchors still fall back to
portable history instead of assuming an unsafe native boundary.

The router pipeline repacks overflowing merge batches and retries the same
history fragment under the smaller budget. Heuristic shrinking after a summary
error bounds only that summary run; it never rewrites the conversation's own
backoff or configured window. Separately, an explicit upstream token limit can
be recorded as route capacity evidence, just as in an ordinary request. Real
conversation turns and native compaction still learn local recovery budgets.
Retries, nesting and requests remain bounded. Summaries are
lossy: successful capacity checks do not certify complete retention of every
fact. The persisted original transcript remains the source for recovering
details.

`src/shared/context-overflow.js` is the single recognizer for "this request is
over a context limit"; the conversation engine and the router summarizer both
use it so a message is a context error everywhere or nowhere. It accepts the
declared-window and per-request-input-cap wordings suppliers actually use
(including Anthropic's `Input is too long.`, OpenAI-style `input token count …
exceeds the maximum number of tokens allowed …`, and Codex's character cap) and
rejects look-alikes: rate limits such as `… on tokens per min (TPM)`, an output
budget like `Maximum tokens per request: N`, and a bare `context window: N`
declaration. A false positive spends a summary request the provider never asked
for.

Migration regressions: `node --test tests/compaction-plan.test.js tests/shared-conversations.test.js`.
