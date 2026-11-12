# Context management roadmap: browser, agent context, reversible compaction, memory

Status: baseline implemented, including resident portable summary lifecycle controls

Date: 2026-11-12

Scope: desktop conversation surface and shared conversation backend. Mobile and
headless surfaces follow only after the read-only APIs and bounded payloads are
stable.

## Implementation status

As of 2026-11-12:

- Phase 0 and Phase 1 are implemented as a read-only `ContextLedger`, bounded
  `context-snapshot` / `context-node` / `context-events` commands, and a Context
  panel reachable from the composer ring and header. The event stream covers
  injection, binding switch, compaction, handoff, fork/child creation and child
  settlement, with estimated net-token deltas where available. The panel also
  compares the selected request with the previous turn by category and node
  count.
- Phase 2 is implemented for managed child conversations: a bounded
  `DelegationPacket` is injected once, a `Settlement` is written back to the
  parent, and the Context panel renders an observed node/link agent graph.
- Phase 3A is implemented: portable summary blocks expose source ranges,
  keyword search, exact original-row expansion and optional file export.
  Expansion is tool-pair safe. Inline preview limits never truncate an
  individual source row or a file export, so long originals remain
  byte-for-byte recoverable. Portable summaries carry the first user request as
  a verbatim pinned section.
- Context events use the history index's summary chain, so loading a long
  conversation with no compaction events does not parse every transcript row.
- Phase 3B baseline is implemented: the active portable summary can be retired
  from the resident context and restored; rewrite replaces its summary text with
  a backup of the previous file. Native compaction remains opaque and cannot be
  retired this way without a native retrieval contract.
- Phase 4 has an opt-in local baseline: user/workspace entries, a bounded
  run-pinned snapshot, read-only child inheritance, explicit save language and
  no third-party memory providers. Memory status and search resolve the same
  pinned snapshot used by the active turn or inherited child, never newer
  live-file entries.

Regression entry points include `tests/context-ledger.test.js`,
`tests/context-retrieval.test.js`, `tests/context-memory.test.js`,
`tests/agent-context.test.js` and `tests/context-browser-ui.py`.

## Decision

Build a Camellia-owned context layer in four phases:

1. **Context Browser** — make the contents of a request observable.
2. **Agent Context** — give child agents a bounded, explicit context packet and
   return a structured settlement.
3. **Reversible compaction** — make compacted ranges addressable, searchable,
   and recoverable.
4. **Memory** — add an optional, scoped memory layer only after the first three
   phases have stable identities and provenance.

The first two phases are read-only with respect to model context. They do not
change compaction, prompts, or wire traffic. Later phases are opt-in and must
remain reversible.

The order is deliberate:

- Visibility first lowers support cost and gives every later feature a shared
  vocabulary.
- Agent handoff is the highest-value multi-agent feature and must not copy raw
  transcripts between engines.
- Reversible compaction depends on stable block and range identity.
- Memory depends on the packet and block ledgers, not the other way around.

## Goals

- Explain what occupies a request, not just how many tokens were used.
- Show why context changed: injection, compaction, harness switch, handoff,
  fork, or child creation.
- Give a child agent a small, quoted context packet instead of an entire parent
  transcript.
- Return a compact settlement from a child to its parent.
- Recover exact original history from a compacted range when needed.
- Keep all new behavior bounded, lazy, and compatible with existing transcripts.
- Preserve the distinction between observed data, estimated data, and data the
  native engine does not expose.

## Non-goals

- Do not proxy native harness traffic such as subscription Claude Code, Codex,
  DSH, Kimi, Antigravity, or Grok sessions.
- Do not claim exact system-prompt or tool-schema accounting when a native
  engine does not expose it.
- Do not copy an entire parent transcript into a child agent.
- Do not merge conversations from different harnesses into one native context.
- Do not replace the existing native or portable compaction paths in the first
  two phases.
- Do not build a memory-provider marketplace or auto-write memories without an
  explicit policy.
