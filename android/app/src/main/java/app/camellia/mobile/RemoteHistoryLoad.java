package app.camellia.mobile;

/** A bounded opening-history walk, tuned by real end-to-end page latency. */
final class RemoteHistoryLoad {
    static final int PROBE_MESSAGES = 8, FAST_MESSAGES = 30, NORMAL_MESSAGES = 12;
    static final int MAX_PAGES = 8;
    static final long MAX_ELAPSED_MS = 6000;
    private int pages;
    private long elapsed, slowest;
    private boolean stopped;

    boolean shouldLoad(int visible, int records, long bytes, boolean hasOlder) {
        return !stopped && hasOlder && pages < MAX_PAGES && elapsed < MAX_ELAPSED_MS
            && !RemoteHistoryPage.atLimit(records, bytes) && visible < target();
    }

    int remainingMessages(int visible) {
        return Math.max(1, (pages == 0 ? PROBE_MESSAGES : target()) - visible);
    }

    void received(long durationMs) {
        pages++;
        long duration = Math.max(1, durationMs);
        elapsed += duration;
        slowest = Math.max(slowest, duration);
    }

    void stop() { stopped = true; }

    private int target() {
        if (pages == 0 || slowest <= 800) return FAST_MESSAGES;
        return slowest <= 2000 ? NORMAL_MESSAGES : 0;
    }
}
