# Android embedded network lifecycle

`EmbeddedNetwork` adapts Android network callbacks and the bundled `tsnet` node to a process-owned `NetworkLifecycle`. One background executor owns node creation, shutdown, mode persistence and identity removal. Its short state lock protects the published node, generation, current route revision, background deadline and download lease count. Directory creation, Keystore-backed storage, JNI startup/shutdown and preference commits run outside that lock.

## Creation and replacement

Concurrent callers share one initialization result. Each caller has its own future, so interrupting a request does not cancel initialization needed by another request. The synchronous `EmbeddedNetwork.node()` entry point is for background workers and rejects calls from Android's main looper.

A mode change, explicit close or identity removal invalidates the current generation immediately. Waiting callers receive cancellation. If native startup finishes after invalidation, its result is closed on the lifecycle worker and never published. The worker retains ownership of the old node until shutdown returns; a replacement cannot open the same state directory earlier. A failed close also retains that ownership; explicit close requests surface the failure through their future.

Default-network callbacks enqueue a native network-monitor refresh and debounce the recovery notification by 400 ms. Route changes preserve the node, its discovery identity and active HTTP streams, including while startup is pending. Recovery notification follows queued lifecycle work and checks the current route revision before notifying the active page. An unchanged route does not trigger a refresh. Ordinary replacement preserves the encrypted identity; only the explicit **Forget embedded identity** action clears it, after native shutdown.

## Mode persistence

The desired mode changes in memory immediately. A background commit is serialized before subsequent node startup. The mode future completes after persistence and shutdown of the invalidated node. The settings control displays progress without blocking the main looper, then refreshes the connection status. A save failure restores the last successfully committed mode and displays the error. A failed older save cannot roll back a newer choice.

Settings completion binds only to the current page's control. Leaving that page while a commit is pending does not update the replacement page.

## Background retention and downloads

Foreground/background hooks and transfer leases only update state or enqueue work. Backgrounding keeps a 30-minute retention window. A queued expiry rechecks the deadline and active downloads before detaching the node, so returning to the foreground or starting a download can cancel a pending idle shutdown. Returning after an expired window rebuilds the node unless a download has retained it. Releasing the final download lease schedules an expiry check when a background deadline remains.

Startup that finishes after an unretained background window expires is also closed without publication. Foregrounding clears the deadline; no identity deletion or automatic login retry accompanies idle reclamation.

Artifact downloads retry transient transport failures and HTTP 429/502/503/504 up to five times. Each retry requests the remaining bytes from the number successfully written to the destination. A partial response must match the expected total size and exact range; an older gateway returning the full file is validated and its already-written prefix skipped. Explicit cancellation, destination write failures, authorization failures and invalid response metadata stop the download. This recovery stays within the active service; it does not restore a transfer after process death.

## Conversation stream recovery

Remote detail connections open their event stream independently of history workers. Unknown capabilities are discovered in parallel on status workers while the first connection uses the compatible full-snapshot format. Metadata from another address or credential is cleared before connecting. Metadata alone never authorizes a command; controls require the current conversation's fresh snapshot and permission.

Each connection generation owns a single event executor. Stopping that generation interrupts and shuts down its executor and closes its API client off the main thread. A replacement gets a new executor, so a socket or native read that observes cancellation late cannot hold up the next connection. Generation checks reject late snapshots and metadata callbacks. A coalesced refresh checks its generation before taking the shared pending snapshot: an old worker can post after callback cleanup, and that delayed callback must leave the replacement's initial snapshot intact.

`RemoteStreamHealth` uses elapsed realtime. A usable first snapshot must arrive within 30 seconds; heartbeats alone cannot complete startup. After synchronization, complete snapshots and heartbeat frames extend a 35-second idle deadline. Expiry starts a replacement connection and displays the sync timeout or lost-connection reason while retaining the visible transcript and draft. A retained foreground service is checked again on return, covering time spent asleep even when no network-route callback arrives. Existing authorization failures and retry backoff remain in effect.

A failed chat or list stream is never retried on the client that owned the failed read. The replacement starts in a new generation with a new `RemoteApi` and read worker, because an embedded or socket read can ignore cancellation indefinitely and otherwise pin every later retry to the old transport. The conversation-list stream also reports heartbeat frames, so a quiet but healthy list stays live while a stalled one is rebuilt by the same health deadline. Returning after at least ten seconds in the background rebuilds the selected chat even when the foreground service is still retained.

`RemoteConversationSync` and every `RemoteWorkbenchSync` host use separate retry scheduling. A stopped or failed subscription replaces its worker as well as its client; retries never queue behind the read they are meant to replace. A route switch still preserves the embedded node and queued lifecycle work, but the page reopens its own stream so a socket bound to the old path is not reused.

`RemoteStartupTest` adds a failed-chat-stream regression: the first client throws before its first snapshot, and the test requires a second client to open the replacement stream with the recovered transcript. `RemoteConversationSyncTest` does the same for the silent list subscription. The test suite compiles both the debug and instrumentation sources, but device tests require an attached emulator or phone.

## Verification

`NetworkLifecycleTest` uses controlled startup, shutdown and persistence barriers to verify concurrent initialization, independent caller cancellation, route and mode changes, identity removal, directory ownership, persistence failure, foreground recovery, download leases and callback execution outside the state lock.

`NetworkLifecycleUiTest` places barriers around the production JNI adapter and exercises Android's main looper while startup, native close or mode persistence is blocked. `EmbeddedNetworkTest` verifies native node and prepared-request retention across route changes, idle replacement, encrypted identity retention, explicit identity removal and preference persistence. `RemoteApiDownloadRetryTest` checks partial-write offsets, response validation and cancellation boundaries. Related settings, navigation, recovery, keep-alive and chat-view tests cover integration with existing screens.

`RemoteStartupTest` blocks read workers, capability discovery and old stream cancellation, then checks independent startup, timeout replacement and rejection of late frames. A controlled Handler reproduces an old refresh posting after cleanup and running before the replacement's initial refresh. `RemoteStreamHealthTest` checks startup deadlines, quiet-conversation heartbeats and elapsed sleep time. The keep-alive tests cover both healthy reuse and replacement of a stalled stream before service retention expires; the HTTP response fixture checks the conversation endpoint's snapshot and heartbeat callbacks.

These checks use a disposable emulator and a development APK. They do not establish physical-phone Wi-Fi/cellular handover, browser sign-in or real Tailnet download continuity. The optional online login test runs only when instrumentation is started with `-e onlineLogin true`.