- Do not rewrite existing JSONL transcripts or summaries during migration.

## Principles

1. **A request is the unit of accounting.** A conversation turn is not precise
   enough; providers make one or more model calls per turn.
2. **The JSONL transcript remains the source of truth.** The context ledger is a
   derived, replaceable projection.
3. **Label every number.** Use `observed`, `estimated`, or `opaque`; never turn
   an unknown into a zero.
4. **Bounded and lazy.** Load summaries first, nodes on expansion, and full text
   only for one node at a time.
5. **Read-only inheritance.** A child receives a pinned packet or memory view;
   it does not receive a writable copy of the parent's context.
6. **No mid-turn drift.** A pinned packet or memory snapshot stays fixed for the
   accepted turn and is superseded outside that turn.
7. **Engine-neutral contracts.** Packet and context records are engine-neutral;
   capabilities remain engine-specific.
8. **Backward compatibility.** New fields are optional and old conversations
   remain readable without migration.

## Architecture

```text
Conversation JSONL + history index
  |
  |  existing rows, usage events, compaction notices, subagent events
  v
ContextLedger (derived, read-only normalizer)
  |-- ContextSnapshot ------> Context panel
  |-- ContextEvent ---------> Context timeline
  |-- AgentGraph -----------> Agents tab
  |-- ContextBlock ---------> Search / expand / retire (later)
  `-- MemorySnapshot ------> Pinned memory injection (later)

SharedConversations.command()
  `-- context-* and agent-* actions, reachable through the existing
      authenticated conversation-command bridge
```

The first implementation should not add a new database. It should derive
snapshots from `ConversationHistory` and the existing conversation record. A
small sidecar may be added later for per-step observations and block metadata.

## Shared data model

### ContextSnapshot

| Field | Meaning |
| --- | --- |
| `version` | Snapshot schema version. |
| `conversationId` | Camellia conversation id. |
| `engine`, `model`, `connection` | Binding used for the request. |
| `turnSeq`, `step` | Logical turn and provider call, when known. |
| `at` | Observation time. |
| `usage` | Reported input, output, cache read/write and context window. |
| `pressure` | Used/cap, percentage and whether it came from usage or an estimate. |
| `categories` | Aggregated category totals and accounting status. |
| `nodes` | Bounded preview rows; full content is fetched separately. |
| `events` | Compaction, injection, switch, handoff and fork events. |
| `warnings` | Unknown, partial, approximate or redacted fields. |

### ContextCategory

Initial categories:

- `instructions` — global-memory pointer, Camellia tool instructions and known
  configured instruction text.
- `conversation` — user and assistant text.
- `tool-calls` — tool invocation records.
- `tool-results` — tool output rows.
- `attachments` — images and files with known or estimated token cost.
- `compaction` — portable summary text or a native compaction marker.
- `pending` — the current prompt and output reserve.
- `engine-managed` — the residual the native engine owns but does not expose.

Later categories may include `skills`, `memory` and `cache` if an engine gives
them a stable source. A category must not be invented from a name alone.

### ContextNode

A node is a bounded reference, not a second copy of the conversation.

| Field | Meaning |
| --- | --- |
| `id` | Stable node id within a snapshot. |
| `category` | One category id. |
| `seq`, `turnSeq` | Transcript coordinates, when available. |
| `role`, `kind` | User, assistant, tool call, tool result, summary, attachment, etc. |
| `tokens`, `chars` | Token estimate and character length. |
| `preview` | Short redacted preview. |
| `observed` | Whether the content or measurement was directly observed. |
| `expandable` | Whether a node-content request is available. |
| `redacted` | Whether content was withheld or masked. |

### ContextEvent

Initial event kinds:

- `inject` — a known instruction or memory block was added.
- `compact` — native or portable compaction started, completed, or failed.
- `switch` — the conversation changed harness, model or connection.
- `handoff` — a Markdown handoff or native handoff was created.
- `fork` — a native or conversation fork was created.
- `child-create` — a child conversation or native subagent was created.
- `child-settle` — a child completed, failed or was stopped.

