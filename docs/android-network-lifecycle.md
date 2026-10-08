# Android embedded network lifecycle

`EmbeddedNetwork` adapts Android network callbacks and the bundled `tsnet` node to a process-owned `NetworkLifecycle`. One background executor owns node creation, shutdown, mode persistence and identity removal. Its short state lock protects the published node, generation, current route revision, background deadline and download lease count. Directory creation, Keystore-backed storage, JNI startup/shutdown and preference commits run outside that lock.

## Creation and replacement

Concurrent callers share one initialization result. Each caller has its own future, so interrupting a request does not cancel initialization needed by another request. The synchronous `EmbeddedNetwork.node()` entry point is for background workers and rejects calls from Android's main looper.

A route change, mode change, explicit close or identity removal invalidates the current generation immediately. Waiting callers receive cancellation. If native startup finishes after invalidation, its result is closed on the lifecycle worker and never published. The worker retains ownership of the old node until shutdown returns; a replacement cannot open the same state directory earlier. A failed close also retains that ownership; explicit close requests surface the failure through their future.

Default-network callbacks invalidate immediately and debounce the recovery notification by 400 ms. Recovery notification follows queued lifecycle work and checks the current route revision before notifying the active page. An unchanged route does not recreate a node. Ordinary replacement preserves the encrypted identity; only the explicit **Forget embedded identity** action clears it, after native shutdown.

## Mode persistence

The desired mode changes in memory immediately. A background commit is serialized before subsequent node startup. The mode future completes after persistence and shutdown of the invalidated node. The settings control displays progress without blocking the main looper, then refreshes the connection status. A save failure restores the last successfully committed mode and displays the error. A failed older save cannot roll back a newer choice.

Settings completion binds only to the current page's control. Leaving that page while a commit is pending does not update the replacement page.

## Background retention and downloads

Foreground/background hooks and transfer leases only update state or enqueue work. Backgrounding keeps a five-minute retention window. A queued expiry rechecks the deadline and active downloads before detaching the node, so returning to the foreground or starting a download can cancel a pending idle shutdown. Returning after an expired window rebuilds the node unless a download has retained it. Releasing the final download lease schedules an expiry check when a background deadline remains.

Startup that finishes after an unretained background window expires is also closed without publication. Foregrounding clears the deadline; no identity deletion or automatic login retry accompanies idle reclamation.

## Verification

`NetworkLifecycleTest` uses controlled startup, shutdown and persistence barriers to verify concurrent initialization, independent caller cancellation, route and mode changes, identity removal, directory ownership, persistence failure, foreground recovery, download leases and callback execution outside the state lock.

`NetworkLifecycleUiTest` places barriers around the production JNI adapter and exercises Android's main looper while startup, native close or mode persistence is blocked. `EmbeddedNetworkTest` verifies native replacement, encrypted identity retention, explicit identity removal and preference persistence. Related settings, navigation, recovery, keep-alive and chat-view tests cover integration with existing screens.

These checks use a disposable emulator and a development APK. They do not establish physical-phone Wi-Fi/cellular handover, browser sign-in or real Tailnet download continuity. The optional online login test runs only when instrumentation is started with `-e onlineLogin true`.
