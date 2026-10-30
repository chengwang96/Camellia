# Native conversation history

Implementation record, 2026-10-30. Both requested phases are implemented. Native
runtime checks use loopback model servers and isolated homes, without paid API
or subscription requests.

## Phase 1: editing and the unified fork entry

Claude and Grok replace the latest ordinary user turn from its native boundary.
Claude resumes through the exact parent chain UUID and passes
`--resume-drops-turn` to validate the discarded turn. Grok forks through the
preceding native prompt index, including gaps left by canceled prompts. Codex
retains its existing `thread/fork` turn-boundary path.

The shared manager persists the observed boundary, preserves earlier native
context, and sends the revision notice as plain text. A repeated edit therefore
does not misclassify that notice as a history bridge. Earlier messages and tool
output are not replayed merely because the latest message changed. Actual native
context pressure can still require compaction.

Claude inputs carry a unique native message UUID. Boundary lookup on that
connection also checks the UUID, so an unpersisted active request cannot match
an earlier completed request with identical text. Until the current input is
observable, a live fork retains the completed shared history.

Desktop, remote, send-with-fork, and conversation-tool fork entries use the same
native preparation path. The source binding must match the destination model,
connection and account. The source keeps its native identity; a child gets a
distinct identity and its own conversation-tool bridge. Parked native bindings
are not copied into the child.

The headless server advertises the same editing and fork capabilities. Its
Claude driver passes the frozen transcript and guarded resume boundary through
to the CLI and writes a separate MCP overlay for each conversation, preserving
the configured custom MCP servers and their original configuration file.

| Verified runtime | Native branch preparation |
| --- | --- |
| Claude 2.1.312 | Freeze a complete raw native JSONL prefix. `--fork-session` creates the child on its first send, including after restart or deletion of the source. |
| Codex 0.165.0 | `thread/fork`, optionally through a turn boundary. API homes use SQLite backups including committed WAL data and copy/rebase the rollout lineage. |
| Grok 1.0.70 | `_x.ai/session/fork`, optionally through `targetPromptIndex`; load the child with its own MCP configuration. |
| Kimi 2.4.0 | ACP `session/fork` on the connection owning the source lease; close and restore only the child to replace inherited MCP servers. |
| Antigravity API SDK 0.1.16 | Existing SDK bridge `session/fork`, using its native database snapshot. |
| DSH 0.2.1-rc.2 | Host event-boundary fork through the bridge below. |

Native branch artifacts are copied into the destination API home where needed.
Credentials, native goals and queued work are not copied as a substitute for a
native fork. Kimi and DSH copy the newly created child after closing its writer.
Canceling a child fork does not stop the source process.

## Phase 2: Kimi undo and DSH Host

Kimi's ACP does not expose engine undo. A version-checked derived module adds a
narrow bridge to `IAgentConversationUndoService.undo`. It reads native context,
records a digest, validates that digest again, forks, and undoes exactly one turn
on the child. Native code handles checkpoints, compaction boundaries and state
reconciliation. A turn before a compaction boundary cannot be undone through this
bridge. Turns after compaction can still be edited.

The DSH bridge invokes the installed Host's `SessionCommandController.fork`.
`atSeq` is an inclusive native event boundary; omitting it uses Host's latest
completed-turn prefix. Host constructs the seed, inherited event count and
synthetic closers for an open tail. ACP supplies the selected model and fresh MCP
composition. Ordinary seeded children remain resumable after restart.
Latest-message editing and active forks use the event before the user message,
retaining earlier context and excluding that user turn's tools.

An active DSH fork uses the source connection captured by the shared manager.
Changing the next turn's thinking preference must not reconfigure or restart
that connection; the child inherits the new preference on its own continuation.
A stale captured source causes a compatible fallback instead of starting a
replacement source process. Explicit native edits always create a new process,
including when no Goal/MCP bridge is configured, so cache reuse cannot bypass
the requested fork.

Derived modules are published atomically beside native modules so relative
imports and assets keep working. Distributed native files remain intact. The
bridge is enabled only for verified versions and source contracts; incompatible
or read-only installations keep portable history behavior. The DSH pin also
updates settings, locale and client-module integration compatibility.

## Boundaries and compatibility

A native cut must match the observed user request. A migrated turn containing a
portable history bridge, an unavailable anchor, an unsupported runtime or a
mismatched binding uses shared history. Claude can defer persisting an active
prompt until a model response; an unobservable active boundary uses this fallback.
Antigravity subscription CLI has no verified native fork and keeps the fallback.

An active fork excludes the whole current turn from the public branch. Forks do
not roll back workspace files or external effects. Branches share the working
directory.

## Verification

- `npm test`: regression coverage for restart, cancellation, capability fallback,
  large-history routing, boundary validation and storage isolation.
- `node tests/native-fork-smoke.cjs`: installed runtimes against a local model;
  repeated edits for Claude, Grok, Kimi and DSH, exclusion of superseded tools,
  Kimi compaction refusal and post-compaction editing, active cuts, MCP ownership,
  source deletion, restart and second-generation native forks.
