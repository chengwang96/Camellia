package app.camellia.mobile;

import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Encrypted per-conversation pages with coalescing writes and no live control state. */
final class RemoteConversationCache {
    static final int ENTRY_COUNT = 8, ENTRY_BYTES = 1024 * 1024, TOTAL_BYTES = 8 * 1024 * 1024;
    static final long WRITE_DELAY_MS = 750;
    private static final String INDEX = "index", PREFIX = "remote-conversation-cache-", FORMAT = "format";
    private static RemoteConversationCache shared;
    private final Storage storage;
    private final Consumer<Exception> errors;
    private final long delayMillis;
    private final Object gate = new Object();
    private final LinkedHashMap<String, Record> records = new LinkedHashMap<>();
    private final LinkedHashMap<String, Pending> pending = new LinkedHashMap<>();
    private final LinkedHashSet<String> deletions = new LinkedHashSet<>(), removedOwners = new LinkedHashSet<>();
    private final ScheduledThreadPoolExecutor writer = new ScheduledThreadPoolExecutor(1,
        task -> new Thread(task, "camellia-conversation-cache"));
    private ScheduledFuture<?> scheduled;
    private boolean indexDirty, closed;

    interface Storage {
        JSONObject load(String key) throws Exception;
        void save(String key, JSONObject value) throws Exception;
        void delete(String key) throws Exception;
    }

    private static final class Record {
        final String owner;
        final long bytes;
        Record(String owner, long bytes) { this.owner = owner; this.bytes = bytes; }
    }
    private static final class Pending {
        final String key, owner, id;
        final JSONObject snapshot;
        Pending(String key, String owner, String id, JSONObject snapshot) {
            this.key = key; this.owner = owner; this.id = id; this.snapshot = snapshot;
        }
    }
    private static final class Frozen {
        final JSONObject value;
        final long bytes;
        Frozen(JSONObject value, long bytes) { this.value = value; this.bytes = bytes; }
    }

    static synchronized RemoteConversationCache get(Context context) {
        if (shared == null) shared = new RemoteConversationCache(context);
        return shared;
    }

    RemoteConversationCache(Context context) {
        this(new Storage() {
            @Override public JSONObject load(String key) throws Exception { return new CredentialStore(context, PREFIX + key).load(); }
            @Override public void save(String key, JSONObject value) throws Exception { new CredentialStore(context, PREFIX + key).save(value); }
            @Override public void delete(String key) { new CredentialStore(context, PREFIX + key).clear(); }
        }, error -> Log.w("CamelliaConversationCache", "Conversation cache could not be read or saved", error), WRITE_DELAY_MS);
    }

    RemoteConversationCache(Storage storage, Consumer<Exception> errors, long delayMillis) {
        this.storage = storage; this.errors = errors; this.delayMillis = delayMillis;
        writer.setRemoveOnCancelPolicy(true);
        try {
            JSONObject index = storage.load(INDEX); JSONArray entries = index.optJSONArray("entries");
            for (int i = 0; entries != null && i < entries.length(); i++) {
                JSONObject entry = entries.optJSONObject(i); if (entry == null) continue;
                String key = entry.optString("key"), owner = entry.optString("owner");
                long bytes = entry.optLong("bytes", -1);
                if (key.matches("[a-f0-9]{64}") && owner.matches("[a-f0-9]{64}") && bytes >= 0 && bytes <= ENTRY_BYTES) {
                    records.put(key, new Record(owner, bytes));
                }
            }
            trim("");
            // Constructor trimming must not leave deletions waiting for an
            // unrelated write; save the compacted index immediately.
            if (indexDirty) writer.execute(() -> { try { persist(); } catch (Exception error) { errors.accept(error); } });
        } catch (Exception error) { errors.accept(error); }
    }

