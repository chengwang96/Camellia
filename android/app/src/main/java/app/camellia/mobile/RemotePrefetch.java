package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

final class RemotePrefetch {
    private static final int LIMIT = 2 * 1024 * 1024;
    private final int budget = (int) Math.max(8 * 1024 * 1024, Math.min(32 * 1024 * 1024, Runtime.getRuntime().maxMemory() / 16));
    private final java.util.concurrent.ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>(8, .75f, true);
    private final LinkedHashMap<String, Pending> pending = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> pages = new LinkedHashMap<>();
    private final Function<String, RemoteApi> clients;
    private final long idleDelay;
    private long lastInteraction = android.os.SystemClock.elapsedRealtime();
    private ScheduledFuture<?> scheduled;
    private RemoteApi active;
    private long generation;
    private int size;

    private static final class Pending {
        final JSONObject computer, row;
        final int offset;
        final boolean immediate;
        Pending(JSONObject computer, JSONObject row, int offset, boolean immediate) {
            this.computer = computer; this.row = row; this.offset = offset; this.immediate = immediate;
        }
    }

    private static final class Entry {
        final String json, version;
        final long at = android.os.SystemClock.elapsedRealtime();
        Entry(String json, String version) { this.json = json; this.version = version; }
    }

    RemotePrefetch() { this(RemoteApi::new); }
    RemotePrefetch(Function<String, RemoteApi> clients) { this(clients, 2000); }
    RemotePrefetch(Function<String, RemoteApi> clients, long idleDelay) { this.clients = clients; this.idleDelay = idleDelay; }

    private String owner(JSONObject computer) { return computer.optString("address") + "/" + computer.optString("token") + "/"; }
    private String version(JSONObject row) {
        return row.optLong("seq") + ":" + row.optLong("updatedAt") + ":" + row.optString("activity");
    }

    synchronized JSONObject get(JSONObject computer, String id) {
        Entry entry = entries.get(owner(computer) + id);
        if (entry == null) return null;
        try { return new JSONObject(entry.json); } catch (Exception ignored) { return null; }
    }

    synchronized void put(JSONObject computer, JSONObject snapshot) {
        JSONObject row = snapshot.optJSONObject("conversation");
        if (row == null || !computer.has("token") || snapshot.optJSONArray("messages") == null) return;
        try {
            String json = new JSONObject().put("conversation", row).put("messages", snapshot.getJSONArray("messages")).toString();
            if (json.length() > LIMIT) return;
            String key = owner(computer) + row.optString("id");
            Entry previous = entries.remove(key);
            if (previous != null) size -= previous.json.length();
            entries.put(key, new Entry(json, version(row))); size += json.length();
            while (size > budget) {
                var iterator = entries.entrySet().iterator();
                size -= iterator.next().getValue().json.length(); iterator.remove();
            }
        } catch (Exception ignored) { }
    }

    synchronized void remove(JSONObject computer, String id) {
        String prefix = owner(computer);
        pending.entrySet().removeIf(entry -> id == null ? entry.getKey().startsWith(prefix) : entry.getKey().equals(prefix + id));
        if (id == null) pages.keySet().removeIf(key -> key.startsWith(prefix));
        var iterator = entries.entrySet().iterator();
        while (iterator.hasNext()) {
            var entry = iterator.next();
            if (id == null ? entry.getKey().startsWith(prefix) : entry.getKey().equals(prefix + id)) {
                size -= entry.getValue().json.length(); iterator.remove();
            }
        }
    }

    synchronized void schedule(JSONObject computer, JSONArray rows) { schedule(computer, rows, -1); }

    synchronized void schedule(JSONObject computer, JSONArray rows, int nextOffset) {
        schedule(computer, rows, nextOffset, true);
    }

    synchronized void scheduleIdle(JSONObject computer, JSONArray rows, int nextOffset) {
        schedule(computer, rows, nextOffset, false);
    }

    private void schedule(JSONObject computer, JSONArray rows, int nextOffset, boolean initial) {
        if (!computer.has("token") || worker.isShutdown()) return;
        try {
            JSONObject identity = new JSONObject(computer.toString());
            enqueue(identity, rows, initial);
            enqueuePage(identity, nextOffset);
            if (scheduled != null && pending.values().stream().anyMatch(item -> item.immediate)) { scheduled.cancel(false); scheduled = null; }
            pump();
        } catch (Exception ignored) { }
    }

