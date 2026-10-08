# Storage and memory maintenance

## Shared runtime data

New Codex API conversation homes link `.tmp` to `<app-data>/codex/.tmp`.
Subscription homes remain account-isolated. Existing directories and links are
not replaced during launch: another native process may still be using them.
Failure to create a new API home's shared cache link is reported before its
native client starts, instead of silently creating another full cache copy.
Do not delete SQLite databases, WAL files, sessions, skills or whole homes as
cache cleanup.

The desktop entry point is **Settings → Data & backups → Codex plugin caches →
Deduplicate and restart**. Camellia flushes settings, stops its native processes
and starts the requested maintenance before creating new engine clients. A
separate progress window shows chunked verification and cache switches. Native
Codex app-server processes still running outside Camellia block the pass; the
result remains visible in settings. Completed and canceled requests are consumed,
so subsequent ordinary launches do not repeat the scan. Cancellation retains
completed links and their reported savings; running maintenance again continues
with the remaining real directories.

`plugins.sha` groups candidates but never authorizes deletion. Actual tree
contents are checked, shared trees are read once per pass, and metadata is
rechecked before a duplicate is replaced. Each switch has an atomic operation
record: startup restores an unlinked original or finishes committed duplicate
cleanup after an interruption. Different contents keep separate shared copies.
Git scratch folders, unfinished plugin clones and other unknown entries are
reported and retained. Member sessions, SQLite files and credentials stay in
their own native homes.

Unreferenced content-addressed plugin snapshots join the normal space-cleanup
preview. All API homes protect their cache targets, including archived homes;
changed links invalidate verification. Active responses and unfinished maintenance
protect snapshots. Plugin caches and maintenance records are excluded from data
exports.

For command-line maintenance, exit Camellia and all Codex processes, then run:

```powershell
node scripts/maintain-plugin-cache.cjs "$env:APPDATA\camellia"
node scripts/maintain-plugin-cache.cjs "$env:APPDATA\camellia" --apply
```

Use the directory shown under **Settings → Data & backups → Local data**. Installations that have not migrated yet still use `dsh-desktop`.

The directory migration runs offline during restart. A separate progress window
shows the current phase, processed entries and bytes, and elapsed time while
the owner prepares and verifies the migration. The initial scan has no known total;
later phases show their own completion percentage. This is a per-phase bar,
not an estimate of the whole migration's duration. Its disposable browser
profile does not open or lock the old or new data directory.

The local progress-window smoke test (`node tests/data-directory-progress-electron.cjs`)
keeps its simulated migration window hidden. Use `--show-window` for an explicit
visual check. CI enables visibility with `CAMELLIA_DIRECTORY_PROGRESS_TEST_VISIBLE=1`.
Both modes use temporary test data and check progress, cancellation and failure
acknowledgment without opening the user's profile.

The normal sibling-directory migration uses a same-filesystem rename. One
no-follow inventory finds metadata and absolute internal links. Unchanged
attachments, browser state, runtime files and caches keep their original file
identities, hard links and permissions; their contents are neither copied nor
repeatedly hashed. Text metadata is checked for actual path replacements before
a temporary copy is written. SQLite changes are prepared on isolated copies,
including WAL/SHM/journal sidecars, and checked for schema, row and integrity
consistency. Changed files are fingerprinted before and after replacement.

Prepared updates and original metadata backups live in a scoped sibling
transaction directory. The complete swap plan is flushed to
`.camellia-directory-migration-transaction.json` before moving the profile.
Electron releases its old profile lock only for the directory rename and
immediately acquires the new lock. Startup recovers an interrupted transaction
before selecting or creating any profile. An uncommitted transaction restores
original metadata and the old directory name; a committed one retains the new
profile and finishes backup cleanup. A live owner blocks a second startup, and
unsafe records or independently recreated directories are never overwritten.

Canceling during inventory, preparation or prepared-data verification keeps the
original profile and removes the pending request. Cancellation waits for the
current file operation and rollback. It is disabled during the final rename,
replacement, verification and activation stages. If the filesystem cannot
rename the directory before any data is changed, the verified copy strategy is
used instead; that fallback still requires several full profile reads. Profiles
with very large metadata histories still need time to scan and rewrite them.

On Windows, the rename strategy retains external directory junctions in place,
including missing dependency targets. The copy fallback preserves their junction
type. Backup cleanup unlinks reparse entries without following their targets
before recursively removing the transaction directory. This avoids Electron's
silent incomplete removal of backups with junctions to the renamed old profile.
Cleanup verifies that the backup directory is absent before deleting the
transaction record or reporting success. If removal fails, the committed record
is retained for startup recovery to retry after the migration owner exits.
A failed or incomplete migration stays visible until
acknowledged and is recorded in `.camellia-directory-migration-result.json`
under the application-data parent directory. The last failure remains available
in settings after restart. If temporary-copy cleanup fails, its location and
cleanup error are reported; the presence of a normal application window does
not mean the migration succeeded.