    private static String digest(String value) {
        try {
            StringBuilder result = new StringBuilder(64);
            for (byte item : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) {
                result.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
            }
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    private static String owner(JSONObject credentials) {
        String token = credentials.optString("token");
        return token.isEmpty() ? "" : digest(credentials.optString("address") + "\n" + token);
    }
    private static String key(String owner, String id) { return digest(owner + "\n" + id); }

    JSONObject get(JSONObject credentials, String id) {
        String owner = owner(credentials);
        if (owner.isEmpty() || id == null || !id.matches("[a-f0-9-]{36}")) return null;
        String key = key(owner, id);
        synchronized (gate) {
            if (removedOwners.contains(owner) || deletions.contains(key) || !records.containsKey(key)) return null;
        }
        try {
            JSONObject value = storage.load(key);
            if (value.optInt(FORMAT) != 1 || !key.equals(value.optString("key")) || !owner.equals(value.optString("owner"))) return null;
            JSONObject conversation = value.optJSONObject("conversation");
            if (conversation == null || !id.equals(conversation.optString("id")) || value.optJSONArray("messages") == null) return null;
            return new JSONObject(value.toString());
        } catch (Exception error) { errors.accept(error); return null; }
    }

    void put(JSONObject credentials, JSONObject snapshot) {
        if (snapshot == null || snapshot.optJSONArray("messages") == null) return;
        JSONObject conversation = snapshot.optJSONObject("conversation");
        String id = conversation == null ? "" : conversation.optString("id"), owner = owner(credentials);
        if (owner.isEmpty() || !id.matches("[a-f0-9-]{36}")) return;
        String key = key(owner, id); Pending update = new Pending(key, owner, id, snapshot);
        synchronized (gate) {
            if (closed) return;
            removedOwners.remove(owner); deletions.remove(key); pending.put(key, update);
            scheduleLocked();
        }
    }

    void remove(JSONObject credentials, String id) {
        String owner = owner(credentials); if (owner.isEmpty()) return;
        synchronized (gate) {
            if (closed) return;
            if (id == null) {
                removedOwners.add(owner);
                pending.entrySet().removeIf(entry -> entry.getValue().owner.equals(owner));
                records.entrySet().removeIf(entry -> {
                    if (!entry.getValue().owner.equals(owner)) return false;
                    deletions.add(entry.getKey()); indexDirty = true; return true;
                });
            } else {
                String key = key(owner, id); pending.remove(key); deletions.add(key);
                if (records.remove(key) != null) indexDirty = true;
            }
            scheduleLocked();
        }
    }

    /**
     * A forgotten computer must not leave decrypted-in-memory pages or
     * encrypted pages on disk once the action returns. The regular remove()
     * is asynchronous so a burst of conversation updates can coalesce; that
     * window is exactly wrong for credentials the user is deleting.
     */
    boolean removeDurably(JSONObject credentials, String id) {
        remove(credentials, id);
        return await(flush());
    }

    private Frozen frozen(Pending item) throws Exception {
        JSONObject conversation = item.snapshot.optJSONObject("conversation"), source = item.snapshot;
        if (conversation == null || !item.id.equals(conversation.optString("id"))) throw new java.io.IOException("Conversation changed while caching");
        JSONArray messages = source.optJSONArray("messages"); if (messages == null) throw new java.io.IOException("Missing conversation history");
        JSONObject value = new JSONObject().put(FORMAT, 1).put("key", item.key).put("owner", item.owner)
            .put("conversation", conversation).put("messages", messages).put("historyVersion", source.optString("historyVersion"))
            .put("instanceId", source.optString("instanceId")).put("cursor", source.optLong("cursor", -1))
            .put("savedAt", System.currentTimeMillis());
        if (source.has("nextBefore")) value.put("nextBefore", source.opt("nextBefore"));
        long bytes = value.toString().getBytes(StandardCharsets.UTF_8).length;
        if (bytes > ENTRY_BYTES) return new Frozen(null, bytes);
        return new Frozen(value, bytes);
    }

    private void trim(String protect) {
        long total = 0;
        for (Record record : records.values()) total += record.bytes;
        Iterator<Map.Entry<String, Record>> iterator = records.entrySet().iterator();
        while (iterator.hasNext() && (records.size() > ENTRY_COUNT || total > TOTAL_BYTES)) {
            Map.Entry<String, Record> oldest = iterator.next();
            if (oldest.getKey().equals(protect) && records.size() > 1) continue;
            total -= oldest.getValue().bytes; String key = oldest.getKey();
            iterator.remove(); pending.remove(key); deletions.add(key); indexDirty = true;
        }
    }

    private JSONObject index() throws Exception {
        JSONArray entries = new JSONArray();
        for (Map.Entry<String, Record> entry : records.entrySet()) {
            entries.put(new JSONObject().put("key", entry.getKey()).put("owner", entry.getValue().owner).put("bytes", entry.getValue().bytes));
        }
        return new JSONObject().put("entries", entries);
    }

    private void scheduleLocked() {
        if (scheduled != null) { scheduled.cancel(false); scheduled = null; }
        if (closed || pending.isEmpty() && deletions.isEmpty() && !indexDirty) return;
        scheduled = writer.schedule(() -> {
            synchronized (gate) { scheduled = null; }
            try { persist(); } catch (Exception ignored) { }
        }, delayMillis, TimeUnit.MILLISECONDS);
    }

    private void persist() throws Exception {
        Exception failure = null;
        for (;;) {
            Pending update = null; String deletion = null; JSONObject index = null;
            synchronized (gate) {
                if (!deletions.isEmpty()) deletion = deletions.iterator().next();
                else if (!pending.isEmpty()) update = pending.values().iterator().next();
                else if (indexDirty) { indexDirty = false; index = index(); }
                else break;
            }
            try {
                if (deletion != null) {
                    storage.delete(deletion);
                    synchronized (gate) { deletions.remove(deletion); }
                } else if (update != null) {
                    Frozen frozen = frozen(update);
                    if (frozen.value != null) storage.save(update.key, frozen.value);
                    synchronized (gate) {
                        pending.remove(update.key, update);
                        if (frozen.value != null) {
                            records.remove(update.key); records.put(update.key, new Record(update.owner, frozen.bytes));
                            indexDirty = true; trim(update.key);
                        }
                    }
                } else {
                    storage.save(INDEX, index);
                }
            } catch (Exception error) {
                synchronized (gate) { if (index != null) indexDirty = true; }
                failure = error; errors.accept(error); break;
            }
        }
        if (failure != null) throw failure;
    }

    Future<Void> flush() {
        synchronized (gate) {
            if (closed) return CompletableFuture.completedFuture(null);
            if (scheduled != null) { scheduled.cancel(false); scheduled = null; }
            if (writer.isShutdown()) {
                CompletableFuture<Void> immediate = new CompletableFuture<>();
                try { persist(); immediate.complete(null); }
                catch (Exception error) { immediate.completeExceptionally(error); }
                return immediate;
            }
            return writer.submit((Callable<Void>) () -> { persist(); return null; });
        }
    }

    private boolean await(Future<Void> work) {
        try {
            work.get(2, TimeUnit.SECONDS);
            return true;
        } catch (java.util.concurrent.ExecutionException error) {
            Throwable cause = error.getCause();
            errors.accept(cause instanceof Exception exception ? exception : error);
        } catch (java.util.concurrent.TimeoutException error) {
            errors.accept(error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            errors.accept(error);
        }
        return false;
    }

    Future<Void> close() {
        Future<Void> result;
        synchronized (gate) {
            if (closed) return CompletableFuture.completedFuture(null);
            result = flush(); closed = true; writer.shutdown();
        }
        return result;
    }
}
