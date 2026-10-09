# Agent discussion implementation and acceptance record

Updated 2026-10-08. The original v1 gate below was drafted for a Windows text-only group. Later user decisions expanded the delivered beta to six harnesses, existing subscriptions and APIs, native tools, files, identity prompts, Android control, and macOS hosting. Do not apply the old “no tools or attachments” gate to the current feature. This is a development record, not a claim that every provider, long-context path, and physical-device network has been accepted.

## Delivered integration

- Desktop home has a 2×2 tools grid: Agent discussions, Benchmark, Server connections, and Settings. Ordinary chats and discussions share a seven-entry navigation menu while retaining separate histories and drafts.
- Members can use Claude Code, Codex CLI, DSH, Kimi Code, Antigravity, and Pi through currently configured API routes. Codex, Kimi, and Antigravity also reuse supported subscription sign-ins. API members select a **provider and model**, not an individual key; the router can rotate keys within that provider, while the member binding does not silently change providers.
- Groups can be created, renamed, pinned, and deleted; a member can have an identity prompt. Structured mentions select one or more responders, with parallel/serial mode, streaming replies, stop, retry, and serial-failure handling.
- The native-tools path uses the corresponding ordinary-chat transport and permissions. The discussion UI shares attachment, tool card, question/approval, and file preview components. A group has a managed work directory and can pass real generated files between members. [Rich interaction](group-chat-rich-interaction-plan.md) records tested bindings and input limits.
- An all-access paired Android device can manage and participate in discussion groups when the Windows or macOS host advertises the discussion capabilities. Ordinary conversation and group records remain separate. See [remote access](../remote-access.md).
- macOS uses a packaged Unix process supervisor for launch, stop, and independent recovery. All six production adapters register on macOS; focused service/ownership tests, ARM64 cross-compilation, and eight native Unix lifecycle/driver tests passed on the Windows/Linux development host. macOS CI now covers the source and packaged helper and a real Codex loopback discussion workflow. Those CI steps and a Mac end-to-end session still require native macOS execution; cross-compilation and Linux results do not establish Mac acceptance. See [desktop discussion development](../development.md#agent-discussions-on-desktop).

## Acceptance ledger

These eight checks preserve the intent of the original release review. Evidence is scoped to the tested build and connection; “local fixture” does not mean “live provider.” The tools/files expansion adds its own checks in the rich-interaction record.

| ID | Observable outcome | Status at this record |
| --- | --- | --- |
| V1-01 | Enter from home, create a group, add up to four members, reject a fifth, use structured mentions; no responder means no model call. | Desktop Electron/IPC and layout checks passed with response fixtures. |
| V1-02 | Configured API and supported subscriptions send, continue, and stop on the selected binding. | Six API harnesses and three subscription paths have individual real-response evidence; all provider/account combinations were not exhausted. |
| V1-03 | Same-binding members stay independent; parallel/serial delivery has no cross-talk or duplicate result. | Two-member serial and continuation checks passed per tested path; complete mixed-path evidence remained open. |
| V1-04 | Long text, summarization, new-member context, cancellation, and native rebuild preserve the intended public context. | Long-context and subscription-only summary acceptance remained open. |
| V1-05 | Tool and permission behavior matches the selected actual native path and group policy. | Native tools and approvals were later enabled and tested for representative paths; the original tool-free wording is superseded. |
| V1-06 | Stop and restart handle preparation, active replies, queues, and late events without automatic side-effect replay. | Live stop and local process-tree checks passed; abnormal-exit and summary lifecycle coverage remained open. |
| V1-07 | History, attribution, results, and cursors persist together; cleanup preserves referenced state. | Completed-round desktop restart passed; in-flight and summary recovery remained open. |
| V1-08 | Ordinary chat, benchmark, server, settings, and unsupported-path errors remain sound. | Focused desktop/IPC regression passed; full release regression remained open. |

## Decision history and boundaries

The first frozen scope allowed only Codex and Antigravity text discussion; it was expanded to six harnesses and supported subscription/API combinations. The first implementation used an empty production adapter registry and fake model replies as a UI skeleton; later production binding checks and native sends replaced that state. Early Antigravity CLI “tool-free” assumptions were withdrawn because the native CLI still exposed metadata/extension surfaces. A later authorized native-tools phase deliberately replaced the text-only policy, so the relevant gate became real permission and tool-event routing rather than absence of all tools.

Normal shared conversations and discussion groups still do not merge workspaces or transcripts. Adding a seventh navigation entry does not import history or add a group member. Subscription credentials stay with the native account service; a member receives only the selected account binding. API-provider selection does not expose or pin a specific key. Changing a member identity or binding must rebuild that member's future context without changing past public messages.

For further work, choose an observable acceptance item above or a concrete rich-interaction boundary, collect evidence at the real UI/native layer when needed, and distinguish local fixtures from live provider behavior. Physical phone Tailnet, Wi-Fi/cellular handoff, macOS discussion hosting, and long-term background behavior have not been established by desktop or emulator fixtures.
