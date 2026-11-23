package app.camellia.mobile;

import org.json.JSONObject;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Silent conversation-list subscription for surfaces that also have a chat
 * stream. Each replacement owns a fresh API client and worker, so a read that
 * never returns cannot block every later retry of this subscription.
 */
final class RemoteConversationSync implements AutoCloseable {
    private static final long REUSE_GRACE_MS = 5_000;
    private ScheduledExecutorService worker = timer("camellia-list-sync");
    private final ScheduledExecutorService retries = timer("camellia-list-sync-retry");
    private final Function<String, RemoteApi> clients;
    private RemoteApi client;
    private long generation;
    private String address = "", token = "", identity = "";
    private Consumer<JSONObject> listener;
    private RemoteStreamHealth health;
    private ScheduledFuture<?> inspection;
    private boolean polling;

    RemoteConversationSync(Function<String, RemoteApi> clients) { this.clients = clients; }

    private static ScheduledExecutorService timer(String name) {
        return Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, name); thread.setDaemon(true); return thread;
        });
    }
    private static long now() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }

    synchronized void start(String address, String token, Consumer<JSONObject> listener) {
        String key = address + "\n" + token;
        long current = now();
        if (client != null && identity.equals(key) && health != null
                && (health.fresh(current, REUSE_GRACE_MS)
                    || !health.synced() && health.remaining(current) > 0)) return;
        begin(address, token, listener, false);
    }

    private synchronized void begin(String address, String token, Consumer<JSONObject> listener, boolean poll) {
        stop();
        this.address = address;
        this.token = token;
        this.listener = listener;
        identity = address + "\n" + token;
        polling = poll;
        RemoteApi next = clients.apply(address);
        client = next;
        long ticket = generation;
        health = new RemoteStreamHealth(now());
        inspect(ticket);
        worker.execute(() -> watch(next, ticket, listener, 0, poll));
    }

    private synchronized boolean current(long ticket) { return generation == ticket && client != null; }

    private void inspect(long ticket) {
        synchronized (this) {
            if (generation != ticket || client == null || health == null) return;
            long remaining = health.remaining(now());
            if (remaining > 0) {
                inspection = retries.schedule(() -> inspect(ticket), remaining, TimeUnit.MILLISECONDS);
                return;
            }
        }
        restart(ticket, polling, 0);
    }

    private void restart(long ticket, boolean poll, long delay) {
        retries.schedule(() -> {
            synchronized (RemoteConversationSync.this) {
                if (generation != ticket || client == null) return;
                begin(address, token, listener, poll);
            }
        }, delay, TimeUnit.MILLISECONDS);
    }

    private void watch(RemoteApi api, long ticket, Consumer<JSONObject> listener, int attempt, boolean poll) {
        if (!current(ticket)) return;
        boolean[] received = { false };
        boolean fallback = poll;
        long delay;
        try {
            if (poll) {
                JSONObject page = api.json("/v1/conversations?offset=0", token, null);
                if (current(ticket)) listener.accept(page);
            } else {
                api.listEvents(token, snapshot -> {
                    if (!current(ticket)) return;
                    received[0] = true;
                    synchronized (RemoteConversationSync.this) {
                        if (health != null) health.snapshot(now());
                    }
                    JSONObject page = snapshot.optJSONObject("conversationList");
                    if (page == null) page = api.json("/v1/conversations?offset=0", token, null);
                    if (current(ticket)) listener.accept(page);
                }, () -> {
                    synchronized (RemoteConversationSync.this) {
                        if (health != null) health.heartbeat(now());
                    }
                });
            }
            delay = 1_000;
        } catch (Exception error) {
            int status = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
            if (status == 401 || status == 403 || status == 404 && received[0]) {
                stop();
                return;
            }
            fallback |= status == 404;
            delay = status == 429 ? 60_000 : fallback ? 15_000 : Math.min(30_000, 1_000L << Math.min(attempt, 5));
        }
        if (!current(ticket)) return;
        int nextAttempt = received[0] ? 0 : Math.min(attempt + 1, 5);
        restart(ticket, fallback, delay);
    }

    synchronized void stop() {
        if (inspection != null) { inspection.cancel(false); inspection = null; }
        generation++;
        RemoteApi previous = client;
        client = null;
        identity = "";
        address = "";
        token = "";
        listener = null;
        health = null;
        polling = false;
        ScheduledExecutorService previousWorker = worker;
        worker = timer("camellia-list-sync");
        previousWorker.shutdownNow();
        if (previous != null) new Thread(previous::cancel, "camellia-list-disconnect").start();
    }

    @Override public synchronized void close() {
        stop();
        worker.shutdownNow();
        retries.shutdownNow();
    }
}
