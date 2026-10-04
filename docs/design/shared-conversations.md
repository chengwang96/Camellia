# Shared conversations and harness switching

As of 2026-10-02, six desktop harnesses share a conversation list, workspace structure, composer layout, and public transcript. A seventh navigation entry opens **Agent discussions**; discussions keep separate groups, member histories, and drafts. Switching pages does not convert a group into an ordinary conversation or invoke a model.

## Switching behavior

| Choice | Behavior | Cost or limit |
| --- | --- | --- |
| Direct continuation | The target harness receives public turns it has not yet seen and may resume its own native binding when returning. | Longer history can increase input usage; another engine's private state is not transferred. |
| Markdown handoff | The source harness writes a summary file, then the target starts a new native session with that file. | An extra request uses time and tokens; a summary can omit detail. |

Direct is the default. General settings can enable a switch warning, show origin labels, or prefer Markdown. **Switch options** can override one transition. Busy turns, an active Goal, or a handoff block switching that conversation until settled; other conversations can continue. A stopped or failed handoff leaves the source conversation available. Neither choice is guaranteed to equal staying on one engine.

The logical conversation keeps its title, workspace, archive state, and public messages. Model, connection/account, permission, reasoning, and native state follow their own engine and binding rules; one-time approvals never transfer. API routes keep the selected model ID and warn when it has no configured route instead of silently changing it. Draft text, unsent attachments, and reading position are keyed by conversation in Chromium storage, while the public transcript and bindings live under `userData/conversations/`. The working directory is fixed when a conversation is created. An attachment still needs to exist and be supported by the target engine.

Each engine has its own native ID and synchronized sequence cursor. New public text and relevant tool results are appended to Camellia's JSONL transcript. Direct continuation replays only the missing public part and instructs the target not to re-execute old tools. Very long histories require an explicit handoff rather than silent truncation. A Markdown file is saved before switching; a failed target start restores the previous mapping. The logical list does not scan arbitrary personal CLI histories.

The **Global memory** setting points to a user-chosen folder. Ordinary turns receive its entry path and may read relevant index and memory files under existing tool permissions; Camellia does not inject every file into every prompt. Clearing the setting stops future references, although text already read may remain in native history. The app does not manage that folder's layout or Git synchronization.

## Recovery and compaction

On reopening, a snapshot restores history and active state before newer events are applied. Stop and approval actions bind to the current logical conversation, run, and request. On restart, unfinished requests become interrupted and are not automatically resent. Multiple conversations in the same workspace still share the same disk files, and provider concurrency remains shared.

Native compaction is preferred where its protocol confirms completion: Codex uses `thread/compact/start`, Claude uses its native compact boundary, and Kimi uses its advertised ACP command with completion detection. DSH ACP and unverified Antigravity manual paths use a portable summary. Native automatic compaction remains owned by the engine. A portable summary is required for cross-engine handoff, a new native thread, or history the target has never seen; a native engine's internal summary is not passed off as portable Markdown.

When a known input window or Codex's separate per-turn character limit is approached, Camellia can summarize older public turns while keeping recent interactions. A summary is only committed after successful completion, with bounded retries after an explicit context overflow. Network, auth, or provider failures are reported instead of silently starting a second paid channel. Learned conservative budgets are scoped to engine, connection, model, route set, and conversation, and cannot raise a published model limit. Summaries can lose detail; they are not a verbatim archive. See [context capacity](context-capacity.md) for implementation budgets and [model binding segments](model-switch-segments.md) for parked native sessions.

Regression entry points include `tests/shared-conversations.test.js` and `tests/shared-chat-ui.py`; real API quality and cost across handoff styles require separate experiments.
