package app.camellia.mobile;

import org.json.JSONObject;

/** Advance host elapsed time on the device's monotonic clock, even when a snapshot is replayed. */
final class CompactionClock {
    private long base = -1, observedAt, startedAt = -1, afterSeq = -1;
    private boolean running;

    void update(JSONObject value, long now) {
        boolean nextRunning = value.optString("state").equals("running");
        long nextStart = value.optLong("startedAt", -1), nextBoundary = value.optLong("afterSeq", -1);
        boolean newRun = nextRunning && (!running || changed(startedAt, nextStart) || changed(afterSeq, nextBoundary));
        long accrued = newRun ? 0 : elapsed(now);
        long reported = value.optLong("elapsedMs", -1);
        long duration = value.optLong("durationMs", -1);
        base = !nextRunning && duration >= 0 ? duration : Math.max(accrued, reported);
        observedAt = now;
        running = nextRunning;
        if (newRun || nextStart >= 0) startedAt = nextStart;
        if (newRun || nextBoundary >= 0) afterSeq = nextBoundary;
    }

    long elapsed(long now) { return base < 0 || !running ? base : base + Math.max(0, now - observedAt); }
    private static boolean changed(long previous, long next) { return previous >= 0 && next >= 0 && previous != next; }
}
