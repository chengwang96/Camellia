package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Function;

/** Each paired host owns its stream, deadline and retry lane; none use the chat executors. */
final class RemoteWorkbenchSync implements AutoCloseable {
    enum State { CONNECTING, LIVE, STALE, UNAUTHORIZED }
    private static final class MissingReplyState extends IOException {
        MissingReplyState() { super("Workbench summary has no reply markers"); }
    }
    private static final class ShortRecentSummary extends IOException {
        ShortRecentSummary() { super("Older workbench summary is limited to ten recent conversations"); }
    }
    static final class Update {
        final JSONObject computer, page;
        final State state;
        final Object source;
        Update(JSONObject computer, JSONObject page, State state, Object source) {
            this.computer = computer; this.page = page; this.state = state; this.source = source;
        }
    }
    private final Function<String, RemoteApi> clients;
    private final Map<String, Host> hosts = new LinkedHashMap<>();
    private final ScheduledExecutorService deadlines = executor("camellia-home-deadlines");
    private final long openingMs, idleMs, retryMs;
    private Consumer<Update> listener;
    private int recentLimit = 3;
    private boolean closed;

    RemoteWorkbenchSync(Function<String, RemoteApi> clients) { this(clients, 12_000, 45_000, 1_000); }
    RemoteWorkbenchSync(Function<String, RemoteApi> clients, long openingMs, long idleMs, long retryMs) {
        this.clients = clients; this.openingMs = openingMs; this.idleMs = idleMs; this.retryMs = retryMs;
    }
    private static ScheduledExecutorService executor(String name) {
        return Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, name); thread.setDaemon(true); return thread;
        });
    }
    static String identity(JSONObject computer) { return computer.optString("address") + "\n" + computer.optString("token"); }
    private static long now() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }

    synchronized void start(List<JSONObject> computers, Consumer<Update> listener) {
        reconcile(computers, listener, false);
    }
    synchronized void refresh(List<JSONObject> computers, Consumer<Update> listener) {
        reconcile(computers, listener, true);
    }
    synchronized void setRecentLimit(int limit) {
        recentLimit = Math.max(3, Math.min(30, limit));
        if (recentLimit <= 10 || closed) return;
        // Expand older desktop summaries through their existing list stream.
        // Each host keeps its own worker and never touches the selected chat.
        for (Host host : new ArrayList<>(hosts.values())) {
            if (host.mode != 0 || host.recentRows != 10) continue;
            boolean fresh = host.state == State.LIVE && now() - host.contact < idleMs;
            host.close();
            Host replacement = new Host(host.computer); replacement.mode = 1;
            if (fresh) replacement.state = State.LIVE;
            hosts.put(host.key, replacement); replacement.schedule(0);
        }
    }
    private void reconcile(List<JSONObject> computers, Consumer<Update> listener, boolean force) {
        if (closed) return;
        this.listener = listener;
        Map<String, JSONObject> desired = new LinkedHashMap<>();
        for (JSONObject computer : computers) if (computer.has("token")) desired.put(identity(computer), computer);
        for (String key : new ArrayList<>(hosts.keySet())) if (!desired.containsKey(key)) hosts.remove(key).close();
        for (var entry : desired.entrySet()) {
            Host host = hosts.get(entry.getKey());
            if (host != null && !force) { host.computer = entry.getValue(); continue; }
            // A manual refresh keeps recently verified cards stable while replacing the stream.
            boolean fresh = host != null && host.state == State.LIVE && now() - host.contact < idleMs;
            if (host != null) host.close();
            host = new Host(entry.getValue());
            if (fresh) host.state = State.LIVE;
            hosts.put(entry.getKey(), host); host.schedule(0);
        }
    }

    synchronized State state(JSONObject computer) {
        Host host = hosts.get(identity(computer));
        return host == null ? State.STALE : host.state;
    }

    synchronized boolean current(Update update) { return hosts.get(identity(update.computer)) == update.source; }

    synchronized void stop() {
        for (Host host : hosts.values()) host.close();
        hosts.clear(); listener = null;
    }
    @Override public synchronized void close() { stop(); closed = true; deadlines.shutdownNow(); }

    private final class Host {
        JSONObject computer;
        final String key;
        ScheduledExecutorService worker = executor("camellia-home-host");
        RemoteApi client;
        ScheduledFuture<?> deadline;
        State state = State.CONNECTING;
        int mode, failures; // summary stream, legacy list stream, legacy polling
        int recentRows = -1;
        long contact, started;
        boolean received, disposed;

        Host(JSONObject computer) { this.computer = computer; key = identity(computer); }
        boolean valid(RemoteApi api) { return !disposed && hosts.get(key) == this && client == api; }
        void emit(JSONObject page) { if (listener != null) listener.accept(new Update(computer, page, state, this)); }
        void schedule(long delay) { if (!disposed) worker.schedule(this::watch, delay, TimeUnit.MILLISECONDS); }
        void replaceWorker() {
            ScheduledExecutorService previous = worker;
            worker = executor("camellia-home-host");
            previous.shutdownNow();
        }
        void close() {
            disposed = true;
            if (deadline != null) deadline.cancel(false);
            RemoteApi previous = client; client = null;
            worker.shutdownNow(); cancel(previous);
        }
        void watch() {
            RemoteApi api;
            synchronized (RemoteWorkbenchSync.this) {
                if (disposed) return;
                try { api = clients.apply(computer.optString("address")); }
                catch (RuntimeException error) {
                    state = State.STALE; emit(null);
                    schedule(Math.min(120_000, retryMs << Math.min(failures++, 7)));
                    return;
                }
                client = api; contact = started = now(); received = false;
                deadline = deadlines.scheduleAtFixedRate(() -> inspect(api), openingMs, Math.min(openingMs, idleMs), TimeUnit.MILLISECONDS);
            }
            Exception failure = null;
            try {
                String token = computer.optString("token");
                if (mode == 0) api.workbenchEvents(token, snapshot -> {
                    JSONObject page = snapshot.optJSONObject("workbench");
                    if (page == null) throw new IOException("Missing workbench summary");
                    JSONArray rows = page.optJSONArray("conversations");
                    int recent = 0;
                    for (int i = 0; rows != null && i < rows.length(); i++) {
                        JSONObject row = rows.optJSONObject(i);
                        if (row != null && (!row.has("lastReplyAt") || !row.has("replyReadAt"))) throw new MissingReplyState();
                        if (row != null && !active(row)) recent++;
                    }
                    synchronized (RemoteWorkbenchSync.this) {
                        if (!valid(api)) return;
                        recentRows = recent;
                        if (recentLimit > 10 && recentRows == 10) throw new ShortRecentSummary();
                    }
                    accept(api, page);
                }, () -> heartbeat(api));
                else if (mode == 1) api.listEvents(token, snapshot -> {
                    JSONObject page = snapshot.optJSONObject("conversationList");
                    if (page == null) page = api.json("/v1/conversations?offset=0", token, null);
                    accept(api, legacyPage(api, token, page));
                }, () -> heartbeat(api));
                else accept(api, legacyPage(api, token, api.json("/v1/conversations?offset=0", token, null)));
                if (mode != 2) failure = new IOException("Workbench stream closed");
            } catch (Exception error) { failure = error; }
            finish(api, failure);
        }
        void heartbeat(RemoteApi api) {
            synchronized (RemoteWorkbenchSync.this) {
                if (valid(api) && received) contact = now();
            }
        }
        void accept(RemoteApi api, JSONObject page) throws IOException {
            if (page.optJSONArray("conversations") == null) throw new IOException("Invalid workbench summary");
            synchronized (RemoteWorkbenchSync.this) {
                if (!valid(api)) return;
                received = true; contact = now(); failures = 0; state = State.LIVE;
                emit(page);
            }
        }
        void inspect(RemoteApi api) {
            synchronized (RemoteWorkbenchSync.this) {
                if (!valid(api) || now() - (received ? contact : started) < (received ? idleMs : openingMs)) return;
            }
            finish(api, new java.net.SocketTimeoutException("Workbench sync timed out"));
        }
        void finish(RemoteApi api, Exception error) {
            synchronized (RemoteWorkbenchSync.this) {
                if (!valid(api)) return;
                client = null;
                if (deadline != null) deadline.cancel(false);
                int status = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
                long delay;
                if (status == 404 && mode < 2 || (error instanceof MissingReplyState || error instanceof ShortRecentSummary) && mode == 0) { mode++; delay = 0; }
                else if (status == 401 || status == 403) {
                    state = State.UNAUTHORIZED; emit(null); cancel(api); return;
                } else if (error != null) {
                    state = State.STALE; emit(null);
                    delay = status == 429 ? 60_000 : Math.min(120_000, retryMs << Math.min(failures++, 7));
                } else {
                    // Old hosts without streams are polled independently, more slowly on a slow route.
                    delay = now() - started > 2_000 ? 30_000 : 15_000;
                }
                cancel(api); replaceWorker(); schedule(delay);
            }
        }
        JSONObject legacyPage(RemoteApi api, String token, JSONObject first) throws IOException {
            try {
                LinkedHashMap<String, JSONObject> rows = new LinkedHashMap<>();
                JSONObject page = first;
                int offset = 0;
                String instance = first.optString("instanceId");
                while (true) {
                    synchronized (RemoteWorkbenchSync.this) { if (!valid(api)) throw new IOException("Cancelled"); }
                    if (!instance.isEmpty() && !instance.equals(page.optString("instanceId", instance))) throw new IOException("Host restarted during list sync");
                    JSONArray entries = page.optJSONArray("conversations");
                    if (entries == null) throw new IOException("Invalid legacy conversation page");
                    for (int i = 0; i < entries.length(); i++) {
                        JSONObject row = entries.optJSONObject(i);
                        if (row != null && !row.optString("id").isEmpty()) rows.put(row.optString("id"), row);
                    }
                    int next = page.optInt("nextOffset", -1);
                    if (next < 0) break;
                    if (next <= offset || entries.length() == 0) throw new IOException("Invalid legacy pagination");
                    offset = next;
                    page = api.json("/v1/conversations?offset=" + offset, token, null);
                }
                ArrayList<JSONObject> sorted = new ArrayList<>(rows.values());
                sorted.sort((left, right) -> Long.compare(right.optLong("updatedAt"), left.optLong("updatedAt")));
                JSONArray selected = new JSONArray(); int recent = 0;
                for (JSONObject row : sorted) {
                    if (!active(row) && recent++ >= 30) continue;
                    JSONObject summary = new JSONObject();
                    for (String key : new String[] { "id", "title", "engine", "currentEngine", "model", "modelName", "workspaceName", "updatedAt", "activity", "lastReplyAt", "replyReadAt" })
                        if (row.has(key)) summary.put(key, row.get(key));
                    summary.put("backgroundTaskCount", RemoteWorkStatus.backgroundCount(row));
                    selected.put(summary);
                }
                return new JSONObject().put("conversations", selected);
            } catch (org.json.JSONException error) { throw new IOException("Invalid legacy summary", error); }
        }
    }

    static boolean active(JSONObject row) {
        String activity = row.optString("activity");
        return activity.equals("running") || activity.equals("permission") || activity.equals("question")
            || RemoteWorkStatus.backgroundCount(row) > 0;
    }
    private static void cancel(RemoteApi api) {
        if (api == null) return;
        Thread thread = new Thread(api::cancel, "camellia-home-disconnect"); thread.setDaemon(true); thread.start();
    }
}
