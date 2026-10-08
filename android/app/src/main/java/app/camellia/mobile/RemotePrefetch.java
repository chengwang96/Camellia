package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.LongSupplier;

/** One visible computer, a bounded viewport selection, and memory-only conversation previews. */
final class RemotePrefetch {
    static final int VISIBLE_LIMIT = 4, NEARBY_LIMIT = 2, ENTRY_COUNT = 8;
    static final int RESPONSE_LIMIT = 1024 * 1024, ENTRY_LIMIT = 1024 * 1024;
    private final long budget;
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1);
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>(8, .75f, true);
    private final LinkedHashMap<String, Pending> desired = new LinkedHashMap<>(), pending = new LinkedHashMap<>();
    private final Function<String, RemoteApi> clients;
    private final LongSupplier clock;
    private final long idleDelay;
    private long lastInteraction, generation, scheduleToken, size;
    private ScheduledFuture<?> scheduled;
    private RemoteApi active;
    private Pending activeItem;
    private boolean cancelling;

    private static final class Pending {
        final String address, token, id, version, key;
        boolean immediate, attempted;
        Pending(String address, String token, String id, String version) {
            this.address = address; this.token = token; this.id = id; this.version = version;
            key = address + "/" + token + "/" + id;
        }
    }
    private static final class Entry {
        final String json, version;
        final long at, bytes;
        Entry(String key, String json, String version, long at) {
            this.json = json; this.version = version; this.at = at;
            bytes = 2L * (key.length() + json.length() + version.length()) + 256;
        }
    }

    RemotePrefetch() { this(RemoteApi::new); }
    RemotePrefetch(Function<String, RemoteApi> clients) { this(clients, 2000); }
    RemotePrefetch(Function<String, RemoteApi> clients, long idleDelay) {
        this(clients, idleDelay, android.os.SystemClock::elapsedRealtime, Runtime.getRuntime().maxMemory());
    }
    RemotePrefetch(Function<String, RemoteApi> clients, long idleDelay, LongSupplier clock, long heap) {
        this.clients = clients; this.idleDelay = idleDelay; this.clock = clock;
        budget = Math.max(2L * 1024 * 1024, Math.min(8L * 1024 * 1024, heap / 32));
        lastInteraction = clock.getAsLong(); worker.setRemoveOnCancelPolicy(true);
    }

    private static String owner(JSONObject computer) { return computer.optString("address") + "/" + computer.optString("token") + "/"; }
    private static String version(JSONObject row) { return row.optLong("seq") + ":" + row.optLong("updatedAt") + ":" + row.optString("activity"); }

    JSONObject get(JSONObject computer, String id) {
        Entry entry; synchronized (this) { entry = entries.get(owner(computer) + id); }
        if (entry == null) return null;
        try { return new JSONObject(entry.json); } catch (org.json.JSONException error) { return null; }
    }

    void put(JSONObject computer, JSONObject snapshot) {
        JSONObject row = snapshot.optJSONObject("conversation");
        if (row == null || !computer.has("token") || snapshot.optJSONArray("messages") == null) return;
        String key = owner(computer) + row.optString("id");
        Entry entry = freeze(key, snapshot);
        synchronized (this) { if (!worker.isShutdown()) install(key, entry); }
    }

    private Entry freeze(String key, JSONObject snapshot) {
        JSONObject row = snapshot.optJSONObject("conversation"); JSONArray messages = snapshot.optJSONArray("messages");
        if (row == null || messages == null) return null;
        // Skip plainly oversized text before constructing another complete JSON string.
        long text = 0;
        for (int index = 0; index < messages.length(); index++) {
            JSONObject message = messages.optJSONObject(index);
            if (message != null) text += 2L * message.optString("text").length();
            if (text > ENTRY_LIMIT) return null;
        }
        try {
            String json = new JSONObject().put("conversation", row).put("messages", messages).toString();
            if (json == null || 2L * json.length() > ENTRY_LIMIT) return null;
            Entry entry = new Entry(key, json, version(row), clock.getAsLong());
            return entry.bytes <= ENTRY_LIMIT ? entry : null;
        } catch (org.json.JSONException error) { return null; }
    }

    private void install(String key, Entry entry) {
        Entry previous = entries.remove(key); if (previous != null) size -= previous.bytes;
        if (entry == null) return;
        entries.put(key, entry); size += entry.bytes;
        while (entries.size() > ENTRY_COUNT || size > budget) {
            var iterator = entries.entrySet().iterator(); size -= iterator.next().getValue().bytes; iterator.remove();
        }
    }

    synchronized void remove(JSONObject computer, String id) {
        String prefix = owner(computer), key = id == null ? null : prefix + id;
        desired.keySet().removeIf(value -> key == null ? value.startsWith(prefix) : value.equals(key));
        pending.keySet().removeIf(value -> key == null ? value.startsWith(prefix) : value.equals(key));
        var iterator = entries.entrySet().iterator();
        while (iterator.hasNext()) {
            var entry = iterator.next();
            if (key == null ? entry.getKey().startsWith(prefix) : entry.getKey().equals(key)) { size -= entry.getValue().bytes; iterator.remove(); }
        }
        cancelUnwanted(); resetTimer(); pump();
    }

    /** Replaces the previous viewport; input order is the actual displayed order. Never loads list pages. */
    synchronized void schedule(JSONObject computer, JSONArray visible, JSONArray nearby) {
        if (worker.isShutdown()) return;
        if (!computer.has("token")) { cancel(); return; }
        var previous = new LinkedHashMap<>(desired); desired.clear(); pending.clear();
        include(computer, visible, VISIBLE_LIMIT, true, previous);
        include(computer, nearby, NEARBY_LIMIT, false, previous);
        for (Pending item : desired.values()) if (!item.attempted && !fresh(item) && item != activeItem) pending.put(item.key, item);
        cancelUnwanted(); resetTimer(); pump();
    }

    private void include(JSONObject computer, JSONArray rows, int limit, boolean immediate, LinkedHashMap<String, Pending> previous) {
        for (int index = 0; index < Math.min(limit, rows.length()); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            String id = row.optString("id");
            if (!id.matches("[a-f0-9-]{36}")) continue;
            String address = computer.optString("address"), token = computer.optString("token"), key = owner(computer) + id;
            if (desired.containsKey(key)) continue;
            String version = version(row); Pending item = previous.get(key);
            if (item == null || !item.version.equals(version)) item = new Pending(address, token, id, version);
            else {
                Entry cached = entries.get(key);
                if (cached != null && clock.getAsLong() - cached.at >= 60_000) item.attempted = false;
            }
            item.immediate = immediate; desired.put(key, item);
        }
    }

    private boolean fresh(Pending item) {
        Entry entry = entries.get(item.key);
        return entry != null && entry.version.equals(item.version) && clock.getAsLong() - entry.at < 60_000;
    }

    synchronized void interaction() { lastInteraction = clock.getAsLong(); resetTimer(); pump(); }
    private void resetTimer() {
        scheduleToken++;
        if (scheduled != null) { scheduled.cancel(false); scheduled = null; }
    }
    private void cancelUnwanted() {
        if (active != null && desired.get(activeItem.key) != activeItem && !cancelling) {
            cancelling = true;
            RemoteApi previous = active; new Thread(previous::cancel, "camellia-prefetch-cancel").start();
        }
    }

    private void pump() {
        if (active != null || scheduled != null || pending.isEmpty() || worker.isShutdown()) return;
        boolean immediate = pending.values().stream().anyMatch(item -> item.immediate);
        long delay = immediate ? 0 : Math.max(1, idleDelay - (clock.getAsLong() - lastInteraction));
        long token = ++scheduleToken; scheduled = worker.schedule(() -> fetchNext(token), delay, TimeUnit.MILLISECONDS);
    }

    private void fetchNext(long token) {
        Pending selected; RemoteApi client; long ticket;
        synchronized (this) {
            if (token != scheduleToken || worker.isShutdown()) return;
            scheduled = null;
            selected = pending.values().stream().filter(item -> item.immediate).findFirst().orElse(null);
            if (selected == null) {
                if (pending.isEmpty()) return;
                if (clock.getAsLong() - lastInteraction < idleDelay) { pump(); return; }
                selected = pending.values().iterator().next();
            }
            pending.remove(selected.key);
            if (fresh(selected)) { pump(); return; }
            client = clients.apply(selected.address); active = client; activeItem = selected; cancelling = false;
            selected.attempted = true; ticket = generation;
        }
        try {
            JSONObject snapshot = client.json("/v1/conversations/" + selected.id, selected.token, null, RESPONSE_LIMIT);
            JSONObject row = snapshot.optJSONObject("conversation");
            if (row == null || !selected.id.equals(row.optString("id"))) return;
            Entry entry = freeze(selected.key, snapshot);
            synchronized (this) {
                if (ticket == generation && desired.get(selected.key) == selected) install(selected.key, entry);
            }
        } catch (java.io.IOException error) {
            synchronized (this) {
                if (ticket == generation && desired.get(selected.key) == selected) {
                    int status = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
                    if (status == 404) remove(identity(selected), selected.id);
                    else if (status == 401 || status == 403) remove(identity(selected), null);
                }
            }
        } finally {
            client.cancel();
            synchronized (this) { active = null; activeItem = null; cancelling = false; pump(); }
        }
    }

    private static JSONObject identity(Pending item) {
        try { return new JSONObject().put("address", item.address).put("token", item.token); }
        catch (org.json.JSONException error) { throw new IllegalStateException(error); }
    }
    synchronized void cancel() {
        generation++; desired.clear(); pending.clear(); resetTimer(); cancelUnwanted();
    }
    synchronized void close() { cancel(); entries.clear(); size = 0; worker.shutdownNow(); }
}