Events store timestamps, sequence coordinates, engine/model and net token
change when known. They do not store a second copy of the content.

### DelegationPacket

A bounded, engine-neutral packet passed from a parent to a child:

```json
{
  "version": 1,
  "parentConversationId": "conv_...",
  "parentSeq": 42,
  "goal": "Review the migration without editing files.",
  "constraints": ["Do not modify the repository.", "Report exact paths."],
  "decisions": ["The router remains the source of truth."],
  "workspace": "/path/to/workspace",
  "files": ["src/engines/shared-conversations.js"],
  "openTasks": ["Check the compaction fallback."],
  "evidence": [
    { "conversationId": "conv_...", "seq": 18, "label": "Earlier decision" }
  ]
}
```

The packet is quoted historical data. The child must treat it as context, not
as new authority. The current user request always wins.

### Settlement

A child returns a bounded settlement instead of its entire transcript:

```json
{
  "status": "completed",
  "summary": "Reviewed the fallback; no files changed.",
  "results": ["The context path is bounded."],
  "filesChanged": [],
  "tests": ["node --test tests/context-capacity.test.js"],
  "openIssues": ["Native prompt composition remains opaque."],
  "nextSteps": ["Add the context snapshot endpoint."],
  "evidence": [{ "conversationId": "child_...", "seq": 7 }]
}
```

The parent can open the full child conversation through the existing
`camellia_conversation_history` tool. The settlement is the default object shown
in the parent and work panel.

## Phase 0: contract and scaffolding

### Work

- Add a pure `context-ledger` module that normalizes existing history rows into
  categories, role/kind, coordinates and token estimates.
- Add a single `ContextCapabilities` map per engine: usage reporting, cache
  reporting, visible system prompt, visible tool schemas, subagent events,
  native compaction and native child lineage.
- Add `context-snapshot`, `context-node` and `context-events` actions to
  `SharedConversations.command()`.
- Add a feature preference, default off for the first preview build.
- Add redaction helpers for secrets, tokens, authorization headers and known
  credential-shaped values.

### Boundaries

- No transcript schema change.
- No model request change.
- No compaction change.
- Every snapshot must be derivable from existing data or explicitly marked
  unknown.

### Acceptance

- A long conversation can produce a summary snapshot without loading every
  message body.
- Every category has an accounting status.
- A native engine with no exposed system prompt reports an
  `engine-managed` residual instead of inventing categories.

## Phase 1: Context Browser

### Phase 1A: current and historical composition

Backend:

- `context-snapshot` accepts `sessionId`, optional `turnSeq`, optional
  `before`, and a bounded page.
- Build categories from existing `ConversationHistory` projections.
- Use provider usage when available; otherwise use the existing token estimator
  and label it `estimated`.
- Derive `engine-managed` as `max(0, reported total - known accounted tokens)`.
- Read only index metadata and bounded row projections for the summary.
- Read a row body only when `context-node` requests one node.

UI:

- The existing context ring opens a compact popover for the latest request.
- A full Context panel opens from the ring and from the header.
- The panel shows pressure, category stack, turn/step selector, node list and
  context events.
- Each node expands on demand; the first page remains bounded.
- A `Compare` toggle shows category and token deltas against the previous
  request.
- `Observed`, `Estimated` and `Engine-managed` are visible labels, not tooltips
  hidden behind a question mark.

Events:

- Reuse existing compaction notices.
- Add bounded `context-observation` records only when a provider emits multiple
  usage updates per turn and the existing `lastCallUsage` is insufficient.
- Record model/connection switches, handoffs and forks at their existing
  transition points.

### Phase 1B: request timeline

- Add a bounded, append-only observation sidecar when required for per-step
  accounting.
- Keep only usage, timestamps, engine/model binding, sequence coordinates and
  token totals. Do not duplicate prompt or tool output bodies.
- Cap observations per conversation and compact old observation records by
  summary rather than silently deleting the transcript.

### API shape

