package app.camellia.mobile;

import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Read-only probes on their own clients; the watchdog also bounds embedded-network requests. */
final class ConnectionStabilityCheck implements AutoCloseable {
    enum Issue { REQUEST_ERROR, REQUEST_TIMEOUT, STREAM_ERROR, STREAM_TIMEOUT, HEARTBEAT_TIMEOUT, DESKTOP_CHANGED, HIGH_LATENCY, INVALID_RESPONSE }

    interface Events {
        void snapshot(JSONObject value);
        void heartbeat();
    }
    interface Transport extends AutoCloseable {
        JSONObject status() throws Exception;
        void events(Events listener) throws Exception;
        @Override void close();
    }
    interface Listener {
        void progress(Snapshot value);
        void complete(Snapshot value);
    }

    static final class Config {
        final long duration, interval, requestTimeout, streamTimeout, heartbeatTimeout, slowRequest;
        Config(long duration, long interval, long requestTimeout, long streamTimeout, long heartbeatTimeout, long slowRequest) {
            if (duration <= 0 || interval <= 0 || requestTimeout <= 0 || streamTimeout <= 0 || heartbeatTimeout <= 0 || slowRequest <= 0)
                throw new IllegalArgumentException("Test intervals must be positive");
            this.duration = duration; this.interval = interval; this.requestTimeout = requestTimeout;
            this.streamTimeout = streamTimeout; this.heartbeatTimeout = heartbeatTimeout; this.slowRequest = slowRequest;
        }
    }
    static final Config DEFAULT = new Config(30_000, 2_000, 5_000, 10_000, 15_000, 2_000);

    static final class Snapshot {
        final long elapsed, duration, minimum, average, maximum, jitter;
        final int attempts, successes, failures, slowRequests, heartbeats, snapshots;
        final boolean streamConnected, finished;
        final Issue issue;
        final Exception error;
        Snapshot(State state, long now) {
            elapsed = Math.max(0, now - state.start); duration = state.config.duration;
            attempts = state.attempts; successes = state.successes; failures = state.failures;
            slowRequests = state.slowRequests; heartbeats = state.heartbeats; snapshots = state.snapshots;
            minimum = successes == 0 ? 0 : state.minimum; maximum = state.maximum;
            average = successes == 0 ? 0 : Math.round((double) state.total / successes);
            jitter = successes < 2 ? 0 : Math.round((double) state.jitterTotal / (successes - 1));
            streamConnected = state.streamConnected; finished = state.finished; issue = state.issue; error = state.error;
        }
    }

    // State uses monotonic milliseconds. Keep analysis independent of Android and transport callbacks.
    static final class State {
        final Config config;
        final long start;
        long requestAt, nextRequest, lastFrame, total, minimum = Long.MAX_VALUE, maximum, previousLatency, jitterTotal;
        int attempts, successes, failures, slowRequests, heartbeats, snapshots;
        boolean inFlight, streamConnected, finished;
        String instance = "";
        Issue issue;
        Exception error;
        State(Config config, long start) { this.config = config; this.start = start; nextRequest = start; }
        void beginRequest(long now) { inFlight = true; requestAt = now; nextRequest = now + config.interval; attempts++; }
        void reply(JSONObject value, long now) {
            if (finished || !inFlight) return;
            inFlight = false;
            if (value == null || value.optInt("protocol") != 1) { failures++; fail(Issue.INVALID_RESPONSE, new IOException("Unexpected remote protocol")); return; }
            long latency = Math.max(0, now - requestAt);
            if (latency >= config.requestTimeout) { failures++; fail(Issue.REQUEST_TIMEOUT, null); return; }
            if (!instance(value)) { failures++; return; }
            if (successes > 0) jitterTotal += Math.abs(latency - previousLatency);
            previousLatency = latency; successes++; total += latency; minimum = Math.min(minimum, latency); maximum = Math.max(maximum, latency);
            if (latency >= config.slowRequest && ++slowRequests >= 3) fail(Issue.HIGH_LATENCY, null);
        }
        void requestFailed(Exception failure) {
            if (finished) return;
            inFlight = false; failures++; fail(Issue.REQUEST_ERROR, failure);
        }
        void frame(JSONObject value, long now) {
            if (finished) return;
            if (value == null || !instance(value)) return;
            streamConnected = true; snapshots++; lastFrame = now;
        }
        void heartbeat(long now) { if (!finished) { heartbeats++; lastFrame = now; } }
        private boolean instance(JSONObject value) {
            String next = value.optString("instanceId");
            if (next.isEmpty()) return true; // Existing desktops without stamps can still test transport stability.
            if (!next.matches("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")) {
                fail(Issue.INVALID_RESPONSE, new IOException("Invalid desktop service identifier")); return false;
            }
            if (!instance.isEmpty() && !instance.equals(next)) { fail(Issue.DESKTOP_CHANGED, null); return false; }
            instance = next; return true;
        }
        void fail(Issue cause, Exception failure) { if (!finished) { issue = cause; error = failure; finished = true; } }
        void inspect(long now) {
            if (finished) return;
            if (inFlight && now - requestAt >= config.requestTimeout) { failures++; fail(Issue.REQUEST_TIMEOUT, null); }
            else if (!streamConnected && now - start >= config.streamTimeout) fail(Issue.STREAM_TIMEOUT, null);
            else if (streamConnected && now - lastFrame >= config.heartbeatTimeout) fail(Issue.HEARTBEAT_TIMEOUT, null);
            else if (now - start >= config.duration && !inFlight) {
                if (!streamConnected || successes < 2) fail(Issue.INVALID_RESPONSE, new IOException("Not enough completed connection samples"));
                else finished = true;
            }
        }
        Snapshot snapshot(long now) { return new Snapshot(this, now); }
    }

