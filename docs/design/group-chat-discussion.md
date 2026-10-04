# Agent discussions: members, context, and workspace control

This design began with a text-only Windows scope frozen on 2026-10-02. Later authorized work added **all six configured harnesses, existing API and subscription paths, native tools, attachments, approvals, artifacts, and Android remote discussion controls**. The old restrictions against general tools and files are historical; they are not a description of the current beta. See [implementation status](group-chat-implementation-plan.md) and [rich interaction](group-chat-rich-interaction-plan.md).

## User model

A group has a public transcript and up to four active members. Each member has a stable ID, display name, engine, configured provider or subscription binding, model, reasoning setting, optional identity prompt, and independent native context. Two members can use the same model without sharing a native thread. Adding a member saves its configuration; the first selected send verifies its connection. Member removal stops queued and active work while preserving the historical attribution of its messages.

The user chooses which members reply, in parallel or in list order. A message with no selected respondent is saved without invoking a model. Serial mode gives each later member the prior completed answers. In parallel mode all members receive the same public input boundary; a model mentioning another member does not start that member automatically. Group records, work directory, and drafts remain separate from ordinary shared conversations even though navigation and visual components are reused.

## Coordinator and records

The main-process discussion coordinator owns the public log and delegates one native session per member. It does not rely on one member calling another through MCP. Its durable records include a group, participant, member session, public message, delivery request/result, summary, and workspace lease. A delivery identifies its member, native generation, input-through sequence, settings snapshot, and result. Public text is append-only in logical order; the snapshot is atomically written so a reply, completion state, and cursor do not diverge after a crash.

The coordinator binds account, route, model, identity prompt, native ID, run, and permissions at launch. It rejects a continuation if a recorded native history belongs to another member or ordinary conversation. Approved tool questions are bound to one delivery and fingerprint. Stopping a reply or changing a member never lets a late approval apply to a successor. A restart displays committed answers and marks unresolved work interrupted; it does not automatically repeat a file write or external call.

## Context and files

Each member budgets context independently. A new member receives relevant public history, not another member's hidden reasoning or identity prompt. When a member has missed public turns, the coordinator sends a bounded incremental slice or a summary plus recent original turns. Summary coverage must identify the source sequence and preserve disagreement and actionable conclusions; a failed or partial summary cannot advance the cursor. Long-context summary and recovery remain separate acceptance work from the delivered native-tools path.

The current discussion feature has its own work directory and managed attachment copies. Native tools run with the selected harness's actual permissions. Work that can modify the shared group directory is serialized; a later member may see files created by an earlier one even when answer selection was parallel. The UI should make this visible. An attachment preview does not prove the model ingested that format; capability checks must follow the selected model and native transport. Generated files and tools belong to the member/delivery that produced them. Stopping does not roll back a write already made.

Managed assets carry ownership and content checks so deleting a group cannot delete user source files or unrelated workspace products. Cleanup must re-read the group and launch journals at confirmation time, preserving active/retired member histories, summaries, and referenced assets. A storage scan that changes or cannot be read must fail closed.

Goal, scheduled-task, and conversation-control creation continue to require an actual current user request. A member's role prompt, another member's reply, or a quoted instruction in group history is not authorization to start automation or a child conversation.