```json
{
  "ok": true,
  "snapshot": {
    "version": 1,
    "conversationId": "conv_...",
    "engine": "codex",
    "model": "gpt-5.1-codex",
    "turnSeq": 12,
    "step": 3,
    "usage": {
      "inputTokens": 123456,
      "outputTokens": 4096,
      "cacheReadTokens": 98000,
      "contextWindow": 200000
    },
    "pressure": { "used": 127552, "cap": 200000, "pct": 63.8, "source": "usage" },
    "categories": [
      { "id": "conversation", "tokens": 42000, "status": "estimated" },
      { "id": "tool-results", "tokens": 61000, "status": "estimated" },
      { "id": "engine-managed", "tokens": 24552, "status": "opaque" }
    ],
    "nodes": [
      {
        "id": "n1",
        "category": "tool-results",
        "seq": 37,
        "kind": "tool-result",
        "tokens": 18200,
        "preview": "…",
        "observed": true,
        "expandable": true
      }
    ],
    "events": [],
    "warnings": ["The native harness does not expose its system prompt."]
  }
}
```

### Acceptance

- The Context panel opens without blocking the composer.
- The total is consistent with the existing context ring for the same request.
- The panel distinguishes reported usage from estimated composition.
- A node can be expanded to its exact stored content, with redaction and a size
  limit.
- The panel works for Claude, Codex, DSH, Kimi, Antigravity and Grok, with
  unknown fields explicitly labeled.
- A 100 MB-class conversation does not cause a full transcript parse on open.
- The panel can show the last successful compaction and its before/after token
  change.

## Phase 2: Agent Context

### Goal

Make child agents useful across a long-running workspace without copying the
parent transcript or pretending that native contexts are shared.

### Packet creation

- On `conversation_create`, generate a deterministic packet from the parent's
  current goal, constraints, recent decisions, changed files, open tasks and
  bounded evidence references.
- On `conversation_fork`, keep the existing fork prefix and add a packet only
  for the new task boundary; do not duplicate the copied prefix.
- Store the packet as optional child metadata, not as a hidden second
  transcript.
- Inject the packet once, as a quoted historical block, before the child's first
  user request. Do not re-inject it every turn.

### Settlement

- On successful completion, build a settlement from the child's final result,
  artifact list, tests and explicit structured result when available.
- On failure or cancellation, record the last known state and the reason.
- Show the settlement in the parent work panel and as a context event.
- Keep the full child conversation available through the existing read-only
  conversation-history tools.

### Agent graph

Unify three node kinds behind one read-only view:

- Native subagents reported by `NativeSubagents`.
- Managed child conversations reported by `subagent-conversations`.
- Harness switches and handoffs, represented as edges, not as new agents.

Edges:

- `delegate` — parent to native or managed child.
- `fork` — source conversation to fork.
- `handoff` — previous engine binding to the next binding.
- `settle` — child back to parent.

### UI

- Add an `Agents` tab or segmented panel beside the Context panel.
- Show a family graph with engine, model, status, context pressure when
  observed, start time, duration and result.
- Show a cross-agent timeline of create, send, approval, completion, failure,
  stop, fork and handoff events.
- Native subagents without observable context show `context: opaque`, not an
  invented percentage.
- Selecting a node opens the existing work-panel detail or child conversation.

### Boundaries

- Managed children remain in the same engine, connection and permission mode
  unless the conversation-tool contract is deliberately expanded later.
- The packet is engine-neutral, but v1 does not merge native sessions.
- No child may recursively control other conversations; existing limits remain.
- A child's write to memory is a proposal, never an automatic parent update.

### Acceptance

- Creating a child produces a visible packet with a bounded size.
- The child's first request contains the packet and no parent transcript copy.
- The child's completion produces a settlement visible in the parent.
- The parent can open the child transcript without the child becoming a second
  parent.
- The graph correctly distinguishes native opaque children from managed
  conversations.
- Existing child permissions, cancellation and depth limits remain unchanged.

