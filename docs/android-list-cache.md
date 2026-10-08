# Android remote conversation list cache

The default `RemoteListCache` is owned by the Android process and shared by `MainActivity` instances. Each entry is keyed by the existing computer address/token pair and stored in memory as an immutable JSON string. Updating one computer freezes only that entry. Reading returns a new JSON object, so later mutations of input rows, nested objects, workspaces or returned data cannot alter a pending write. The existing encrypted JSON envelope and cache schema remain compatible.

## Coalescing and work ownership

The first unsaved change starts a fixed 250 ms window. Later changes replace the latest in-memory entry without extending that window or creating more write tasks. The worker captures at most 20 string references, assembles the complete JSON, encrypts it and commits it in the background. Each computer retains at most 1,000 list rows, using the existing pagination boundary.

There is at most one active save and one pending latest state. While a save is running, mutations update the current map; they do not enqueue complete snapshots. The first subsequent change records the next deadline, and the writer takes the latest map after the active save completes. A revision counter prevents an older successful save from marking newer changes as saved. Deletion, token changes and eviction are included in the next complete snapshot.

Byte-identical entries and missing-entry removals do not cause additional saves after the cache is current. A refresh with an identical entry can retry an earlier unsaved failure. Cancelled timer tasks are removed from the executor queue; a generation token also rejects a cancelled callback that had already started waiting for the state lock. Serialization and storage I/O do not run under that lock.

## Lifecycle, completion and failures

`MainActivity.onStop` and `onDestroy` request `flush()` without waiting on the UI thread. A new Activity reuses the same process cache and writer, including its latest in-memory changes. The default cache is not closed by individual screens. `flush()` completes when the requested state or a newer state is saved, or reports that write's exception. Repeated requests share at most one active and one pending completion future. Completion callbacks run outside the cache lock.

Private cache instances can call `close()` to flush their final state and shut down their worker asynchronously. Updates after close are ignored, and repeated close requests share the same completion. A final failed save reports failure and terminates rather than retrying indefinitely.

Load and save failures are logged. Save failure retains the latest map and its unsaved revision; another update, refresh or lifecycle flush can retry. A newer update arriving during a failed write still receives its own attempt, but an unchanged failed version has no automatic retry loop. The cache can be rebuilt from the host. Abrupt process death may leave an older disk cache; asynchronous lifecycle flushing is not a durability guarantee for a killed process. The authoritative conversation history and request receipts use their existing stores.

## Verification

Unit tests cover large bursts, blocked saves, multiple computers, deletion during a save, immutable snapshots, unchanged refreshes, fixed-window progress, failed saves, completion sharing, timer cancellation, close and the legacy schema. Android tests cover native JSON behavior, real encrypted round trips and actual Activity destruction/recreation with a blocked writer.

The device benchmark seeds 20 computers with 16 rows each, then submits 200 updates while the storage sink is blocked. It compares pending task counts, eventual save counts, Java allocations, sampled Java heap and submission time with the previous eager implementation. Memory/submission measurements exclude seeding and the initial active snapshot. This benchmark isolates queue construction; it does not measure encryption or physical flash traffic, and one complete cache is still materialized for each actual save.
