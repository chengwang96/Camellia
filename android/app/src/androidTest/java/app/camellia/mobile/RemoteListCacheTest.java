package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import android.test.InstrumentationTestCase;
import android.util.Log;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

public final class RemoteListCacheTest extends InstrumentationTestCase {
    private Context context;
    private CredentialStore encrypted;
    private final List<RemoteListCache> caches = new ArrayList<>();
    @Override protected void setUp() throws Exception {
        super.setUp(); context = getInstrumentation().getTargetContext();
        encrypted = new CredentialStore(context, "list-cache-coalescing-test"); encrypted.clear();
    }
    @Override protected void tearDown() throws Exception {
        for (RemoteListCache cache : caches) {
            try { cache.close().get(15, TimeUnit.SECONDS); } catch (ExecutionException expected) { }
            assertTrue(executor(cache).awaitTermination(15, TimeUnit.SECONDS));
        }
        encrypted.clear(); super.tearDown();
    }

    public void testEncryptedOldFormatRoundTripAndRemoval() throws Exception {
        String key = "computer/token";
        encrypted.save(new JSONObject().put(key, entry(rows(1, 0, 0))));
        AtomicInteger saves = new AtomicInteger(); List<Exception> errors = new CopyOnWriteArrayList<>();
        RemoteListCache cache = new RemoteListCache(new RemoteListCache.Storage() {
            @Override public JSONObject load() throws Exception { return encrypted.load(); }
            @Override public void save(JSONObject value) throws Exception {
                assertNotSame(Looper.getMainLooper(), Looper.myLooper()); saves.incrementAndGet(); encrypted.save(value);
            }
        }, errors::add, 60_000); caches.add(cache);
        assertEquals(0, readVersion(cache.get(credentials("computer"))));
        for (int version = 1; version <= 200; version++) cache.put(credentials("computer"), rows(1, 0, version), -1, new JSONArray(), false);
        cache.flush().get(15, TimeUnit.SECONDS); assertEquals(1, saves.get());
        assertEquals(200, readVersion(encrypted.load().getJSONObject(key))); assertNull(cache.get(new JSONObject().put("address", "computer").put("token", "other")));
        cache.remove(credentials("computer")); cache.flush().get(15, TimeUnit.SECONDS);
        assertFalse(encrypted.load().has(key)); assertEquals(2, saves.get()); assertTrue(errors.toString(), errors.isEmpty());
    }

    public void testNativeJsonSnapshotsDetachNestedRowsAndWorkspaces() throws Exception {
        Storage storage = new Storage(new JSONObject()); RemoteListCache cache = cache(storage);
        JSONObject row = new JSONObject().put("id", "chat").put("version", 1).put("title", "中文 😀 / path").put("nested", new JSONObject().put("state", "ready"));
        JSONArray list = new JSONArray().put(row), workspaces = new JSONArray().put(new JSONObject().put("name", "Original"));
        cache.put(credentials("computer"), list, 25, workspaces, true);
        row.put("version", 2); row.getJSONObject("nested").put("state", "changed"); workspaces.getJSONObject(0).put("name", "Changed");
        JSONObject returned = cache.get(credentials("computer")); returned.getJSONArray("conversations").getJSONObject(0).put("version", 3);
        cache.flush().get(15, TimeUnit.SECONDS); JSONObject saved = storage.saved.getJSONObject("computer/token");
        assertEquals(1, readVersion(saved)); assertEquals("中文 😀 / path", saved.getJSONArray("conversations").getJSONObject(0).getString("title"));
        assertEquals("ready", saved.getJSONArray("conversations").getJSONObject(0).getJSONObject("nested").getString("state"));
        assertEquals("Original", saved.getJSONArray("workspaces").getJSONObject(0).getString("name")); assertEquals(25, saved.getInt("nextOffset")); assertTrue(saved.getBoolean("includeUnassigned"));
    }

