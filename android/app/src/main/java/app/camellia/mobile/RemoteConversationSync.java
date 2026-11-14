package app.camellia.mobile;

import org.json.JSONObject;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Function;

/** Silent list subscription for surfaces that also have their own chat stream. */
final class RemoteConversationSync implements AutoCloseable {
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final Function<String, RemoteApi> clients;
    private RemoteApi client;
    private long generation;
    private String identity = "";

    RemoteConversationSync(Function<String, RemoteApi> clients) { this.clients = clients; }

    synchronized void start(String address, String token, Consumer<JSONObject> listener) {
        String key = address + "\n" + token;
        if (client != null && identity.equals(key)) return;
        stop();
        identity = key;
        RemoteApi next = clients.apply(address);
        client = next;
        long ticket = generation;
        worker.execute(() -> watch(next, token, ticket, listener, 0, false));
    }

    private synchronized boolean current(long ticket) { return generation == ticket && client != null; }

    private void watch(RemoteApi api, String token, long ticket, Consumer<JSONObject> listener, int attempt, boolean polling) {
        if (!current(ticket)) return;
        boolean[] received = { false };
        boolean fallback = polling;
        long delay;
        try {
            if (polling) {
                JSONObject page = api.json("/v1/conversations?offset=0", token, null);
                if (current(ticket)) listener.accept(page);
            } else {
                api.listEvents(token, snapshot -> {
                    if (!current(ticket)) return;
                    received[0] = true;
                    JSONObject page = snapshot.optJSONObject("conversationList");
                    if (page == null) page = api.json("/v1/conversations?offset=0", token, null);
                    if (current(ticket)) listener.accept(page);
                });
            }
            delay = polling ? 15_000 : 1_000;
        } catch (Exception error) {
            int status = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
            if (status == 401 || status == 403 || status == 404 && received[0]) return;
            fallback |= status == 404;
            delay = status == 429 ? 60_000 : fallback ? 15_000 : Math.min(30_000, 1000L << Math.min(attempt, 5));
        }
        if (!current(ticket)) return;
        boolean pollNext = fallback;
        int nextAttempt = received[0] ? 0 : Math.min(attempt + 1, 5);
        worker.schedule(() -> watch(api, token, ticket, listener, nextAttempt, pollNext), delay, TimeUnit.MILLISECONDS);
    }

    synchronized void stop() {
        generation++;
        RemoteApi previous = client;
        client = null;
        identity = "";
        if (previous != null) new Thread(previous::cancel, "camellia-list-disconnect").start();
    }

    @Override public void close() { stop(); worker.shutdownNow(); }
}
