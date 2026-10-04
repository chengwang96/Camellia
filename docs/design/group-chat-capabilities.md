# Agent discussion capability and isolation record

This file records the early P0/P2 capability audit. Its original tool-free release gate was superseded on 2026-10-02 when the user authorized native tools and attachments. For current delivered interaction, see [rich interaction](group-chat-rich-interaction-plan.md); for remaining acceptance work, see the [implementation record](group-chat-implementation-plan.md).

## Binding and ownership principles retained

- A discussion member is identified by a stable member ID, not merely by engine/model. Two members with the same binding retain separate native histories.
- A binding fixes engine, connection, provider or subscription account, model, and relevant runtime/adapter version. Changing an identity prompt changes the member's future context; it does not grant a new tool permission.
- A public discussion transcript, a member's private native session, a delivery request, and an underlying native-history storage identity are different records. A pooled process slot is not proof that an old history is free to reuse.
- Concurrent or resumed work needs a delivery ID, process generation, run ID, and bounded event cursor. Late events and approvals must not attach to a later run.
- Native sources must be inventoried conservatively. A corrupt, linked, changing, incomplete, or unknown inventory is not an empty inventory. Ordinary single-chat paths must reject discussion-owned native IDs and histories, including removed/retired members.

The earlier probes covered six harness API paths and the subscription paths already supported by ordinary chat. Codex's sandbox or plan mode, Kimi ACP naming, DSH's read-only preset, Pi's ask/auto/full modes, and Antigravity CLI deny rules could not by themselves prove a universal tool-free sandbox. Antigravity's CLI still exposed some built-in metadata tools and could load configuration or extensions. The old assertion that `deny=["*"]` made it completely tool-free was withdrawn. A Windows Job can prove process-tree termination, but cannot make a filesystem read-only or prevent an external side effect. These were reasons to validate each actual execution path, not to infer safety from a label.

## Storage and recovery evidence

The discussion snapshot format is versioned and atomically committed. It validates relationships among groups, members, sessions, deliveries, messages, sequence cursors, and settlements. A retry of a completed request reads the saved result without rewriting it. Restart marks unfinished work interrupted rather than blindly replaying it. The read/write boundary was 32 MiB in the early text-only format; later attachments have their own managed files and limits.

Codex inventory examines native indexes and rollout metadata, including archived, unnamed, and child sessions, not only rows visible in an import UI. Antigravity inventory must distinguish bridge ID, storage directory, and underlying conversation ID because two bridge IDs may point at the same native history. SQLite/WAL inspection uses bounded, read-only copies. A missing database does not release an already known owner. Windows launch journals and close markers retain identity across crashes; they are not themselves proof of complete stop.

The application adapter registry is configured by the trusted main process and admits a binding only after its required version and execution evidence. Local fake-model probes demonstrate mechanics but cannot substitute for live subscription/account behavior. Consult the current code and runtime-specific tests before relying on an old P0 conclusion.