- `node tests/native-fork-smoke.cjs --headless`: the same checks through the
  actual headless driver factory for all six harnesses. DSH also changes its
  next-turn thinking preference while its model request remains in progress.
- `node tests/native-fork-smoke.cjs --remote` (also with `--headless`): exercise
  native branch preparation through the production remote command handler for
  all six harnesses. HTTP regression tests additionally cover remote scope,
  stale requests, retry deduplication and unsupported-runtime fallback.
- `node tests/native-fork-smoke.cjs --headless dsh --without-goal-tools`: DSH
  editing, active-source isolation and restart without a conversation-tool bridge.
- `node tests/claude-cli-resume.cjs <claude-executable> --edit` and
  `node tests/grok-smoke.cjs`: native protocol regression checks.
- `DSH_PERFORMANCE_RUNTIME_DIR=<installed-dsh> node --test tests/dsh-client-performance.test.js`:
  native 0.2.1 client artifacts and settings/locale patch compatibility.

No implementation phase remains pending. Live subscription login/quota behavior
is outside the local model fixtures; account boundaries have protocol regression
coverage.

Latest local results: the full `node --test --test-force-exit tests/*.test.js`
run passed 2,900 tests, skipped 14, and had no failures (2,914 total). All six
installed-runtime fork fixtures and all six headless driver fixtures passed.
The first independent review found that changing DSH next-turn thinking during
generation could restart the source while preparing a branch. That defect now
has a failing-before-fix unit case and a passing real-runtime regression; the
exact source connection and settings remain unchanged while the child inherits
the preference. Claude's guarded-edit smoke, Grok's full
tool/permission/cancel/edit smoke, Kimi 2.4.0's tool/permission/quota/cancel smoke,
and DSH 0.2.1's settings/client/locale compatibility checks also passed.

The second independent review found a test-fixture defect: the desktop Claude
fixture did not expose its `history` reader, so the source-deletion check threw
before restart and second-generation forks ran. The fixture now supplies the
same native reader used by its session factory. The earlier claim that all six
desktop fixtures had passed was inaccurate; the complete desktop and headless
commands must both exit successfully to validate that claim.
Both commands were rerun after this fix and exited with code 0 for all six
harnesses. This includes the previously interrupted desktop Claude checks.
Logs: `%TEMP%/camellia-native-history-desktop-r4.log` and
`%TEMP%/camellia-native-history-headless-r4.log`.
The targeted native-history regression run also passed 540 tests, skipped one,
and failed none (541 total). Syntax and `git diff --check` checks passed.

The third independent review found that the remote fork handler still called
the shared-history-only `manager.fork` directly. It now awaits the same
`fork-session` command as the desktop entry and returns the prepared child's
summary. Remote HTTP regressions check native identities, active-turn cuts,
retention of the source, no shared-history replay, deduplicated retries, and
portable fallback. This closes the missing remote path; the earlier statement
that this path had already been connected was inaccurate.
Both `--remote` and `--remote --headless` runtime smoke commands passed all six
harnesses and exited 0. The full regression suite passed 2,897 tests with 14
skipped and no failures. Logs: `%TEMP%/camellia-native-history-remote-r5.log`,
`%TEMP%/camellia-native-history-remote-headless-r5.log`, and
`%TEMP%/camellia-native-history-full-r5.log`.

A follow-up review simplified three redundant mechanisms: the remote handler
now relies on the internal command's exception contract, Codex rollout traversal
has no arbitrary depth cutoff, and Kimi child closure propagates errors directly
with best-effort handling only during cancellation and final cleanup. Native
boundary validation, compaction checks, source identity/account isolation and
runtime ABI checks remain necessary to preserve the tested history semantics.
After this simplification, all 131 targeted regressions passed; the full suite
again passed 2,897 tests with 14 skipped and no failures. Both remote runtime
smoke commands passed all six harnesses and exited 0. Logs:
`%TEMP%/camellia-native-history-review-targeted-r6.log`,
`%TEMP%/camellia-native-history-full-r6.log`,
`%TEMP%/camellia-native-history-remote-r6.log`, and
`%TEMP%/camellia-native-history-remote-headless-r6.log`.

The uncommitted-change review reproduced a Claude boundary defect with the
installed runtime: an active request repeating the preceding completed request
could cut away that completed turn before the active input was persisted.
Matching the supplied native input UUID fixes the ambiguity. Unit coverage also
checks cancellation before persistence; the runtime fixture verifies that the
CLI preserves the supplied UUID and that the child retains the earlier turn.
Its mock server now pauses only a matching current request, so history replay
cannot accidentally pause the child. Full regression log:
`.git/review-uncommitted-20261030-final.log`.
Both complete `--remote` and `--remote --headless` smoke commands passed all
six installed runtimes and exited 0 after the fix. Claude also passed with
`--without-goal-tools`. Logs: `.git/review-native-desktop-20261030-final.log`,
`.git/review-native-headless-20261030-final.log`, and
`.git/review-claude-no-tools-20261030-final.log`.
