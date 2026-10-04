# Archived code review and optimization record

This record summarizes the 2026-09-14/15 review. It is not a current release checklist. The project has since added more engines and changed its UI; consult the [development guide](../development.md) and current tests for implementation state.

## Integration changes at the time

- Kimi Code was added as a third home entry through its native ACP interface, with shared chat components and workspace metadata. A local model fixture exercised resume, stop, tools, approval, fork, and image input. Existing Kimi sessions kept their working directory because the observed ACP restore/fork path ignored a new `cwd`; closing a session cleanly before replacing its process protected just-completed history.
- Model-menu duplicates arose when a historical `:cloud` ID and its canonical route ID were compared literally. The selected historical ID was kept on a single canonical row, without rewriting the user's choice or merging distinct model versions.
- Claude's model list and connection were moved to Camellia's API route pool. Legacy endpoint/key fields were no longer returned through settings IPC or allowed to bypass routing. No usable route meant the CLI did not start.

## Reliability and performance repairs

The review extracted Claude process communication into `src/engines/claude-session.js`, unifying cleanup after initialization failure, stdin disconnect, process exit, and duplicate end events. `StringDecoder` preserved UTF-8 characters across stdout chunks, and trailing data was read after process close. Permission replies retained the original tool input and rejected stale request IDs. New launch settings were validated before replacing an existing process.

History loading changed to a bounded recent-message buffer rather than displaying the oldest 200 entries of a long file. Sidebar summary reads were cached by file identity and grouped before render; streamed Markdown was batched per animation frame. IME composition no longer triggered Enter-to-send. File previews encoded special path characters. DSH backend startup gained a shared promise, cancellation, and generation checks so old exits could not erase a new process's state.

Configuration writes moved toward atomic temp-file replacement and strict reads before updates. Public API-router state became a deep copy rather than a mutable reference. Invalid upstream JSON, empty event streams, and goal-round attribution received explicit checks. A follow-up used the `yaml` document API to modify only intended DSH paths while preserving comments and anchors; `claude-goal.js` and UI modules narrowed large files without adding a framework.

The original review ran Node, Chromium, Electron, and local native CLI checks using temporary data and a fake model endpoint. It did not establish paid-provider, subscription, or every external runtime behavior. Old portable build paths under ignored `dist/` were evidence for that historical run, not current installers.
