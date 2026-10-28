# Local Codex session import

Open **Import local Codex sessions** in the desktop conversation sidebar. The
dialog scans the local Codex `state_5.sqlite` index only when opened. It shows
active parent sessions with a name, title, first user message or preview,
grouped by workspace and ordered by their latest activity. The display title
uses those fields in that order, so older sessions without a `name` remain
available. At most 1,000 eligible sessions are shown. Missing or unreadable
history files remain visible with disabled checkboxes.

Choose **Import / update selected** to copy new sessions or update existing
imports. A changed source is labelled **(update imported session)** and updates
the same Camellia conversation. You can also open an imported conversation's
action menu and choose **Sync from Codex desktop**.

Incremental updates preserve existing Camellia messages and native engine
cursors, append only later source messages, and do not create another
conversation. Repeating an update adds no duplicates. Older imports without a
checkpoint establish one from their matching leading messages; their Camellia
continuation stays in place. The checkpoint and source indexes survive restart
and allow a partially written update to resume without duplicating saved rows.

If the previously imported source prefix has been rewritten or truncated, the
update stops and preserves Camellia history. Busy conversations must finish or
stop before syncing. Batch results show import/update/failure counts and the
first failure reason. A selection that has disappeared or moved outside the
scan window is resolved by ID; unavailable selections report a failure.

The source database and rollout files are read-only inputs. A temporary
database/WAL copy is used while Codex is running; SQLite rebuilds shared memory
in that temporary directory. No credentials or source files are changed.

Both plain `.jsonl` and Zstandard-compressed `.jsonl.zst` histories are streamed.
If the indexed `.jsonl` file is missing, its `.zst` sibling is used when present.
Decompression happens in memory without rewriting or unpacking source files.
Invalid or truncated compressed data rejects the import or update.

Only user and assistant text from canonical `response_item` messages is copied.
Tool calls, reasoning and attachments are excluded. Each conversation is
limited to 64 MiB of extracted UTF-8 text or 100,000 messages, rather than the
size of its tool-heavy rollout file. Malformed complete JSONL records reject
the import or update. An incomplete final record from a live writer is deferred
until a later update sees it complete.

Verification: `tests/codex-desktop-import.test.js` covers live WAL snapshots,
activity ordering and scan limits, selected IDs, incremental updates, legacy
imports, restart recovery, concurrent writes, changed/corrupt source history,
incomplete tails and large rollouts. `tests/shared-chat-ui.py` checks the dialog,
workspace selection, incremental update refresh, English/Chinese failure
messages, scrolling and the manual sync entry.