The isolated benchmark `node scripts/benchmark-directory-migration.cjs` uses
2,134 files and 66 MiB of opaque data. A local Windows run on 2026-10-06 took
106 ms with rename versus 8,139 ms with copy (about 77 times faster). JavaScript
filesystem reads fell from 345,798,438 bytes to 4,666 bytes; copied data fell
from 69,159,219 bytes to 259 bytes. These are synthetic timings, not a measured
duration for the user's live profile. Regression tests cover preserved file
identities and links, SQLite values, cancellation, corruption, lock transfer,
copy fallback and abrupt process exits in six transaction stages.

The default is read-only. Apply refuses to run while Camellia/Electron/Codex is
present. Keep those applications closed throughout maintenance. Only API homes
are considered. Byte-identical snapshots share a content-addressed directory;
different snapshots remain distinct. Unknown top-level files, nested links and
hard links are retained and reported. No history or credentials are migrated.
Interruptions with an operation record are recovered before native clients start.
A legacy `.tmp-maintenance` directory without a matching record is retained for
inspection. Future Codex updates may change a shared snapshot;
do not assume its directory name remains a current content hash.

DSH's `profiles/node_modules` contains native dependency junctions, not full
copies of the installation. Disk audits must use `lstat` and avoid traversing
reparse points, or they will repeatedly count the same runtime files.

## Space cleanup

Open **Settings → Data & backups → Space cleanup** to scan and review unused files before confirming deletion. Opening the page does not start a scan or cleanup.

Reference matching uses shared prefixes rather than searching the entire input
once per candidate path. Scans yield between directories/files and every 4 MiB
of reads, keeping the main event loop responsive. SQLite/WAL and other unknown
native files remain reference sources; performance is not obtained by silently
dropping them. Known Codex cache roots and DSH dependency links are excluded;
unexpected links fail closed. Legacy real cache directories require offline
maintenance before their containing engine directory can be a cleanup candidate.

Confirmation rechecks references, directory snapshots, live owners and file
identity. A concurrently modified database or transcript can still require a
rescan; finish active turns before cleaning. Preview inventories expire after
30 minutes and release their in-memory file lists. Automated diagnostics can
pass an AbortSignal to StorageCleanup; cancellation does not authorize deletion.

Remote upload copies in `remote/device-attachments` and legacy `remote/mobile-images`,
plus copied discussion assets in `discussions/assets/<group>/<asset>`, participate
in the same preview with their own file counts and sizes. Only Camellia's owned
hash/UUID paths are eligible; external attachments, unknown paths, links and
hard links are retained. Existing and newly created files have a 24-hour
protection window. Deleting a phone connection alone does not release attachments.

Reference verification includes retained shared and native history, archives,
forks, paused/failed remote queues, saved and in-memory renderer drafts, active
upload leases, and decoded discussion messages and frozen inputs. Large group
text stored in separate immutable payload files is decoded and verified too.
Each member's native context remains intact. Changed or unreadable reference
data stops deletion; manual confirmation collects references again.

Desktop and CLI hosts coalesce changes into an idle maintenance pass after
30 seconds, including one startup pass for old leftovers. Recent files schedule
a wake when their protection expires. Renderer drafts and local queues notify
the host when their attachment paths change; ordinary typing does not notify it.
An empty/recent-only inventory avoids reading history, and successful passes
do not create a periodic full-history
scan. Uploads never synchronously start a cleanup scan. Background cleanup has
its own inventory, preserves manual previews, and aborts at the next scanner
yield during shutdown. It reclaims attachment copies and eligible completed
import backups; other cleanup categories still require manual confirmation.
A stable unreadable reference is
logged and waits for another change, restart or manual inspection.

A send rejected before committing its user row or queue entry rolls back only
the copies created by that request. A lost acknowledgement, durable queue write
or committed discussion row retains its files for reference-based cleanup.
Uncertain commitment and rollback failures retain files and report the error;
the idle pass can reclaim leftovers once their references and age allow it.

Focused tests cover rollback, queued/history/native references, payload-only
group paths, changed-file protection, idle scheduling and shutdown. Run
`python tests/attachment-cleanup-ui.py` for isolated Electron verification of
embedded and standalone group drafts and the actual cleanup IPC.

## Other retention

Diagnostic output in `logs/dsh-desktop.log` rotates on the first write of a new
UTC day or before a write would exceed 10 MiB. Each stream keeps at most five
historical segments, each no older than 14 days. Oversized historical segments
from older releases are also eligible; rotation never reads an old log into
memory. Unknown log names, links and hard links are excluded. Manual space
cleanup uses the same historical-file eligibility and excludes active logs.