## Phase 3: Reversible compaction

### Phase 3A: retrieval-only ledger

Borrow the identity discipline, not the proxy implementation:

- Record the source range (`fromSeq`, `toSeq`), summary file or summary text,
  model, engine and creation time for each portable compaction.
- Add `camellia_context_status`, `camellia_context_search` and
  `camellia_context_expand` tools through the existing MCP bridge.
- `search` searches compacted summaries and original transcript ranges.
- `expand` returns exact original rows for a range, bounded by a character cap;
  large expansions write a local file instead of inflating context.
- Mark every returned row as quoted historical data. Current user instructions
  win.

This phase does not change compaction prompts or the shape of the active
summary. It makes the existing lossy operation recoverable.

### Phase 3B: block ledger

When 3A is stable, add a `ContextBlock` record:

| Field | Meaning |
| --- | --- |
| `blockId` | Stable id within the conversation. |
| `fromSeq`, `toSeq` | Exact source range. |
| `summaryRef` | Compact summary file or inline reference. |
| `tier` | One, two or three for hierarchical summaries. |
| `parentBlockIds` | Blocks distilled into this block. |
| `originalTokens`, `summaryTokens` | Accounting inputs. |
| `active`, `retired` | Whether the summary is resident and whether it was explicitly retired. |
| `createdAt`, `createdBy` | Time and transport/model. |

Rules:

- Tool-call and tool-result pairs are atomic across a compaction boundary.
- The first user message is pinned and never replaced by a summary anchor.
- Retiring a block removes its summary from the resident view but keeps
  `expand` available.
- Rewriting a summary keeps one previous version for rollback.
- Stable ids and ranges survive model switches; message numbering is not reused.

### Native engines

- Do not claim wire-level compression.
- Expose retrieval tools where the harness supports MCP.
- Label expansion as retrieval, not as a change to the native context window.
- Keep native compaction as the first choice when its protocol confirms
  completion.

### Acceptance

- A compacted conversation can find a fact in an older range and recover the
  exact original rows.
- Expanding a large range produces a bounded response or a file link.
- Tool-call/result pairs are never split across a summary boundary.
- The first user message remains present after compaction.
- Rolling back a summary does not modify the original transcript.
- A native session with no retrieval support still works unchanged.

## Phase 4: Memory

### Shape

Reuse the existing user-selected global memory directory as the long-term
document source. Add a small, Camellia-managed hot-memory projection rather than
creating a competing memory root.

Initial layers:

- `working` — current goal, constraints, preferences needed every turn.
- `project` — workspace facts, decisions and conventions.
- `evidence` — durable references or facts retrieved on demand.

The first release should support explicit user-initiated writes and optional
user-confirmed capture. Automatic idle review and provider adapters are out of
scope.

### Turn pinning

- At the start of a turn, pin one bounded memory snapshot.
- The snapshot does not change during the turn.
- Superseded snapshots are retired after the accepted step, not by editing an
  old message in place.
- A child inherits the parent's pinned view for read-only context.
- A child write is a proposal that the parent or user can accept.

### Budget

- Reserve the majority of the memory projection budget for working memory.
- Expose project documents and durable evidence as search/recall routes.
- Cap recall result count, per-result characters and total characters.
- Do not inject the entire memory directory every turn.

### Safety

- Memory is quoted, fallible data, never executable authority.
- Current user instructions win.
- Secrets, credentials and transient tool output are not stored by default.
- Every write returns a receipt and a destination.
- The memory UI shows what was read and written for the turn.

### Acceptance

- A memory snapshot is pinned for a turn and cannot drift mid-turn.
- A child can read the parent's pinned view without copying it.
- The current user request overrides conflicting memory.
- Disabling memory leaves the conversation and transcript intact.
- No automatic write occurs without an explicit policy.

## Engine capability matrix

