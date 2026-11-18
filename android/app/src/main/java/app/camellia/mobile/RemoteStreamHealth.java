package app.camellia.mobile;

/** Only a usable snapshot completes startup; quiet streams must keep sending heartbeats. */
final class RemoteStreamHealth {
    static final long INITIAL_TIMEOUT_MS = 30_000, RECOVERY_INITIAL_TIMEOUT_MS = 8_000, IDLE_TIMEOUT_MS = 35_000;
    private final long started, initialTimeout;
    private long lastFrame;
    private boolean synced;

    RemoteStreamHealth(long started) { this(started, INITIAL_TIMEOUT_MS); }
    RemoteStreamHealth(long started, long initialTimeout) {
        this.started = started;
        this.initialTimeout = initialTimeout;
    }
    synchronized void snapshot(long now) { synced = true; lastFrame = now; }
    synchronized void heartbeat(long now) { if (synced) lastFrame = now; }
    synchronized boolean synced() { return synced; }
    synchronized boolean fresh(long now, long graceMs) { return synced && now - lastFrame <= graceMs; }
    synchronized long remaining(long now) {
        return Math.max(0, (synced ? lastFrame + IDLE_TIMEOUT_MS : started + initialTimeout) - now);
    }
}
