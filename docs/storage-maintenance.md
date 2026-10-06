# Storage and memory maintenance

## Shared runtime data

New Codex API conversation homes link `.tmp` to `<app-data>/codex/.tmp`.
Subscription homes remain account-isolated. Existing directories and links are
not replaced during launch: another native process may still be using them.
Do not delete SQLite databases, WAL files, sessions, skills or whole homes as
cache cleanup.

For existing plugin snapshots, exit Camellia and all Codex processes, then run:

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
type. A failed or incomplete migration stays visible until
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
If interrupted, a `.tmp-maintenance` directory is retained for inspection rather
than automatically discarded. Future Codex updates may change a shared snapshot;
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

## Other retention

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