    private void enqueue(JSONObject identity, JSONArray rows, boolean initial) throws org.json.JSONException {
        java.util.ArrayList<JSONObject> candidates = new java.util.ArrayList<>();
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row != null) candidates.add(row);
        }
        candidates.sort((first, second) -> Long.compare(second.optLong("updatedAt"), first.optLong("updatedAt")));
        for (int index = 0; index < candidates.size(); index++) {
            JSONObject row = candidates.get(index);
            if (!row.optString("id").matches("[a-f0-9-]{36}") || fresh(identity, row)) continue;
            String key = owner(identity) + row.optString("id");
            Pending previous = pending.get(key);
            pending.put(key, new Pending(identity, new JSONObject(row.toString()), -1, (initial && index < 10) || (previous != null && previous.immediate)));
        }
    }

    private boolean fresh(JSONObject computer, JSONObject row) {
        Entry entry = entries.get(owner(computer) + row.optString("id"));
        return entry != null && entry.version.equals(version(row)) && android.os.SystemClock.elapsedRealtime() - entry.at < 60_000;
    }

    private void enqueuePage(JSONObject computer, int offset) {
        if (offset < 0) return;
        String key = owner(computer) + "page:" + offset;
        Long loaded = pages.get(key);
        if (loaded == null || android.os.SystemClock.elapsedRealtime() - loaded >= 60_000) pending.putIfAbsent(key, new Pending(computer, null, offset, false));
    }

    synchronized void interaction() {
        lastInteraction = android.os.SystemClock.elapsedRealtime();
        if (scheduled != null) { scheduled.cancel(false); scheduled = null; }
        pump();
    }

    private void pump() {
        if (active != null || scheduled != null || pending.isEmpty() || worker.isShutdown()) return;
        boolean immediate = pending.values().stream().anyMatch(item -> item.immediate);
        long delay = immediate ? 0 : Math.max(500, idleDelay - (android.os.SystemClock.elapsedRealtime() - lastInteraction));
        long ticket = generation;
        scheduled = worker.schedule(() -> fetchNext(ticket), delay, TimeUnit.MILLISECONDS);
    }

    private void fetchNext(long ticket) {
        Pending selected;
        RemoteApi client;
        synchronized (this) {
            if (ticket != generation) return;
            scheduled = null;
            selected = pending.values().stream().filter(item -> item.immediate).findFirst().orElse(null);
            if (selected == null) {
                if (pending.isEmpty()) return;
                if (android.os.SystemClock.elapsedRealtime() - lastInteraction < idleDelay) { pump(); return; }
                selected = pending.values().iterator().next();
            }
            pending.values().remove(selected);
            if (selected.row != null && fresh(selected.computer, selected.row)) { pump(); return; }
            client = clients.apply(selected.computer.optString("address")); active = client;
        }
        JSONObject identity = selected.computer;
        String id = selected.row == null ? null : selected.row.optString("id");
        try {
            JSONObject snapshot = client.json(id == null ? "/v1/conversations?offset=" + selected.offset : "/v1/conversations/" + id, identity.optString("token"), null);
            synchronized (this) {
                if (ticket != generation) return;
                if (id == null) {
                    JSONArray rows = snapshot.optJSONArray("conversations");
                    if (rows != null) {
                        pages.put(owner(identity) + "page:" + selected.offset, android.os.SystemClock.elapsedRealtime());
                        enqueue(identity, rows, false);
                        int next = snapshot.optInt("nextOffset", -1);
                        if (next > selected.offset) enqueuePage(identity, next);
                    }
                } else if (snapshot.optJSONObject("conversation") != null && id.equals(snapshot.optJSONObject("conversation").optString("id"))) put(identity, snapshot);
            }
        } catch (Exception error) {
            synchronized (this) {
                if (ticket != generation) return;
                int status = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
                if (status == 404 && id != null) remove(identity, id);
                else {
                    pending.entrySet().removeIf(entry -> entry.getKey().startsWith(owner(identity)));
                    if (status == 401 || status == 403) remove(identity, null);
                }
            }
        } finally {
            client.cancel();
            synchronized (this) { if (active == client) { active = null; pump(); } }
        }
    }

    synchronized void cancel() {
        generation++;
        pending.clear();
        pages.clear();
        if (scheduled != null) { scheduled.cancel(false); scheduled = null; }
        RemoteApi previous = active; active = null;
        if (previous != null) new Thread(previous::cancel, "camellia-prefetch-cancel").start();
    }

    synchronized void close() { cancel(); entries.clear(); size = 0; worker.shutdownNow(); }
}
