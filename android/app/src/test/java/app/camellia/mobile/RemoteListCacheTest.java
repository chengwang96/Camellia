package app.camellia.mobile;

import static org.junit.Assert.*;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

public class RemoteListCacheTest {
    private final List<RemoteListCache> caches = new ArrayList<>();
    @After public void cleanup() throws Exception {
        for (RemoteListCache cache : caches) {
            try { cache.close().get(5, TimeUnit.SECONDS); } catch (ExecutionException expected) { }
            assertTrue(executor(cache).awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    @Test public void burstWritesOnlyTheLatestEntry() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage);
        for (int index = 0; index < 1000; index++) put(cache, "computer", "token", index);
        assertEquals(1, executor(cache).getQueue().size()); assertEquals(0, storage.calls.get());
        cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals(1, storage.calls.get()); assertEquals(999, row(storage.saved, "computer/token").getInt("version"));
        assertEquals("camellia-list-cache", storage.thread);
    }

    @Test public void slowSaveKeepsOneLatestStateWithoutAQueue() throws Exception {
        Storage storage = new Storage(); storage.block = true; RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 0); CompletableFuture<Void> first = cache.flush();
        assertTrue(storage.entered.await(5, TimeUnit.SECONDS));
        for (int index = 1; index <= 1000; index++) put(cache, "computer", "token", index);
        assertEquals(1, storage.calls.get()); assertEquals(0, executor(cache).getQueue().size());
        CompletableFuture<Void> latest = cache.flush(); assertNotSame(first, latest);
        storage.release.countDown(); first.get(5, TimeUnit.SECONDS); latest.get(5, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertEquals(1000, row(storage.saved, "computer/token").getInt("version"));
        assertEquals(0, row(storage.writes.get(0), "computer/token").getInt("version"));
    }

    @Test public void removalDuringSaveIsNotRestoredByTheOldSnapshot() throws Exception {
        Storage storage = new Storage(); storage.block = true; RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 0); cache.flush(); assertTrue(storage.entered.await(5, TimeUnit.SECONDS));
        cache.remove(credentials("computer", "token")); assertNull(cache.get(credentials("computer", "token")));
        CompletableFuture<Void> latest = cache.flush(); storage.release.countDown(); latest.get(5, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertFalse(storage.saved.has("computer/token"));
    }

    @Test public void multipleComputersMergeIntoTheSameLatestSnapshot() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage);
        put(cache, "one", "a", 1); put(cache, "two", "b", 2); put(cache, "one", "a", 3);
        cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals(1, storage.calls.get()); assertEquals(2, storage.saved.length());
        assertEquals(3, row(storage.saved, "one/a").getInt("version")); assertEquals(2, row(storage.saved, "two/b").getInt("version"));
    }

    @Test public void inputAndReturnedJsonCannotMutateFrozenEntries() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage);
        JSONObject row = new JSONObject().put("id", "chat").put("version", 1).put("nested", new JSONObject().put("status", "ready"));
        JSONArray rows = new JSONArray().put(row), workspaces = new JSONArray().put(new JSONObject().put("name", "Workspace"));
        cache.put(credentials("computer", "token"), rows, -1, workspaces, true);
        row.put("version", 2); row.getJSONObject("nested").put("status", "mutated"); workspaces.getJSONObject(0).put("name", "Changed"); rows.put(new JSONObject());
        JSONObject read = cache.get(credentials("computer", "token")); read.getJSONArray("conversations").getJSONObject(0).put("version", 3);
        cache.flush().get(5, TimeUnit.SECONDS);
        JSONObject saved = storage.saved.getJSONObject("computer/token");
        assertEquals(1, saved.getJSONArray("conversations").length()); assertEquals(1, row(storage.saved, "computer/token").getInt("version"));
        assertEquals("ready", row(storage.saved, "computer/token").getJSONObject("nested").getString("status"));
        assertEquals("Workspace", saved.getJSONArray("workspaces").getJSONObject(0).getString("name"));
    }

    @Test public void identicalUpdatesAndMissingRemovalsDoNotWrite() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1); cache.flush().get(5, TimeUnit.SECONDS);
        for (int index = 0; index < 100; index++) put(cache, "computer", "token", 1);
        cache.remove(credentials("missing", "token")); cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals(1, storage.calls.get()); assertEquals(0, executor(cache).getQueue().size());
    }

    @Test public void fixedWindowWritesWhileUpdatesContinue() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage, 60);
        CountDownLatch updating = new CountDownLatch(1), stop = new CountDownLatch(1);
        Thread producer = new Thread(() -> {
            try { for (int index = 0; stop.getCount() != 0; index++) { put(cache, "computer", "token", index); updating.countDown(); Thread.sleep(5); } }
            catch (Exception error) { throw new AssertionError(error); }
        });
        producer.start();
        try { assertTrue(updating.await(5, TimeUnit.SECONDS)); assertTrue(storage.entered.await(5, TimeUnit.SECONDS)); assertTrue(producer.isAlive()); }
        finally { stop.countDown(); producer.join(5000); }
        cache.flush().get(5, TimeUnit.SECONDS); assertTrue(storage.calls.get() >= 1);
    }

    @Test public void failureDoesNotLoopAndFlushRetriesLatestState() throws Exception {
        Storage storage = new Storage(); storage.failures.set(1); RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1); expectFailure(cache.flush());
        assertEquals(1, storage.calls.get()); assertEquals(0, executor(cache).getQueue().size()); awaitErrors(storage, 1);
        assertEquals(1, cache.get(credentials("computer", "token")).getJSONArray("conversations").getJSONObject(0).getInt("version"));
        put(cache, "computer", "token", 2); cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertEquals(2, row(storage.saved, "computer/token").getInt("version"));
    }

    @Test public void unchangedRefreshCanRetryAnUnsavedEntry() throws Exception {
        Storage storage = new Storage(); storage.failures.set(1); RemoteListCache cache = cache(storage, 10);
        put(cache, "computer", "token", 1); expectFailure(cache.flush());
        put(cache, "computer", "token", 1); awaitCalls(storage, 2); cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertEquals(1, row(storage.saved, "computer/token").getInt("version"));
    }

    @Test public void newUpdateDuringFailedSaveStillGetsOneAttempt() throws Exception {
        Storage storage = new Storage(); storage.block = true; storage.failures.set(1); RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1); CompletableFuture<Void> old = cache.flush(); assertTrue(storage.entered.await(5, TimeUnit.SECONDS));
        put(cache, "computer", "token", 2); CompletableFuture<Void> latest = cache.flush(); storage.release.countDown();
        expectFailure(old); latest.get(5, TimeUnit.SECONDS); assertEquals(2, storage.calls.get()); assertEquals(2, row(storage.saved, "computer/token").getInt("version"));
    }

    @Test public void sameVersionFlushesShareTheActiveWrite() throws Exception {
        Storage storage = new Storage(); storage.block = true; RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1); CompletableFuture<Void> first = cache.flush(); assertTrue(storage.entered.await(5, TimeUnit.SECONDS));
        for (int index = 0; index < 1000; index++) assertSame(first, cache.flush());
        assertEquals(0, executor(cache).getQueue().size()); storage.release.countDown(); first.get(5, TimeUnit.SECONDS);
        assertEquals(1, storage.calls.get());
    }

    @Test public void changedVersionFlushesShareOnePendingWrite() throws Exception {
        Storage storage = new Storage(); storage.block = true; RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1); cache.flush(); assertTrue(storage.entered.await(5, TimeUnit.SECONDS));
        put(cache, "computer", "token", 2); CompletableFuture<Void> pending = cache.flush();
        for (int index = 3; index < 1000; index++) { put(cache, "computer", "token", index); assertSame(pending, cache.flush()); }
        storage.release.countDown(); pending.get(5, TimeUnit.SECONDS); assertEquals(2, storage.calls.get());
        assertEquals(999, row(storage.saved, "computer/token").getInt("version"));
    }

    @Test public void cancelledStartedTimerCannotConsumeTheNewFlush() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage, 0);
        Object gate = field(cache, "gate");
        CompletableFuture<Void> result;
        synchronized (gate) {
            put(cache, "computer", "token", 1);
            long timeout = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            boolean waiting = false;
            while (!waiting && System.nanoTime() < timeout) {
                for (var thread : Thread.getAllStackTraces().entrySet()) if (thread.getKey().getState() == Thread.State.BLOCKED)
                    for (StackTraceElement frame : thread.getValue()) if (frame.getClassName().equals(RemoteListCache.class.getName()) && frame.getMethodName().equals("persist")) waiting = true;
                if (!waiting) Thread.yield();
            }
            assertTrue("Timer has entered persist and is waiting for the cache gate", waiting);
            result = cache.flush(); put(cache, "computer", "token", 2);
            assertEquals(1, executor(cache).getQueue().size());
        }
        result.get(5, TimeUnit.SECONDS); assertEquals(1, storage.calls.get()); assertEquals(2, row(storage.saved, "computer/token").getInt("version"));
    }

    @Test public void closeFlushesWithoutWaitingOnSlowDisk() throws Exception {
        Storage storage = new Storage(); storage.block = true; RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1); CompletableFuture<Void> closing = cache.close();
        assertTrue(storage.entered.await(5, TimeUnit.SECONDS)); assertFalse(closing.isDone()); assertSame(closing, cache.close());
        storage.release.countDown(); closing.get(5, TimeUnit.SECONDS);
        assertTrue(executor(cache).awaitTermination(5, TimeUnit.SECONDS)); assertEquals(1, storage.calls.get());
    }

    @Test public void closeDuringSaveFlushesLatestDeletionAndUpdate() throws Exception {
        Storage storage = new Storage(); storage.block = true; RemoteListCache cache = cache(storage);
        put(cache, "one", "a", 1); cache.flush(); assertTrue(storage.entered.await(5, TimeUnit.SECONDS));
        cache.remove(credentials("one", "a")); put(cache, "two", "b", 2); CompletableFuture<Void> closing = cache.close();
        put(cache, "three", "c", 3); assertNull(cache.get(credentials("three", "c")));
        storage.release.countDown(); closing.get(5, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertFalse(storage.saved.has("one/a")); assertTrue(storage.saved.has("two/b")); assertFalse(storage.saved.has("three/c"));
    }

    @Test public void failedFinalCloseStopsInsteadOfRetryingForever() throws Exception {
        Storage storage = new Storage(); storage.failures.set(100); RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1); expectFailure(cache.close());
        assertTrue(executor(cache).awaitTermination(5, TimeUnit.SECONDS)); assertEquals(1, storage.calls.get());
    }

    @Test public void completionCallbacksCanSubmitAnotherFlush() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage);
        put(cache, "computer", "token", 1);
        cache.flush().thenCompose(ignored -> {
            try { put(cache, "computer", "token", 2); return cache.flush(); }
            catch (Exception error) { throw new CompletionException(error); }
        }).get(5, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertEquals(2, row(storage.saved, "computer/token").getInt("version"));
    }

    @Test public void oldFormatLoadsAndKeepsTokenIsolation() throws Exception {
        Storage storage = new Storage();
        storage.saved = new JSONObject().put("computer/token", new JSONObject().put("conversations", new JSONArray().put(new JSONObject().put("id", "old")))
            .put("nextOffset", 25).put("workspaces", new JSONArray().put("workspace")).put("includeUnassigned", true));
        RemoteListCache cache = cache(storage); JSONObject loaded = cache.get(credentials("computer", "token"));
        assertEquals("old", loaded.getJSONArray("conversations").getJSONObject(0).getString("id")); assertEquals(25, loaded.getInt("nextOffset"));
        assertTrue(loaded.getBoolean("includeUnassigned")); assertNull(cache.get(credentials("computer", "another-token")));
        cache.flush().get(5, TimeUnit.SECONDS); assertEquals(0, storage.calls.get());
    }

    @Test public void perComputerAndTotalBoundsKeepTheUpdatedComputer() throws Exception {
        Storage storage = new Storage(); RemoteListCache cache = cache(storage);
        JSONArray rows = new JSONArray(); for (int index = 0; index < 1001; index++) rows.put(new JSONObject().put("id", "row-" + index));
        cache.put(credentials("first", "token"), rows, -1, new JSONArray(), false);
        assertEquals(1000, cache.get(credentials("first", "token")).getJSONArray("conversations").length()); assertEquals(1000, cache.get(credentials("first", "token")).getInt("nextOffset"));
        for (int index = 0; index < 19; index++) put(cache, "computer-" + index, "token", index);
        put(cache, "last", "token", 99); cache.flush().get(5, TimeUnit.SECONDS);
        assertEquals(20, storage.saved.length()); assertFalse(storage.saved.has("first/token")); assertTrue(storage.saved.has("last/token"));
    }

    @Test public void loadFailureIsReportedAndCacheCanBeRebuilt() throws Exception {
        Storage storage = new Storage(); storage.loadFailure = true; RemoteListCache cache = cache(storage);
        assertEquals(1, storage.errors.size()); assertNull(cache.get(credentials("computer", "token")));
        put(cache, "computer", "token", 1); cache.flush().get(5, TimeUnit.SECONDS); assertEquals(1, storage.calls.get());
    }

    private RemoteListCache cache(Storage storage) { return cache(storage, 60_000); }
    private RemoteListCache cache(Storage storage, long delay) { RemoteListCache cache = new RemoteListCache(storage, storage.errors::add, delay); caches.add(cache); return cache; }
    private static void put(RemoteListCache cache, String computer, String token, int version) throws Exception {
        cache.put(credentials(computer, token), new JSONArray().put(new JSONObject().put("id", "chat").put("version", version)), -1, new JSONArray(), false);
    }
    private static JSONObject credentials(String computer, String token) throws Exception { return new JSONObject().put("address", computer).put("token", token); }
    private static JSONObject row(JSONObject snapshot, String key) throws Exception { return snapshot.getJSONObject(key).getJSONArray("conversations").getJSONObject(0); }
    private static Object field(Object object, String name) throws Exception { Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object); }
    private static ScheduledThreadPoolExecutor executor(RemoteListCache cache) throws Exception { return (ScheduledThreadPoolExecutor) field(cache, "writer"); }
    private static void expectFailure(CompletableFuture<Void> result) throws Exception {
        try { result.get(5, TimeUnit.SECONDS); fail("Expected cache save failure"); }
        catch (ExecutionException expected) { assertTrue(expected.getCause() instanceof IOException); }
    }
    private static void awaitCalls(Storage storage, int count) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (storage.calls.get() < count && System.nanoTime() < deadline) Thread.sleep(2);
        assertEquals(count, storage.calls.get());
    }
    private static void awaitErrors(Storage storage, int count) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (storage.errors.size() < count && System.nanoTime() < deadline) Thread.sleep(2);
        assertEquals(count, storage.errors.size());
    }

    private static final class Storage implements RemoteListCache.Storage {
        final AtomicInteger calls = new AtomicInteger(), failures = new AtomicInteger();
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        final List<JSONObject> writes = Collections.synchronizedList(new ArrayList<>());
        final List<Exception> errors = Collections.synchronizedList(new ArrayList<>());
        volatile JSONObject saved = new JSONObject(); volatile String thread;
        boolean block, loadFailure;
        @Override public JSONObject load() throws Exception { if (loadFailure) throw new IOException("cache load failed"); return new JSONObject(saved.toString()); }
        @Override public void save(JSONObject value) throws Exception {
            int call = calls.incrementAndGet(); thread = Thread.currentThread().getName(); entered.countDown();
            if (block && call == 1 && !release.await(5, TimeUnit.SECONDS)) throw new IOException("Blocked cache save timed out");
            if (failures.getAndUpdate(remaining -> Math.max(0, remaining - 1)) > 0) throw new IOException("cache save failed");
            saved = new JSONObject(value.toString()); writes.add(saved);
        }
    }
}