| Capability | API-routed request | Native subscription | Notes |
| --- | --- | --- | --- |
| Provider usage | Usually | Usually | Always label missing fields unknown. |
| Exact context window | Usually | Sometimes | Use existing capacity evidence. |
| Camellia-built prompt | Usually | No | Native CLI owns prompt assembly. |
| System prompt content | Partial | Usually no | Never invent a breakdown. |
| Tool schemas | Partial | Usually no | Mark engine-managed residual. |
| Cache read/write | Usually | Usually | Keep independent buckets. |
| Native compaction | Varies | Varies | Preserve existing native-first policy. |
| Native subagent events | Varies | Varies | Normalize only observed fields. |
| Managed child conversations | Yes | Yes | Same engine and permissions in v1. |
| Retrieval tools | Yes | Harness-dependent | MCP bridge only where available. |

## Storage and migration

### Phase 0 and Phase 1A

- No new persistent store.
- No transcript schema change.
- Read `ConversationHistory` projections and existing usage fields.

### Phase 1B and Phase 2

- Optional conversation metadata:
  - `contextPacket`
  - `settlement`
- Both are bounded and ignored by older builds.
- A missing field means the feature was not used, not that data was lost.

### Phase 3

- Optional append-only sidecar for observations and blocks.
- Never rewrite an existing summary or transcript during migration.
- A missing sidecar falls back to the current compaction behavior.
- Sidecar retention is bounded and auditable.

### Phase 4

- Memory remains opt-in.
- The existing global memory folder stays user-owned.
- Camellia-owned hot-memory files live in the existing application data area
  unless the user selects another supported location.
- Disabling memory does not delete stored data.

## API and IPC

Use the existing authenticated `conversation-command` bridge. No new renderer
preload surface is required for the first implementation.

Planned actions:

| Action | Purpose | Mutation |
| --- | --- | --- |
| `context-snapshot` | Summary and bounded category totals for a request. | Read-only |
| `context-node` | Exact content for one node, with redaction and paging. | Read-only |
| `context-events` | Bounded context event timeline. | Read-only |
| `agent-graph` | Parent/child/fork/handoff graph. | Read-only |
| `agent-detail` | One agent node and its settlement. | Read-only |
| `context-block` | Block metadata and source range. | Read-only |
| `context-search` | Search summaries and recoverable ranges. | Read-only |
| `context-expand` | Recover exact original rows or write them to a file. | Read-only |
| `context-retire` | Remove a block summary from the resident view. | Opt-in |
| `context-restore` | Restore a retired resident summary. | Opt-in |
| `context-rewrite` | Replace a summary with rollback retained. | Opt-in |

All reads require the current conversation id. Actions that can expose content
must enforce redaction, size limits and the same permission boundary as the
conversation itself.

## UI contract

### Entry points

- Context ring in the composer opens the latest request summary.
- A header Context button opens the full panel.
- Work panel links to the same panel for a selected turn or child.
- The Agents tab is available from the Context panel and from the work panel.

### Panel sections

1. Pressure header: used/cap, source, model, engine, cache hit rate when known.
2. Category stack: observed, estimated and opaque totals.
3. Turn/step selector: current, previous request and retained steps.
4. Node list: category, sequence, token cost, preview and expand.
5. Context events: inject, compact, switch, handoff, fork and child events.
6. Agents: family graph and cross-agent timeline.

### Behavior

- Render a skeleton with final dimensions before loading.
- Keep the first payload under the documented bounded size.
- Fetch node bodies only when expanded.
- Use pagination or an auto-load window for long lists.
- Release expanded bodies when the panel closes or the selection changes.
- Preserve keyboard focus and Escape-to-close behavior.
- Show an explicit empty or unsupported state for engines that cannot provide a
  field.

### Privacy

- Do not render authorization headers, API keys, cookies or secret command
  arguments.
- Redact before sending a node to the renderer.
- Do not index redacted content into new long-lived caches.
- Do not expose another conversation's body through a context node request.

## Performance budgets

Initial engineering budgets, to be measured and revised:

