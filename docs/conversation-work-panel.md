# Conversation work panel and subtasks

Implemented on 2026-10-09 from the deferred conversation issues. Pricing details are in [Configuration](configuration.md); mobile transport and authorization are in [Remote access](remote-access.md).

## Desktop

The conversation header has an actions button and a work-panel button. The actions menu sizes to its short labels instead of taking a fixed 300-pixel width. The manually opened floating work panel is 400 pixels wide, adapts to the viewport and wrapped header, and groups subtasks and artifacts. Its total height, including the header and task controls, never exceeds half the conversation pane height. Longer content scrolls below the fixed header, while the selected task's stop control stays in the footer. Pending child requests add a badge without opening the panel. Closing it leaves every run active. No Git section appears until Git management exists.

Codex task names come from the native thread: an explicit thread name takes precedence over its agent nickname (such as Nash), then its role. When no name is supplied, the shared task record falls back to the first line of its goal. The work panel preserves these names and shows the engine, status and task progress separately. Completed previews prefer the result; a task without reported progress has an explicit empty state. Task history expansion, group expansion, reading position, keyboard focus and input drafts survive live updates.

Tasks show their actual state: ready, preparing, running, waiting, completed, failed, stopped, or unavailable. Open a task to see its goal, latest progress, result, pending requests and execution history. Replies, approvals and stop buttons target the displayed task and carry the task's current turn identity. Artifact rows name the main conversation or the child that produced them and use the existing file resolver and preview.

A subtask card also appears below its initiating user turn. Active tasks initially expand and completed tasks initially collapse. Manual expansion is preserved while progress changes. Attention counts remain visible when collapsed. The main assistant reply retains the final combined answer.

## Mobile

Android and iOS show compact cards below the initiating turn, with at most three preview rows and a link to the full list. A child opens its own page with goal, progress, result, approvals, supported reply/stop controls and expandable execution history. The parent view stays mounted, so returning preserves its draft and reading position. Children keep updating while the page is open. A pending request remains visible even if the turn card is collapsed.

When the initiating turn is outside the loaded history page, an earlier-turn card keeps active or actionable children reachable. Loading the turn moves its card back into the transcript. Task selection and drafts use both the engine and native task ID, preventing collisions between engines. Child controls are disabled while disconnected or while another command awaits confirmation. A desktop restart discards the old child page; access failures remove child content and cached controls while preserving the parent draft.

Desktop updates preserve full transcript frames for clients that do not request incremental history. Clients receiving state-only frames apply live output, approvals, child state, queue revisions and automation without clearing unchanged history. iOS treats child transitions as ordered events during snapshot coalescing and counts child details toward its prefetch cache budget.

## Engine support

| Source | State and history | Child controls |
| --- | --- | --- |
| Native Codex collaboration | Thread/activity notifications plus bounded child thread reads, including a final read after completion. Nested children keep the initiating turn. | Direct input only when the native thread permits it; original child approvals and child-turn interruption. |
| Native Claude tasks | CLI lifecycle events, background-task snapshots, Agent/Task call receipts and child-attributed events. Native IDs merge snapshot and call records into one card. Shell jobs are not presented as agents. | Original child approvals and acknowledged `stop_task`; no direct child reply API in the current CLI stdio protocol. |
| Native DSH subagents | An observation-only plugin reads the bundled 0.2 lifecycle and committed child session events inside DSH. It preserves each native child and parent identity, including background completion. | Display only; no synthetic reply or stop control. |
| Native Kimi agents and AgentSwarm | Native tool calls supply initial cards. Bounded incremental reads of the current session's durable journals provide child lifecycle, committed progress and late background results. Swarm entries remain separate, and completed results cannot regress when older journal events arrive. Readers never modify the registry or take its write lease. | Display only unless the native permission channel supplies an attributable original request. |
| Native Grok subagents | The native `_x.ai/session_notification` channel supplies spawn and terminal events. Owned child-session streams supply progress and history independently of the main turn. | Original child permission requests; unsupported direct input and stop controls remain hidden. |
| Native Antigravity SDK | Batched `start_subagent` calls create separate cards; step hooks identify the actual child trajectories and report their terminal responses. Configured SDK subagent definitions pass through to the native SDK. | Attributed original child approvals; no synthetic direct input or stop control. |
| Native Antigravity subscription CLI | The authenticated local trajectory interface supplies owned child status, progress, results and tool history. Child output stays separate from the main answer. | Original child interactions and child-scoped cancellation; the main trajectory is never used as a substitute for a child stop. |
| Camellia conversation tools | Independent child conversation state, own transcript after the copied prefix, result and artifacts. Creation alone shows ready. | Reply to an idle child; answer that child's original approval; cancel that child only. Available across the shared engines exposing these tools. |

