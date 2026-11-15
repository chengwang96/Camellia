package app.camellia.mobile;

/** Only a usable snapshot completes startup; quiet streams must keep sending heartbeats. */
final class RemoteStreamHealth {
    static final long INITIAL_TIMEOUT_MS = 30_000, IDLE_TIMEOUT_MS = 35_000;
    private final long started;
    private long lastFrame;
    private boolean synced;

    RemoteStreamHealth(long started) { this.started = started; }
    synchronized void snapshot(long now) { synced = true; lastFrame = now; }
    synchronized void heartbeat(long now) { if (synced) lastFrame = now; }
    synchronized boolean synced() { return synced; }
    synchronized long remaining(long now) {
        return Math.max(0, (synced ? lastFrame + IDLE_TIMEOUT_MS : started + INITIAL_TIMEOUT_MS) - now);
    }
}
