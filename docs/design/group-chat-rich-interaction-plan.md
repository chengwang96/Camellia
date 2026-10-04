# Agent discussion identity, tools, and input

Updated 2026-10-02. The native-tools and attachment path described here is integrated, with representative local and live binding tests. A short connection verification only proves that the selected model can answer a text probe; it does not prove every tool, plugin, image format, or provider endpoint works.

## Delivered behavior

- Six harnesses reuse their ordinary-chat native transport, configuration, account binding, and permission mapping. Members keep independent native histories. A former text-only member rebuilds its own context when first using the tool-capable path; public group history remains.
- An optional member identity prompt is limited to 4,096 characters and is snapshotted per delivery. Editing it affects only future replies from that member, does not change tool permission, and rebuilds that member's native context. An empty prompt uses the default identity.
- Discussion and ordinary chat share attachment selection, drag/drop, screenshot paste, long-paste conversion, drafts, tool cards, questions, approval controls, and file previews. A group keeps independent managed attachment copies with SHA-256 and ownership checks.
- A desktop discussion message can attach up to 16 files, with a 32 MiB individual file limit and 128 MiB aggregate managed-file limit; at most 256 native attachment references are carried across turns. The Android remote transport imposes smaller upload limits described in the [Android guide](../../android/README.md).
- Native approvals route by member, delivery, run, and request. The UI supports one-time allow/deny and supported question inputs; stopping or restarting invalidates an unanswered old request. Tool activity is saved under the member reply. Generated artifacts can be previewed and read by a later member through real tools.
- Members share a group working directory. Tool work that may write is serialized even if responders were selected in parallel; public input is fixed at send time, but later tools may see earlier file writes. Stopping a run does not roll back side effects already performed.

## Evidence and limits

Representative live API tests used a configured DeepSeek `deepseek-flash` route with all six harnesses for attachment read, file write/readback, another member's read, tool records, and process drain. Codex subscription `gpt-6-astra`, Kimi subscription `kimi-code/kimi-for-coding`, and Antigravity subscription `gemini-3.8-flash` were tested on their supported paths; image input was checked separately for those subscription transports. Antigravity's interactive local CLI path returned a real write approval to the same cascade/trajectory/step, then another member read the file. These observations do not validate every provider, model, user MCP server, or plugin.

The Antigravity CLI subscription path uses a local interactive Connect interface and a private per-process CSRF token. It is a version-sensitive native interface, not a promised stable public API. Regression covered CLI 1.2.3 and 1.2.14. Short text verification uses a more restricted print-mode process; its limited image/tool surface must not be mistaken for the production member's capabilities. Group-specific Goal, scheduling, and child-conversation bridges were not added by this phase; existing ordinary-chat automation keeps its own entry points.

An unsupported selected model/input combination must name the affected member and retain the user's draft and attachments. A previewable file is not proof of model vision or native document ingestion. The system does not silently change model, provider, subscription account, or respondent. User or model text in a role prompt and previous group history is not authorization to initiate Goal mode, scheduled tasks, or child conversations.

Verification entry points: `tests/discussion-production-smoke.cjs --tools` (optional `--image <fixture.png>`), `tests/discussion-rich.test.js`, `tests/discussion-rich-ui.py`, `tests/shared-chat-ui.py`, and the Antigravity subscription smoke. Live tests use temporary group and app data; ordinary conversation history and global permissions are not modified.
