# Subtask lifecycle status audit

Checked on HP, 2026-11-16 (Asia/Hong_Kong). This audit follows the report that a finished parent reply still showed a native child as running on Android.

## Scope

Reviewed Claude Code, Codex, DSH, Kimi, Antigravity SDK/CLI and Grok lifecycle adapters; shared native and managed conversation projections; desktop task cards; Android snapshot application; and iOS transcript/coalescing/card code. Coverage includes launch receipts, independent background completion, nested children, forks, approval races, retired turns, polling failures, process replacement, reconnects and persistence.

## Confirmed problems and fixes

| Area | Trigger and previous behavior | Fix |
| --- | --- | --- |
| DSH launch configuration | Desktop supplied an executable path without a version. Configuration inferred the version but child lifecycle registration did not, leaving only a launch receipt marked running. | Resolve the version once for both launch configuration and lifecycle support. Retain the legacy tool-based path for old runtimes. |
| DSH fork routing | Traversing every parent session followed an ordinary fork's historical lineage and sent child events to the source conversation instead of the active fork. | Traverse only native subagent ancestors. Stop at the ordinary ACP conversation. |
| DSH progress and replay | The current user-message payload stores content directly; its goal/title were omitted. Replaying the same activation start could also reset a terminal record. | Read the current payload shape with the older shape as a fallback; ignore duplicate starts for the same activation. |
| DSH native history compatibility | The 0.2.2 fork bridge still called the removed `initialSelection`/controller installation API and the old `AcpSession` constructor. A real fork failed before running its child. | Use the 0.2.2 Agent-owned model selection and session constructor, while retaining the 0.2.1 adapter. |
| Antigravity SDK identity | The native tool was named `invoke_subagent`, but child specifications were recorded only for `start_subagent`. One real child therefore produced a completed native card and a separate tool card stuck running. | Record specifications for both aliases before publishing the tool event. Bind native trajectories to the original call and batch slot. |
| Child approval lifecycle | ACP, Claude and Codex could retain pending approval handles after a child ended. Old responses or late permission requests could put finished work back into waiting/running. Codex polling also prioritized obsolete approvals over completion. | Clear terminal child approvals and invalidate their handles; reject late requests from ended children. Native terminal evidence takes precedence over waiting metadata. |
| Codex retired turns | An old completion, duplicate startup or persisted snapshot could change the current child turn back to an earlier turn or revive a completed turn. | Fence native completions by turn ID, remember a bounded set of retired turns and reject retired snapshots/startups. Preserve verified completion against a lagging in-progress read of the same turn. |
| Codex status reads | Failed reads and `notLoaded`/`systemError` thread snapshots could preserve a stale running state and stop controls. | Show unavailable when live status cannot be verified, disable live controls and retain read retries for read failures. A successful read can recover the real result without starting a model turn. Ignore reads finishing after process shutdown. |
| Grok disconnection | The subclass handled child notifications before the ACP dead-process guard, so late events could revive disconnected children or create new live cards. | Reject incoming messages at the subclass boundary once its process is dead. |
| Shared native ownership | A replaced/released process could remain in the child registry when its final notification was suppressed, leaving live cards and controls. | Check the current session pool owner when projecting tasks and accepting events. Disconnected tasks become unavailable and cannot operate a replacement process. |

## Verification

The new boundary tests reproduced the problems before the corresponding fixes. In addition to protocol tests, installed harnesses were exercised against isolated loopback model fixtures; these tests did not use paid models or change account configuration.

| Check | Result |
| --- | --- |
| Full Node suite | 3,305 passed, 14 skipped, 0 failed (`build/subtask-audit-all-final.log`). |
| Final affected-area regression after the last Codex/history changes | 830 passed, 0 skipped/failed (`build/subtask-audit-final-regressions.log`). Includes native history/fork, lifecycle adapters, approval races, shared persistence and mobile snapshot tests. |
| Native foreground and background children | Claude, DSH desktop-style launch, Kimi, Grok and Antigravity SDK passed (`build/subtask-audit-native-fixed.log`, `build/subtask-audit-background-fixed.log`). |
| DSH ordinary native fork followed by a real child | Passed (`build/subtask-audit-dsh-fork-final.log`). |
| Antigravity SDK batch | Two distinct children completed with two cards. Covered by `node tests/native-subagents-smoke.cjs antigravity --swarm`; out-of-order slot binding also has a Python fixture. |
| Native dropped-notification reconciliation | Claude and Kimi recovered through native reads without additional model calls (`build/subtask-audit-reconcile.log`). |
| Kimi disabled swarm | Correctly rejected the operation and settled all attempted child cards as failed (`build/subtask-audit-swarm-off.log`). The initial batch smoke expected execution in a fresh profile where swarm is disabled; it was a fixture precondition failure, not an additional status bug. Enabled Kimi swarm execution was not established by that run. |
| Codex installed runtime | General native patch/tools, approvals/questions, resume, fork, cancel, failover, metering and isolation smoke passed (`build/subtask-audit-codex-native.log`). Child race/status coverage uses protocol fixtures; this was not a live Codex child-spawn test. The installed app-server schema was also checked for its actual turn/thread status values. |
| Mobile update semantics | Remote snapshot tests verify that completion/result changes are delivered without requiring a parent transcript change. Android applies subagent metadata independently of history pages; iOS includes it in coalescing equality and rejects regressing cursors. |

Useful commands:

```text
npm test
node tests/native-subagents-smoke.cjs claude dsh kimi grok antigravity --desktop
node tests/native-subagents-smoke.cjs claude dsh kimi grok antigravity --desktop --background
node tests/native-subagents-smoke.cjs dsh --desktop --fork
node tests/native-subagents-smoke.cjs antigravity --swarm
node tests/native-subagents-smoke.cjs kimi --swarm-off
node tests/native-subagents-smoke.cjs claude kimi --background --reconcile
node tests/codex-smoke.cjs
```

## Deployment and limits

These changes are in the desktop/backend sources; loading them requires a desktop restart. No phone package change is required for this fix. Historical records that lack terminal evidence remain unavailable rather than being assigned an invented success.

Android/iOS presentation was inspected at source level and covered at the backend protocol boundary. This audit did not perform physical-phone acceptance, Android instrumentation, an iOS build, real subscription-account child execution, or enabled native Kimi swarm execution. Existing unrelated workspace changes were not part of this audit.
