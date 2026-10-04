# Archived Claude Code GUI feature plan

This is an early plan, based on a local Claude Code 2.1.218 build and the former DSH web UI. Persistent sessions, workspace navigation, progress display, tasks, and Goal mode later gained implementation; use the [development guide](../development.md) and current code for behavior. The notes below explain the original design rationale rather than prescribe today's protocol.

## Progress display

The planned UI inferred a status from native stream events: `system/init` meant ready; `message_start` meant a reply had begun; thinking and text deltas distinguished reasoning from visible output; `tool_use` and subsequent results identified preparation and execution; `result` ended the turn. A duration badge would appear after about 15 seconds rather than flashing a timer immediately. Tool descriptions or commands could provide a short action label. The active status belonged above the current assistant turn, while finished tool cards remained in the message stream.

## Tasks and todo state

The early Claude integration needed to observe both `TodoWrite` (a full, last-write-wins list) and the newer `TaskCreate`/`TaskUpdate`/`TaskList` family. Incremental JSON arguments should be parsed only after a complete tool input, then reconciled against the final canonical event. A compact panel could summarize completed, active, and pending items without replacing the original tool cards. Task state belonged to the current session, not a global project list.

## Goal mode

Claude CLI did not expose DSH's automatic Goal loop. The proposal was to keep Goal state and continuation scheduling in Camellia's application layer, with an objective, phase, elapsed time, round count, pause/resume controls, and explicit completion or blocking. This was a design sketch, not an instruction to use a textual `<goal:complete>` marker as current authority. Current Goal creation and completion follow the app's authenticated tools, current user authorization, and independent completion verification. Plan mode and Goal mode have different purposes and were not intended to become the same switch.

## Earlier protocol candidates

The plan also called for robust stream-JSON decoding, permission correlation, cancellation, saved sessions, and state recovery. Those items were to be implemented in stages with fixture events before live CLI testing. This archive intentionally does not claim which of its exact historical UI labels or transport details still match the current application.