Disconnected native tasks retain their recorded history and result but lose live controls. The idle reaper keeps an engine alive while native children are running or awaiting input. Tool-created children retain their existing independent conversation lifetime. Remote access also checks each managed child's workspace scope.

Protocol checks used the schemas generated by the bundled Codex CLI 0.160.1. Claude's child approval routing and task controls match the official [Python SDK query transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py) and [TypeScript SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md); the application retains its existing CLI transport.

The 2026-10-29 adapters were checked against the bundled Claude 2.1.291, DSH 0.2.0-rc.2, Kimi 2.1.1, Grok 1.0.70 and Antigravity SDK 0.1.20. `npm run test:subagents` executes the installed harnesses against a loopback model fixture with isolated homes and dummy credentials. Add `-- --background` for background completion, or run `node tests/native-subagents-smoke.cjs kimi antigravity --swarm` for batched children. The renderer check `python tests/work-panel-ui.py` covers transcript cards and the work panel for all six engines, including equal native IDs across engines. These checks do not need paid model access. Native subscription authentication remains outside the loopback fixture; Antigravity CLI trajectory and interaction handling has separate protocol tests.

## Fork and pricing behavior

An active fork excludes the complete current turn: user prompt, steering, partial assistant output and tool rows. It snapshots completed history and uses a native event or turn boundary where available, keeping the shared-history fallback when a safe native cut is unavailable. The source run remains active. Desktop actions, Android/iOS remote controls and Camellia's own conversation-fork tool use the same boundary. Forks share the filesystem. See [native editing and forks](design/native-conversation-history.md) for runtime support and verification.

The bundled subscription price catalog includes `gpt-6.1-sol`. Desktop refreshes run daily or manually from Usage, persist a validated local cache and keep the last good catalog after errors. New eligible unpriced requests can be valued once a model rate becomes available; already priced requests and legacy aggregate unknown usage are preserved.

## Validation

Automated engine and remote tests cover actual lifecycle events, nested child attribution, terminal child reads, approval identity, independent child controls, workspace authorization, fork boundaries, price refresh/cache failure and one-time repricing. Renderer checks cover light/dark panels, artifact attribution, badges, child input, turn cards, menu size, filters and manual price refresh. Android instrumentation checks the child page, action scope, drafts and scroll position; release checks exercise the obfuscated APK.

iOS sources and protocol fixtures are included, but Windows has no Xcode/Swift toolchain or native iPhone simulator. Native iOS compilation and navigation acceptance remain for the MacBook. Existing live desktop processes must be fully restarted when their work is finished to load these source changes.

The 2026-10-09 run passed 2,307 JavaScript regression cases outside the blocked headless test file, renderer checks, Android unit tests and lint, the Android gateway integration, two subtask page checks and four signed-release checks. Build 89 was installed over signed build 88 with encrypted data and drafts preserved. The full suite is not entirely green: the headless shutdown test stalls and the trusted-device startup-error test fails. Both reproduce in the saved pre-change workspace; the separately bounded current headless run passed its other 13 cases. These existing server issues remain outside this deferred-item change.

The follow-up mobile compatibility audit passed 101 focused desktop protocol cases, 180 Android unit tests, Android debug/release lint, 12 Android page/recovery/composer checks, the actual Android-to-desktop gateway check, and four signed-release checks after upgrading build 89 to build 90. It covers incremental snapshots, stale receipts, restarts and lost access, child identity, unloaded initiating turns, separate drafts and controls, and legacy gateway behavior. One emulator exit interrupted an initial run; the isolated device was restarted and the completed checks above passed. A fixed-delay coalescing fixture was changed to a bounded condition wait. The additional iOS protocol fixtures remain unexecuted until the MacBook check.