The pending write queue is capped at 1 MiB, with one outstanding write and a
64 KiB maximum entry. Queue overflow records a dropped-entry count; oversized
entries are truncated. Shutdown drains accepted entries and closes the stream;
size/day rotation closes the old handle before rename on Windows. Fatal errors
are written synchronously to `dsh-desktop-fatal.log`, independently of the
ordinary stream, with 256 KiB segments and the same history count/age limits.
Chat/native JSONL, SQLite/WAL and transaction/launch journals are saved data,
not diagnostic logs, and this policy never truncates them.

Completed overwrite-import backups under `migration-backups` keep at most three
recovery points, for 30 days and a target total of 2 GiB. Any limit makes an
older point eligible, while the newest completed point is always retained even
when it exceeds the size target. Pending transactions and unresolved recovery
remain protected and can make the total exceed that target. Completion writes
a durable `retention.json` ownership manifest before removing the import
journal. A backed-up group manifest gets private copies of its referenced
immutable text even when those files were not overwritten, before live payload
maintenance can prune them. Checksums use bounded reads; interrupted copies keep
the journal for startup recovery. Changed size/modification time or additional
files invalidate automatic deletion; an
interrupted deletion may retry the remaining manifest-owned files.

The startup/idle pass inventories backup metadata before reading any history.
It then deletes eligible completed backups and verifies remaining references
before considering attachment copies. A retained backup protects shared and
native owners, decoded group messages/frozen inputs, and attachment paths until
its files are actually removed. Legacy immutable group text may remain in the
live discussion folder; that payload is verified as a reference source too.
Unverifiable backup trees stop reference-based cleanup.

Settings space previews report backup count, occupied bytes and reclaimable
bytes. Legacy backups without a completion record are only offered for manual
confirmation after a 24-hour protection window. Pending/corrupt manifests,
quarantined original records and
unknown trees stay protected. User-exported ZIP files and the single
`.workbench.bak` configuration originals remain user managed. No live-profile
cleanup is implied by source tests or this retention policy.

`tests/backup-retention.test.js` and `tests/rotating-log.test.js` cover retention,
recovery evidence, independent group payloads, reference release, bounded logging
and Windows handle closure. `python tests/retention-ui.py` verifies the English
and Chinese summaries, manual confirmation and automatic idle pruning with an
isolated Electron profile.

Idle native-process retention uses a monotonic in-memory clock for each session
instance. Shared task lifecycle events refresh activity; task completion starts
a full idle window, including after long runs, interruptions and compaction.
Running work, pending permissions, recovery and armed goals remain protected.
Pool lookups and history reads do not refresh activity. Replacements start their
own window, and sweep bookkeeping drops handles no longer held by any pool.
If a new turn arrives during idle teardown, it waits for shutdown before resuming
the stored native context. Discussion resources remain under their verified
owner's release policy. Idle retention stops processes without deleting chats
or members' native histories.

Completed streaming turns release their replay buffers, and Codex releases its
output-item indexes. Deleting a shared conversation releases idle native sessions
from every engine pool. Failed shutdowns remain tracked. The test harness uses
its own process event emitter so repeated fixtures do not leak crash handlers
onto the real Node process.

Scientific library installation runs `uv cache prune --ci` after validation,
retaining the installed Python environments and datasets. Pruning failure does
not invalidate a successful install. Cache size is not necessarily reclaimable
physical storage when uv uses hard links; use uv's cache commands rather than
deleting environment files.

These targeted fixes and regression tests are not a proof that every engine or
renderer is free of memory leaks; that requires a long-running heap/process soak.

## Local verification (2026-09-30)

- A no-follow audit found 32 files, 1,928 links and approximately 0.9 MiB in
  `dsh-chat`; the earlier recursive 755 MB estimate counted linked dependencies.
- `uv cache prune --ci` reported 35,788 removed files (3.0 GiB). Both installed
  DS-1000 and SciCode Python environments subsequently imported NumPy and SciPy.
  This is uv's reported cleanup size, not a measurement of free-disk increase.
- The live-profile read-only scan reached reference consistency verification in
  57.8 seconds, with 546 timer callbacks at 100 ms intervals. It stopped because
  reference files were changing during live turns. No cleanup was executed;
  successful idle-profile UI confirmation remains to be verified after restart.
- The full Node suite passed 1,254 tests with 4 skips and no failures. The final
  deletion/pool integration check passed another 14 tests after its assertion
  was extended.
- Full byte-for-byte preview of the old plugin snapshots was stopped after
  roughly seven minutes; no migration/reclaimed-size result is claimed. Apply
  was confirmed to refuse while native processes were running. The migration
  algorithm passes isolated tests, but existing live caches remain unchanged.
