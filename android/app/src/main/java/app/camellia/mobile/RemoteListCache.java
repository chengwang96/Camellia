package app.camellia.mobile;

import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Immutable per-computer entries and one process-owned, coalescing disk writer. */
final class RemoteListCache {
    static final long WRITE_DELAY_MS = 250;
    private static RemoteListCache shared;
    private final Storage storage;
    private final Consumer<Exception> errors;
    private final ScheduledThreadPoolExecutor writer = new ScheduledThreadPoolExecutor(1,
        task -> new Thread(task, "camellia-list-cache"));
    private final Object gate = new Object();
    private final LinkedHashMap<String, String> entries = new LinkedHashMap<>();
    private final long delayNanos;
    private long revision, saved, writingRevision, scheduleToken, dirtyAt = -1;
    private boolean writing, closed;
    private ScheduledFuture<?> scheduled;
    private CompletableFuture<Void> activeFlush, pendingFlush, closing;

    interface Storage {
        JSONObject load() throws Exception;
        void save(JSONObject value) throws Exception;
    }

    static synchronized RemoteListCache get(Context context) {
        if (shared == null) shared = new RemoteListCache(new CredentialStore(context, "remote-list-cache"));
        return shared;
    }

    RemoteListCache(CredentialStore storage) {
        this(new Storage() {
            @Override public JSONObject load() throws Exception { return storage.load(); }
            @Override public void save(JSONObject value) throws Exception { storage.save(value); }
        }, error -> Log.w("CamelliaListCache", "Remote list cache could not be read or saved", error), WRITE_DELAY_MS);
    }

    RemoteListCache(Storage storage, Consumer<Exception> errors, long delayMillis) {
        this.storage = storage; this.errors = errors; delayNanos = TimeUnit.MILLISECONDS.toNanos(delayMillis);
        writer.setRemoveOnCancelPolicy(true);
        try {
            JSONObject loaded = storage.load(); Iterator<String> keys = loaded.keys();
            while (keys.hasNext()) {
                String key = keys.next(); JSONObject entry = loaded.optJSONObject(key);
                if (entry != null) entries.put(key, entry.toString());
                if (entries.size() > 20) entries.remove(entries.keySet().iterator().next());
            }
        } catch (Exception error) { errors.accept(error); }
    }

    private static String key(JSONObject credentials) { return credentials.optString("address") + "/" + credentials.optString("token"); }

    JSONObject get(JSONObject credentials) {
        String value; synchronized (gate) { value = entries.get(key(credentials)); }
        try { return value == null ? null : new JSONObject(value); }
        catch (Exception error) { errors.accept(error); return null; }
    }

    void put(JSONObject credentials, JSONArray conversations, int nextOffset, JSONArray workspaces, boolean independent) {
        if (!credentials.has("token")) return;
        try {
            JSONArray bounded = new JSONArray();
            for (int index = 0; index < Math.min(1000, conversations.length()); index++) bounded.put(conversations.get(index));
            String value = new JSONObject().put("conversations", bounded)
                .put("nextOffset", conversations.length() > 1000 ? 1000 : nextOffset)
                .put("workspaces", workspaces).put("includeUnassigned", independent).toString();
            if (value == null) throw new java.io.IOException("Invalid remote list cache entry");
            String key = key(credentials);
            synchronized (gate) {
                if (closed) return;
                if (!value.equals(entries.get(key))) {
                    entries.put(key, value);
                    while (entries.size() > 20) {
                        Iterator<String> keys = entries.keySet().iterator(); String evicted = keys.next();
                        if (evicted.equals(key)) evicted = keys.next(); entries.remove(evicted);
                    }
                    changedLocked();
                }
                scheduleLocked(false);
            }
        } catch (Exception error) { errors.accept(error); }
    }

    void remove(JSONObject credentials) {
        synchronized (gate) {
            if (closed || entries.remove(key(credentials)) == null) return;
            changedLocked(); scheduleLocked(false);
        }
    }

    private void changedLocked() { revision++; if (dirtyAt < 0) dirtyAt = System.nanoTime(); }

    private void scheduleLocked(boolean immediate) {
        if (writing || revision == saved) return;
        if (immediate && scheduled != null) { scheduled.cancel(false); scheduled = null; }
        if (scheduled != null) return;
        if (dirtyAt < 0) dirtyAt = System.nanoTime();
        long delay = immediate ? 0 : Math.max(0, delayNanos - (System.nanoTime() - dirtyAt));
        long token = ++scheduleToken;
        scheduled = writer.schedule(() -> persist(token), delay, TimeUnit.NANOSECONDS);
    }

    private void persist(long token) {
        Map<String, String> snapshot; long version;
        synchronized (gate) {
            // A cancelled timer may already be waiting for this gate. It must not consume a newer task's state.
            if (token != scheduleToken) return;
            scheduled = null; writing = true; writingRevision = version = revision;
            snapshot = new LinkedHashMap<>(entries); dirtyAt = -1;
            activeFlush = pendingFlush; pendingFlush = null;
        }
        Exception failure = null;
        try {
            JSONObject value = new JSONObject();
            for (Map.Entry<String, String> entry : snapshot.entrySet()) value.put(entry.getKey(), new JSONObject(entry.getValue()));
            storage.save(value);
        } catch (Exception error) { failure = error; }
        CompletableFuture<Void> completed, closeCompleted = null;
        synchronized (gate) {
            writing = false; completed = activeFlush; activeFlush = null;
            if (failure == null) saved = version;
            if (revision > version) scheduleLocked(closed || pendingFlush != null);
            else {
                dirtyAt = -1;
                if (closed) { writer.shutdown(); closeCompleted = closing; }
            }
        }
        complete(completed, failure); complete(closeCompleted, failure);
        if (failure != null) errors.accept(failure);
    }

    /** Completes after this request's latest state is saved, or the write reports failure. */
    CompletableFuture<Void> flush() {
        synchronized (gate) {
            if (closed) return closing;
            if (revision == saved) return CompletableFuture.completedFuture(null);
            if (writing && revision == writingRevision) {
                if (activeFlush == null) activeFlush = new CompletableFuture<>();
                return activeFlush;
            }
            if (pendingFlush == null) pendingFlush = new CompletableFuture<>();
            scheduleLocked(true); return pendingFlush;
        }
    }

    // Private instances can be closed; the default process cache is flushed by Activity lifecycle events.
    CompletableFuture<Void> close() {
        synchronized (gate) {
            if (closed) return closing;
            closed = true; closing = new CompletableFuture<>();
            if (!writing && revision == saved) {
                writer.shutdown(); closing.complete(null);
            } else scheduleLocked(true);
            return closing;
        }
    }

    private static void complete(CompletableFuture<Void> future, Exception failure) {
        if (future == null) return;
        if (failure == null) future.complete(null); else future.completeExceptionally(failure);
    }
}
