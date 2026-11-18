package app.camellia.mobile;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

public class RemoteConversationCacheTest {
    private final List<RemoteConversationCache> caches = new ArrayList<>();

    @After public void cleanup() throws Exception {
        for (RemoteConversationCache cache : caches) {
            try { cache.close().get(5, TimeUnit.SECONDS); } catch (ExecutionException expected) { }
            assertTrue(executor(cache).awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    @Test public void roundTripRestoresRecoveryMetadataWithoutLiveControlsAndScopesCredentials() throws Exception {
        Storage storage = new Storage(); RemoteConversationCache cache = cache(storage);
        JSONObject owner = owner("a"), snapshot = snapshot(id(1), "Persisted reply");
        cache.put(owner, snapshot); cache.flush().get(5, TimeUnit.SECONDS);
        RemoteConversationCache reopened = cache(storage);
        JSONObject restored = reopened.get(owner, id(1));
        assertEquals("Persisted reply", restored.getJSONArray("messages").getJSONObject(0).getString("text"));
        assertEquals(snapshot.getString("historyVersion"), restored.getString("historyVersion"));
        assertEquals("server", restored.getString("instanceId")); assertEquals(7, restored.getLong("cursor"));
        assertTrue(restored.has("nextBefore") && restored.isNull("nextBefore"));
        assertFalse(restored.has("live")); assertFalse(restored.has("permission"));
        assertNull(reopened.get(owner("b"), id(1)));
        for (String key : storage.values.keySet()) assertFalse(key.contains(owner.getString("token")));
    }

    @Test public void burstsCoalesceAndOversizeOrFailedWritesPreserveThePreviousSnapshot() throws Exception {
        Storage storage = new Storage(); RemoteConversationCache cache = cache(storage);
        for (int index = 0; index < 100; index++) cache.put(owner("a"), snapshot(id(1), "version-" + index));
        cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals(1, storage.entrySaves.get());
        assertEquals("version-99", text(cache.get(owner("a"), id(1))));

        cache.put(owner("a"), snapshot(id(1), "x".repeat(RemoteConversationCache.ENTRY_BYTES + 100)));
        cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals("version-99", text(cache.get(owner("a"), id(1))));

        storage.failNextEntry = true;
        cache.put(owner("a"), snapshot(id(1), "failed-version"));
        try { cache.flush().get(5, TimeUnit.SECONDS); fail("Expected a write failure"); }
        catch (ExecutionException expected) { assertTrue(expected.getCause() instanceof IOException); }
        assertEquals("version-99", text(cache.get(owner("a"), id(1))));
        cache.put(owner("a"), snapshot(id(1), "recovered-version")); cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals("recovered-version", text(cache.get(owner("a"), id(1))));
    }

    @Test public void entryBoundsEvictTheOldestConversationAndItsPendingContent() throws Exception {
        Storage storage = new Storage(); RemoteConversationCache cache = cache(storage);
        for (int index = 0; index <= RemoteConversationCache.ENTRY_COUNT; index++) {
            cache.put(owner("a"), snapshot(id(index), "conversation-" + index));
        }
        cache.flush().get(5, TimeUnit.SECONDS);
        assertNull(cache.get(owner("a"), id(0)));
        assertEquals("conversation-" + RemoteConversationCache.ENTRY_COUNT, text(cache.get(owner("a"), id(RemoteConversationCache.ENTRY_COUNT))));
        assertEquals(RemoteConversationCache.ENTRY_COUNT + 1, storage.values.size());
        assertEquals(RemoteConversationCache.ENTRY_COUNT, storage.values.get("index").getJSONArray("entries").length());
    }

    @Test public void removalsHideImmediatelyAndSurviveReopening() throws Exception {
        Storage storage = new Storage(); RemoteConversationCache cache = cache(storage);
        cache.put(owner("a"), snapshot(id(1), "first")); cache.put(owner("a"), snapshot(id(2), "second"));
        cache.flush().get(5, TimeUnit.SECONDS);
        cache.remove(owner("a"), id(1));
        assertNull(cache.get(owner("a"), id(1))); assertEquals("second", text(cache.get(owner("a"), id(2))));
        cache.flush().get(5, TimeUnit.SECONDS);
        assertNull(cache(storage).get(owner("a"), id(1)));
        cache.remove(owner("a"), null); assertNull(cache.get(owner("a"), id(2)));
        cache.flush().get(5, TimeUnit.SECONDS);
        assertNull(cache(storage).get(owner("a"), id(2)));
        cache.put(owner("a"), snapshot(id(2), "new-pairing-state")); cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals("new-pairing-state", text(cache.get(owner("a"), id(2))));
    }

    @Test public void durableRemovalIsSavedBeforeTheProcessCanDie() throws Exception {
        Storage storage = new Storage(); RemoteConversationCache cache = cache(storage);
        cache.put(owner("a"), snapshot(id(1), "forgotten"));
        cache.flush().get(5, TimeUnit.SECONDS);
        assertTrue(cache.removeDurably(owner("a"), null));
        assertNull(cache.get(owner("a"), id(1)));
        // Reopening without any further flush models process death immediately
        // after the Forget action.
        RemoteConversationCache reopened = cache(storage);
        assertNull(reopened.get(owner("a"), id(1)));
        assertTrue(storage.values.keySet().stream().noneMatch(key -> !key.equals("index")));
    }

    @Test public void durableRemovalReportsAStorageFailure() throws Exception {
        Storage storage = new Storage(); RemoteConversationCache cache = cache(storage);
        cache.put(owner("a"), snapshot(id(1), "retained")); cache.flush().get(5, TimeUnit.SECONDS);
        storage.failDeletes = true;
        assertFalse(cache.removeDurably(owner("a"), null));
        RemoteConversationCache reopened = cache(storage);
        assertEquals("A failed deletion must leave the on-disk page intact",
            "retained", text(reopened.get(owner("a"), id(1))));
        storage.failDeletes = false;
        assertTrue(cache.removeDurably(owner("a"), null));
        assertNull(cache(storage).get(owner("a"), id(1)));
        assertTrue(storage.values.keySet().stream().noneMatch(key -> !key.equals("index")));
    }

    @Test public void invalidEntriesAreIgnoredWithoutPreventingANewSnapshot() throws Exception {
        Storage storage = new Storage(); RemoteConversationCache cache = cache(storage);
        cache.put(owner("a"), snapshot(id(1), "valid")); cache.flush().get(5, TimeUnit.SECONDS);
        String entryKey = storage.values.keySet().stream().filter(key -> !key.equals("index")).findFirst().orElseThrow();
        storage.values.put(entryKey, new JSONObject().put("format", 99));
        assertNull(cache.get(owner("a"), id(1)));
        cache.put(owner("a"), snapshot(id(1), "replacement")); cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals("replacement", text(cache.get(owner("a"), id(1))));
    }

    private RemoteConversationCache cache(Storage storage) {
        RemoteConversationCache cache = new RemoteConversationCache(storage, storage.errors::add, 60_000);
        caches.add(cache); return cache;
    }
    private static JSONObject owner(String token) throws Exception {
        return new JSONObject().put("address", "http://100.64.0.1:43128").put("token", token.repeat(43));
    }
    private static String id(int value) { return String.format("00000000-0000-0000-0000-%012d", value); }
    private static JSONObject snapshot(String id, String text) throws Exception {
        return new JSONObject().put("instanceId", "server").put("cursor", 7).put("historyVersion", "a".repeat(64))
            .put("permission", "control").put("live", new JSONObject().put("text", "do not restore live state"))
            .put("conversation", new JSONObject().put("id", id).put("title", "Cached conversation").put("seq", 1))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 1).put("role", "assistant").put("text", text)))
            .put("nextBefore", JSONObject.NULL);
    }
    private static String text(JSONObject snapshot) { return snapshot.optJSONArray("messages").optJSONObject(0).optString("text"); }
    private static ScheduledThreadPoolExecutor executor(RemoteConversationCache cache) throws Exception {
        var field = RemoteConversationCache.class.getDeclaredField("writer"); field.setAccessible(true);
        return (ScheduledThreadPoolExecutor) field.get(cache);
    }

    private static final class Storage implements RemoteConversationCache.Storage {
        final Map<String, JSONObject> values = new HashMap<>();
        final List<Exception> errors = new ArrayList<>();
        final AtomicInteger entrySaves = new AtomicInteger();
        volatile boolean failNextEntry;
        volatile boolean failDeletes;
        @Override public JSONObject load(String key) throws Exception {
            JSONObject value = values.get(key); return value == null ? new JSONObject() : new JSONObject(value.toString());
        }
        @Override public void save(String key, JSONObject value) throws Exception {
            if (!key.equals("index")) {
                entrySaves.incrementAndGet();
                if (failNextEntry) { failNextEntry = false; throw new IOException("Simulated conversation cache failure"); }
            }
            values.put(key, new JSONObject(value.toString()));
        }
        @Override public void delete(String key) throws Exception {
            if (failDeletes) throw new IOException("Simulated cache deletion failure");
            values.remove(key);
        }
    }
}
