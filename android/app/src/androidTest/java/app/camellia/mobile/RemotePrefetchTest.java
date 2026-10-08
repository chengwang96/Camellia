package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemotePrefetchTest extends InstrumentationTestCase {
    private final List<RemotePrefetch> caches = new ArrayList<>();
    private final List<Fake> fakes = new ArrayList<>();
    @Override protected void tearDown() throws Exception {
        for (Fake fake : fakes) fake.release.countDown();
        for (RemotePrefetch cache : caches) { cache.close(); assertTrue(executor(cache).awaitTermination(5, TimeUnit.SECONDS)); }
        super.tearDown();
    }
    public void testThousandsOfRowsAreCappedAndNeverLoadListPages() throws Exception {
        Fake fake = fake(); RemotePrefetch cache = cache(fake, 0);
        cache.schedule(identity("one"), rows(1, 5000), rows(10_001, 5000)); idle(cache);
        assertEquals(Arrays.asList(1, 2, 3, 4, 10_001, 10_002), fake.order);
        assertEquals(6, map(cache, "desired").size()); assertEquals(1, fake.peak.get()); assertEquals(1024 * 1024, fake.limit);
    }
    public void testNearbyWaitsForIdleAndActivityRefreshesItsDeadline() throws Exception {
        Fake fake = fake(); RemotePrefetch cache = cache(fake, 250);
        cache.schedule(identity("one"), rows(1, 4), rows(5, 2)); await(() -> fake.calls.get() == 4);
        for (int repeat = 0; repeat < 3; repeat++) { cache.interaction(); Thread.sleep(80); assertEquals(4, fake.calls.get()); }
        idle(cache); assertEquals(6, fake.calls.get());
    }
    public void testViewportReplacementRejectsTheLateOldResponse() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        cache.schedule(identity("one"), rows(1, 4), rows(5, 2)); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        cache.schedule(identity("one"), rows(101, 4), rows(105, 2));
        assertEquals(6, map(cache, "pending").size()); assertEquals(0, executor(cache).getQueue().size());
        fake.release.countDown(); idle(cache); assertNull(cache.get(identity("one"), id(1)));
        assertEquals(Arrays.asList(1, 101, 102, 103, 104, 105, 106), fake.order); assertEquals(1, fake.peak.get());
    }
    public void testRepeatedViewportKeepsItsSingleActiveRequest() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        cache.schedule(identity("one"), rows(1, 4), rows(5, 2)); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        for (int repeat = 0; repeat < 100; repeat++) cache.schedule(identity("one"), rows(1, 4), rows(5, 2));
        fake.release.countDown(); idle(cache); assertEquals(6, fake.calls.get());
        cache.schedule(identity("one"), rows(1, 4), rows(5, 2)); idle(cache); assertEquals(6, fake.calls.get());
    }
    public void testSwitchingComputerAndCancellationKeepOwnerIsolation() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        cache.schedule(identity("one"), rows(1, 4), rows(5, 2)); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        cache.cancel(); cache.schedule(identity("two"), rows(101, 1), new JSONArray()); fake.release.countDown(); idle(cache);
        assertNull(cache.get(identity("one"), id(1))); assertNotNull(cache.get(identity("two"), id(101))); assertNull(cache.get(identity("one"), id(101)));
        assertEquals(2, fake.calls.get());
    }
    public void testMemoryCacheIsDetachedLimitedAndContainsNoControlState() throws Exception {
        RemotePrefetch cache = cache(fake(), 0); JSONObject owner = identity("one"), input = snapshot(1, "中文 😀");
        cache.put(owner, input); input.getJSONArray("messages").getJSONObject(0).put("text", "changed");
        JSONObject returned = cache.get(owner, id(1)); assertFalse(returned.has("live")); assertFalse(returned.has("permission")); assertFalse(returned.has("settings"));
        returned.getJSONArray("messages").getJSONObject(0).put("text", "other");
        assertEquals("中文 😀", cache.get(owner, id(1)).getJSONArray("messages").getJSONObject(0).getString("text"));
        for (int number = 2; number <= 9; number++) cache.put(owner, snapshot(number, "reply"));
        assertNull(cache.get(owner, id(1))); assertEquals(8, map(cache, "entries").size());
        cache.put(owner, snapshot(9, "x".repeat(600_000))); assertNull(cache.get(owner, id(9)));
    }
    public void testNativeUtf16StringAccountingEnforcesTheHeapBudget() throws Exception {
        RemotePrefetch cache = new RemotePrefetch(fake()::client, 0, android.os.SystemClock::elapsedRealtime, 64L * 1024 * 1024); caches.add(cache);
        for (int number = 1; number <= 5; number++) cache.put(identity("one"), snapshot(number, "中".repeat(300_000)));
        assertEquals(3, map(cache, "entries").size()); assertNull(cache.get(identity("one"), id(1))); assertNotNull(cache.get(identity("one"), id(5)));
        assertTrue((long) field(cache, "size") <= 2 * 1024 * 1024);
    }
    public void testRevocationClearsCachedContentAndStopsPendingRequests() throws Exception {
        Fake fake = fake(); fake.revoked = true; RemotePrefetch cache = cache(fake, 0);
        cache.put(identity("one"), snapshot(90, "old")); cache.schedule(identity("one"), rows(1, 4), rows(5, 2)); idle(cache);
        assertNull(cache.get(identity("one"), id(90))); assertTrue(map(cache, "desired").isEmpty()); assertEquals(1, fake.calls.get());
    }
    static String id(int number) { return String.format(Locale.ROOT, "00000000-0000-0000-0000-%012d", number); }
    static JSONObject identity(String name) throws Exception { return new JSONObject().put("address", name).put("token", "token"); }
    static JSONObject snapshot(int number, String text) throws Exception {
        return new JSONObject().put("conversation", new JSONObject().put("id", id(number)).put("seq", 2).put("updatedAt", number))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", text)))
            .put("permission", "control").put("live", new JSONObject()).put("settings", new JSONObject());
    }
    static JSONArray rows(int start, int count) throws Exception { JSONArray rows = new JSONArray(); for (int number = start; number < start + count; number++) rows.put(snapshot(number, "").getJSONObject("conversation")); return rows; }
    static Object field(Object value, String name) throws Exception { Field field = value.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(value); }
    static Map<?, ?> map(Object value, String name) throws Exception { return (Map<?, ?>) field(value, name); }
    static ScheduledThreadPoolExecutor executor(RemotePrefetch cache) throws Exception { return (ScheduledThreadPoolExecutor) field(cache, "worker"); }
    interface Check { boolean done() throws Exception; }
    static void await(Check check) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 5000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) { if (check.done()) return; Thread.sleep(5); }
        fail("Timed out waiting for prefetch");
    }
    static void idle(RemotePrefetch cache) throws Exception { await(() -> { synchronized (cache) { return field(cache, "active") == null && map(cache, "pending").isEmpty(); } }); }
    private Fake fake() { Fake fake = new Fake(); fakes.add(fake); return fake; }
    private RemotePrefetch cache(Fake fake, long delay) { RemotePrefetch cache = new RemotePrefetch(fake::client, delay); caches.add(cache); return cache; }
    private static final class Fake {
        final AtomicInteger calls = new AtomicInteger(), active = new AtomicInteger(), peak = new AtomicInteger();
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        final List<Integer> order = new CopyOnWriteArrayList<>(); boolean block, revoked; int limit;
        RemoteApi client(String address) {
            return new RemoteApi("http://100.64.0.1:43128") {
                @Override JSONObject json(String path, String token, JSONObject payload, int responseLimit) throws IOException {
                    int call = calls.incrementAndGet(); peak.accumulateAndGet(active.incrementAndGet(), Math::max); limit = responseLimit;
                    try {
                        assertNull(payload); assertFalse(path.contains("?")); int number = Integer.parseInt(path.substring(path.lastIndexOf('-') + 1));
                        order.add(number); entered.countDown(); if (block && call == 1) assertTrue(release.await(5, TimeUnit.SECONDS));
                        if (revoked) throw new RemoteApi.Failure(401); return snapshot(number, "request-" + call);
                    } catch (Exception error) { if (error instanceof IOException) throw (IOException) error; throw new IOException(error); }
                    finally { active.decrementAndGet(); }
                }
                @Override public void cancel() { }
            };
        }
    }
}