    private final Transport transport;
    private final Listener listener;
    private final Config config;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(action -> new Thread(action, "camellia-connection-test-watchdog"));
    private final ExecutorService workers = Executors.newFixedThreadPool(2, action -> new Thread(action, "camellia-connection-test"));
    private State state;

    ConnectionStabilityCheck(Transport transport, Config config, Listener listener) {
        this.transport = transport; this.config = config; this.listener = listener;
    }
    private static long now() { return System.nanoTime() / 1_000_000; }
    void start() {
        if (closed.get()) return;
        try { timer.execute(() -> {
            if (closed.get() || state != null) return;
            state = new State(config, now());
            work(() -> {
                try {
                    transport.events(new Events() {
                        @Override public void snapshot(JSONObject value) { post(() -> state.frame(value, now())); }
                        @Override public void heartbeat() { post(() -> state.heartbeat(now())); }
                    });
                    post(() -> state.fail(Issue.STREAM_ERROR, new IOException("Real-time connection closed before the test ended")));
                } catch (Exception error) { post(() -> state.fail(Issue.STREAM_ERROR, error)); }
            });
            if (!closed.get()) timer.scheduleAtFixedRate(this::tick, 0, Math.min(250, config.interval), TimeUnit.MILLISECONDS);
        }); } catch (RejectedExecutionException ignored) { }
    }
    private void work(Runnable action) {
        if (closed.get()) return;
        try { workers.execute(action); } catch (RejectedExecutionException ignored) { }
    }
    private void post(Runnable action) {
        if (closed.get()) return;
        try { timer.execute(() -> { if (!closed.get()) { action.run(); tick(); } }); }
        catch (RejectedExecutionException ignored) { }
    }
    private void tick() {
        if (closed.get()) return;
        long time = now(); state.inspect(time);
        if (state.finished) {
            Snapshot result = state.snapshot(time);
            if (closed.compareAndSet(false, true)) {
                try { listener.complete(result); }
                finally { cleanup(); }
            }
            return;
        }
        if (!state.inFlight && time >= state.nextRequest && time - state.start < config.duration) {
            state.beginRequest(time);
            work(() -> {
                try { JSONObject reply = transport.status(); post(() -> state.reply(reply, now())); }
                catch (Exception error) { post(() -> state.requestFailed(error)); }
            });
        }
        listener.progress(state.snapshot(time));
    }
    @Override public void close() { if (closed.compareAndSet(false, true)) cleanup(); }
    private void cleanup() {
        timer.shutdownNow(); workers.shutdownNow(); transport.close();
    }
}