    public void testSlowWriteKeepsLatestUpdateAndDeletionWithNoQueue() throws Exception {
        Storage storage = new Storage(new JSONObject()); storage.block = true; RemoteListCache cache = cache(storage);
        cache.put(credentials("old"), rows(1, 0, 0), -1, new JSONArray(), false); cache.flush(); assertTrue(storage.entered.await(15, TimeUnit.SECONDS));
        for (int version = 1; version <= 1000; version++) cache.put(credentials("new"), rows(1, 0, version), -1, new JSONArray(), false);
        cache.remove(credentials("old")); assertEquals(0, executor(cache).getQueue().size()); assertEquals(1, storage.calls.get());
        CompletableFuture<Void> latest = cache.flush(); assertSame(latest, cache.flush()); storage.release.countDown(); latest.get(15, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertFalse(storage.saved.has("old/token")); assertEquals(1000, readVersion(storage.saved.getJSONObject("new/token")));
    }

    public void testFailureKeepsLatestCacheAndRetriesOnlyOnRequest() throws Exception {
        Storage storage = new Storage(new JSONObject()); storage.failures.set(1); RemoteListCache cache = cache(storage);
        cache.put(credentials("computer"), rows(1, 0, 1), -1, new JSONArray(), false);
        try { cache.flush().get(15, TimeUnit.SECONDS); fail(); } catch (ExecutionException expected) { assertTrue(expected.getCause() instanceof IOException); }
        assertEquals(1, storage.calls.get()); assertEquals(0, executor(cache).getQueue().size()); assertEquals(1, readVersion(cache.get(credentials("computer"))));
        cache.put(credentials("computer"), rows(1, 0, 2), -1, new JSONArray(), false); cache.flush().get(15, TimeUnit.SECONDS);
        assertEquals(2, storage.calls.get()); assertEquals(2, readVersion(storage.saved.getJSONObject("computer/token")));
    }

    public void testActivityRecreationReusesThePendingCacheWithoutBlockingMain() throws Exception {
        EmbeddedNetwork.initialize(context); boolean embedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        RemoteListCache original = RemoteListCache.get(context);
        Storage storage = new Storage(new JSONObject()); storage.block = true; RemoteListCache cache = cache(storage);
        Field shared = RemoteListCache.class.getDeclaredField("shared"); shared.setAccessible(true); shared.set(null, cache);
        MainActivity first = null, second = null;
        try {
            cache.put(credentials("computer"), rows(1, 0, 1), -1, new JSONArray(), false); cache.flush(); assertTrue(storage.entered.await(15, TimeUnit.SECONDS));
            first = launch(); assertSame(cache, field(first, "listCache"));
            cache.put(credentials("computer"), rows(1, 0, 2), -1, new JSONArray(), false);
            MainActivity retiring = first; getInstrumentation().runOnMainSync(retiring::finish); getInstrumentation().waitForIdleSync();
            assertFalse(executor(cache).isShutdown()); assertEquals(1, storage.calls.get());
            second = launch(); assertSame(cache, field(second, "listCache")); assertEquals(2, readVersion(cache.get(credentials("computer"))));
            storage.release.countDown(); cache.flush().get(15, TimeUnit.SECONDS); assertEquals(2, storage.calls.get());
        } finally {
            storage.release.countDown();
            for (Activity activity : new Activity[]{first, second}) if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync(); shared.set(null, original); EmbeddedNetwork.setEnabled(embedded);
        }
    }

    public void testCoalescingReducesQueuedSnapshotsAndAllocations() throws Exception {
        JSONObject seed = new JSONObject(); for (int computer = 0; computer < 20; computer++) seed.put("computer-" + computer + "/token", entry(rows(16, 256, 0)));
        Storage modernStorage = new Storage(seed); modernStorage.block = true; RemoteListCache modern = cache(modernStorage);
        modern.put(credentials("computer-0"), rows(16, 256, -1), -1, new JSONArray(), false); modern.flush(); assertTrue(modernStorage.entered.await(15, TimeUnit.SECONDS));
        Memory coalesced = new Memory();
        try (coalesced) { getInstrumentation().runOnMainSync(() -> { try {
            for (int version = 1; version <= 200; version++) modern.put(credentials("computer-0"), rows(16, 256, version), -1, new JSONArray(), false);
        } catch (Exception error) { throw new AssertionError(error); } }); }
        int modernQueued = executor(modern).getQueue().size(); assertEquals(0, modernQueued);
        CompletableFuture<Void> latest = modern.flush(); modernStorage.release.countDown(); latest.get(15, TimeUnit.SECONDS); assertEquals(2, modernStorage.calls.get());
        assertEquals(200, readVersion(modernStorage.saved.getJSONObject("computer-0/token")));

        Storage oldStorage = new Storage(seed); oldStorage.block = true; LegacyCache old = new LegacyCache(oldStorage);
        Memory eager;
        int oldQueued;
        try {
            old.put(credentials("computer-0"), rows(16, 256, -1)); assertTrue(oldStorage.entered.await(15, TimeUnit.SECONDS));
            eager = new Memory();
            try (eager) { getInstrumentation().runOnMainSync(() -> { try {
                for (int version = 1; version <= 200; version++) old.put(credentials("computer-0"), rows(16, 256, version));
            } catch (Exception error) { throw new AssertionError(error); } }); }
            oldQueued = old.writer.getQueue().size(); assertEquals(200, oldQueued);
            oldStorage.release.countDown(); old.writer.submit(() -> {}).get(30, TimeUnit.SECONDS);
            assertEquals(201, oldStorage.calls.get()); assertEquals(200, readVersion(oldStorage.saved.getJSONObject("computer-0/token")));
        } finally { oldStorage.release.countDown(); old.writer.shutdown(); assertTrue(old.writer.awaitTermination(30, TimeUnit.SECONDS)); }
        assertTrue("Coalesced " + coalesced.allocated + "; eager " + eager.allocated, eager.allocated > coalesced.allocated * 3);
        JSONObject metrics = new JSONObject().put("updates", 200).put("cachedComputers", 20).put("rowsPerComputer", 16).put("previewCharacters", 256)
            .put("coalescedQueuedWrites", modernQueued).put("eagerQueuedWrites", oldQueued).put("coalescedSaves", modernStorage.calls.get()).put("eagerSaves", oldStorage.calls.get())
            .put("coalescedJavaAllocatedBytes", coalesced.allocated).put("eagerJavaAllocatedBytes", eager.allocated)
            .put("coalescedJavaHeapPeakDelta", coalesced.heapDelta()).put("eagerJavaHeapPeakDelta", eager.heapDelta())
            .put("coalescedSubmissionMillis", coalesced.elapsed).put("eagerSubmissionMillis", eager.elapsed);
        Log.i("CamelliaCacheTest", "CAMELLIA_ANDROID_LIST_CACHE_MEMORY " + metrics);
    }

    private MainActivity launch() throws Exception {
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().runOnMainSync(() -> { try { var stop = MainActivity.class.getDeclaredMethod("stopNetwork"); stop.setAccessible(true); stop.invoke(activity); } catch (Exception error) { throw new AssertionError(error); } });
        return activity;
    }
    private RemoteListCache cache(Storage storage) { RemoteListCache cache = new RemoteListCache(storage, storage.errors::add, 60_000); caches.add(cache); return cache; }
    private static JSONObject credentials(String computer) throws Exception { return new JSONObject().put("address", computer).put("token", "token"); }
    private static JSONArray rows(int count, int preview, int version) throws Exception {
        char[] text = new char[preview]; Arrays.fill(text, 'x'); String value = new String(text); JSONArray rows = new JSONArray();
        for (int row = 0; row < count; row++) rows.put(new JSONObject().put("id", "chat-" + row).put("title", "Conversation " + row).put("version", version).put("preview", value));
        return rows;
    }
    private static JSONObject entry(JSONArray rows) throws Exception { return new JSONObject().put("conversations", rows).put("nextOffset", -1).put("workspaces", new JSONArray()).put("includeUnassigned", false); }
    private static int readVersion(JSONObject entry) throws Exception { return entry.getJSONArray("conversations").getJSONObject(0).getInt("version"); }
    private static Object field(Object value, String name) throws Exception { Field field = value.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(value); }
    private static ScheduledThreadPoolExecutor executor(RemoteListCache cache) throws Exception { return (ScheduledThreadPoolExecutor) field(cache, "writer"); }

    private static final class Storage implements RemoteListCache.Storage {
        final AtomicInteger calls = new AtomicInteger(), failures = new AtomicInteger();
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        final List<Exception> errors = new CopyOnWriteArrayList<>();
        volatile JSONObject saved; boolean block;
        Storage(JSONObject loaded) throws Exception { saved = new JSONObject(loaded.toString()); }
        @Override public JSONObject load() throws Exception { return new JSONObject(saved.toString()); }
        @Override public void save(JSONObject value) throws Exception {
            assertNotSame(Looper.getMainLooper(), Looper.myLooper()); int call = calls.incrementAndGet(); entered.countDown();
            if (block && call == 1 && !release.await(60, TimeUnit.SECONDS)) throw new IOException("Test write remained blocked");
            if (failures.getAndUpdate(count -> Math.max(0, count - 1)) > 0) throw new IOException("Simulated cache save failure");
            saved = new JSONObject(value.toString());
        }
    }

    /** Previous eager cache writer, used only as a bounded benchmark baseline. */
    private static final class LegacyCache {
        final JSONObject entries; final Storage storage;
        final ThreadPoolExecutor writer = (ThreadPoolExecutor) Executors.newFixedThreadPool(1);
        LegacyCache(Storage storage) throws Exception { this.storage = storage; entries = storage.load(); }
        void put(JSONObject credentials, JSONArray rows) throws Exception {
            entries.put(credentials.optString("address") + "/" + credentials.optString("token"), entry(rows));
            String snapshot = entries.toString();
            writer.submit(() -> { try { storage.save(new JSONObject(snapshot)); } catch (Exception error) { throw new RuntimeException(error); } });
        }
    }

    private static final class Memory implements AutoCloseable {
        final long baseline, allocationBaseline, started;
        final AtomicLong heap = new AtomicLong(); final ScheduledExecutorService sampler = Executors.newSingleThreadScheduledExecutor();
        long allocated, elapsed;
        Memory() throws InterruptedException {
            System.gc(); System.runFinalization(); Thread.sleep(100);
            baseline = used(); heap.set(baseline); allocationBaseline = Long.parseLong(android.os.Debug.getRuntimeStat("art.gc.bytes-allocated")); started = android.os.SystemClock.elapsedRealtime();
            sampler.scheduleAtFixedRate(this::sample, 0, 10, TimeUnit.MILLISECONDS);
        }
        static long used() { Runtime runtime = Runtime.getRuntime(); long total = runtime.totalMemory(), free = runtime.freeMemory(); return total == runtime.totalMemory() ? total - free : 0; }
        void sample() { heap.accumulateAndGet(used(), Math::max); }
        long heapDelta() { return Math.max(0, heap.get() - baseline); }
        @Override public void close() { sample(); sampler.shutdownNow(); allocated = Long.parseLong(android.os.Debug.getRuntimeStat("art.gc.bytes-allocated")) - allocationBaseline; elapsed = android.os.SystemClock.elapsedRealtime() - started; }
    }
}