- Snapshot summary: at most 64 KiB.
- Categories: at most 12 per snapshot.
- Preview nodes: at most 100 per page.
- Node body: at most 8 KiB per response unless explicitly exported.
- Events: at most 100 per page.
- Agent graph: at most 128 nodes and 256 edges.
- No full JSONL parse for a snapshot or graph summary.
- Cache keys include the history signature and snapshot coordinates.
- Caches have a TTL, a size cap and immediate invalidation on transcript change.

## Testing

### Unit

- Category mapping and token accounting.
- Observed/estimated/opaque status.
- Redaction of credentials and sensitive command arguments.
- Context event ordering and coordinate mapping.
- Packet and settlement bounds.
- Block range mapping and tool-pair safety.

### Integration

- `context-snapshot` reads a long conversation without loading all bodies.
- `context-node` cannot read another conversation.
- Native and managed child graphs remain distinct.
- A child packet is injected once and is absent from the parent transcript.
- A settlement is persisted and visible after restart.
- Expanded original rows match the transcript byte-for-byte.
- Native compaction and portable compaction still pass existing tests.

### UI

- Context panel at narrow and wide widths.
- Light and dark themes and Chinese/English strings.
- Expand, collapse, pagination and close/reopen behavior.
- Unknown and error states for each engine.
- Keyboard navigation and focus return.
- No horizontal overflow at narrow widths.

### Regression

- Existing conversation send, compaction, handoff, fork and child limits.
- Existing mobile child pages and remote transcript previews.
- Headless server conversation commands.
- All six harness native smoke paths.

## Rollout and rollback

- Phase 1 is a feature preference, default off in preview.
- Phase 2 is opt-in for managed child creation; native subagents remain
  read-only.
- Phase 3A is read-only; Phase 3B actions are explicit Context-panel actions and
  refuse while the conversation is busy.
- Phase 4 is opt-in and can be disabled without changing the transcript.
- Hiding an entry point must not delete data.
- A failed snapshot or graph request must never prevent sending a message.
- If an engine's events are malformed, fall back to the last known summary and
  mark the snapshot partial.

## Acceptance ledger

| ID | Observable outcome | Phase |
| --- | --- | --- |
| C-01 | The Context panel shows request pressure and composition for an open conversation. | 1 |
| C-02 | Reported usage and estimated composition are visually distinct. | 1 |
| C-03 | A node expands to exact stored content with redaction. | 1 |
| C-04 | A long conversation opens without a full transcript parse. | 1 |
| C-05 | A compaction event shows its before/after effect. | 1 |
| A-01 | A managed child receives one bounded packet, not the parent transcript. | 2 |
| A-02 | A completed child produces a settlement visible in the parent. | 2 |
| A-03 | The graph distinguishes native opaque children from managed children. | 2 |
| R-01 | A compacted range is searchable and can be expanded to exact rows. | 3 |
| R-02 | Tool-call/result pairs and the first user message survive compaction invariants. | 3 |
| M-01 | A memory snapshot is pinned for a turn and inherited read-only by a child. | 4 |
| M-02 | Current user instructions override conflicting memory. | 4 |

## Open questions

- Which engines can expose tool schemas without parsing private runtime files?
- Should the first full browser persist exact per-request observations, or stay
  derived from existing `lastCallUsage` until a provider needs more?
- Should managed children eventually support a different engine, or remain
  same-engine until packet and retrieval semantics are proven?
- Should context node content be redacted before or after the history cache?
- How much memory should be visible in the Context panel versus the Memory
  panel?
- Which server and mobile surfaces need read-only snapshots in the first
  release?

## References

- dsh-context: https://github.com/bowenliang123/dsh-context
- billion-context: https://github.com/ranxianglei/billion-context
- dsh-mnemon: https://github.com/omdsh-dev/dsh-mnemon

The reviewed projects informed the patterns in this document. No plugin code or
DSH-specific UI is vendored into Camellia. `dsh-context` is Apache-2.0,
`dsh-mnemon` is MIT, and `billion-context` is MIT plus an attribution term; any
future code reuse must comply with the applicable license.
