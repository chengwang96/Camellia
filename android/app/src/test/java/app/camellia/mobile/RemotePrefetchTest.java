package app.camellia.mobile;

import static org.junit.Assert.*;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

public class RemotePrefetchTest {
    private final List<RemotePrefetch> caches = new ArrayList<>();
    private final List<Fake> fakes = new ArrayList<>();
    @After public void cleanup() throws Exception {
        for (Fake fake : fakes) fake.release.countDown();
        for (RemotePrefetch cache : caches) { cache.close(); assertTrue(executor(cache).awaitTermination(5, TimeUnit.SECONDS)); }
    }

    @Test public void thousandsOfRowsProduceOnlyFourVisibleAndTwoNearbyRequests() throws Exception {
        Fake fake = fake(); RemotePrefetch cache = cache(fake, 0);
        cache.schedule(owner("one"), rows(1, 10_000), rows(20_001, 10_000)); idle(cache);
        assertEquals(Arrays.asList(1, 2, 3, 4, 20_001, 20_002), fake.order);
        assertEquals(1, fake.peak.get()); assertEquals(6, map(cache, "desired").size());
        assertEquals(6, map(cache, "entries").size()); assertEquals(0, executor(cache).getQueue().size());
        assertEquals(RemotePrefetch.RESPONSE_LIMIT, fake.limit);
    }

    @Test public void nearbyWaitsForIdleAndInteractionRefreshesTheDelay() throws Exception {
        Fake fake = fake(); RemotePrefetch cache = cache(fake, 180);
        cache.schedule(owner("one"), rows(1, 4), rows(5, 2)); await(() -> fake.calls.get() == 4);
        for (int repeat = 0; repeat < 3; repeat++) { cache.interaction(); Thread.sleep(60); assertEquals(4, fake.calls.get()); }
        idle(cache); assertEquals(6, fake.calls.get());
    }

    @Test public void viewportReplacementDropsOldQueueAndLateResponse() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        cache.schedule(owner("one"), rows(1, 4), rows(5, 2)); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        cache.schedule(owner("one"), rows(101, 4), rows(105, 2));
        assertEquals(6, map(cache, "pending").size()); assertTrue(executor(cache).getQueue().isEmpty());
        fake.release.countDown(); idle(cache);
        assertEquals(Arrays.asList(1, 101, 102, 103, 104, 105, 106), fake.order); assertNull(cache.get(owner("one"), id(1)));
        assertEquals(1, fake.peak.get());
    }

    @Test public void unchangedViewportKeepsItsActiveRequestAndDeduplicates() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        JSONArray visible = rows(1, 4), nearby = rows(5, 2);
        cache.schedule(owner("one"), visible, nearby); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        for (int repeat = 0; repeat < 100; repeat++) cache.schedule(owner("one"), visible, nearby);
        assertEquals(5, map(cache, "pending").size()); assertEquals(6, map(cache, "desired").size());
        fake.release.countDown(); idle(cache); assertEquals(6, fake.calls.get());
        cache.schedule(owner("one"), visible, nearby); idle(cache); assertEquals(6, fake.calls.get());
    }

    @Test public void cancelledRequestCannotPublishAfterReturningToSameConversation() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        cache.schedule(owner("one"), rows(1, 1), new JSONArray()); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        cache.cancel(); cache.schedule(owner("one"), rows(1, 1), new JSONArray());
        fake.release.countDown(); idle(cache); assertEquals(2, fake.calls.get());
        assertEquals("request-2", cache.get(owner("one"), id(1)).getJSONArray("messages").getJSONObject(0).getString("text"));
    }

    @Test public void onlyTheNewComputerRemainsEligible() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        cache.schedule(owner("one"), rows(1, 4), rows(5, 2)); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        cache.schedule(owner("two"), rows(101, 1), new JSONArray()); fake.release.countDown(); idle(cache);
        assertEquals(Arrays.asList(1, 101), fake.order); assertNull(cache.get(owner("one"), id(1)));
        assertNotNull(cache.get(owner("two"), id(101))); assertNull(cache.get(owner("one"), id(101)));
    }

    @Test public void changingAVersionReplacesTheActiveCandidate() throws Exception {
        Fake fake = fake(); fake.block = true; RemotePrefetch cache = cache(fake, 0);
        JSONArray visible = rows(1, 1); cache.schedule(owner("one"), visible, new JSONArray()); assertTrue(fake.entered.await(5, TimeUnit.SECONDS));
        visible.getJSONObject(0).put("seq", 3); cache.schedule(owner("one"), visible, new JSONArray());
        fake.release.countDown(); idle(cache); assertEquals(2, fake.calls.get());
        assertEquals("request-2", cache.get(owner("one"), id(1)).getJSONArray("messages").getJSONObject(0).getString("text"));
    }

    @Test public void revocationClearsOnlyTheAffectedComputerAndQueue() throws Exception {
        Fake fake = fake(); fake.status = 401; RemotePrefetch cache = cache(fake, 0);
        cache.put(owner("one"), snapshot(90, "old")); cache.put(owner("two"), snapshot(91, "other"));
        cache.schedule(owner("one"), rows(1, 4), rows(5, 2)); idle(cache);
        assertEquals(1, fake.calls.get()); assertNull(cache.get(owner("one"), id(90))); assertNotNull(cache.get(owner("two"), id(91)));
        assertTrue(map(cache, "desired").isEmpty());
    }

    @Test public void deletedConversationDoesNotStopOtherCandidates() throws Exception {
        Fake fake = fake(); fake.status = 404; fake.failFirstOnly = true; RemotePrefetch cache = cache(fake, 0);
        cache.put(owner("one"), snapshot(1, "old")); JSONArray visible = rows(1, 2); visible.getJSONObject(0).put("seq", 3);
        cache.schedule(owner("one"), visible, new JSONArray()); idle(cache);
        assertNull(cache.get(owner("one"), id(1))); assertNotNull(cache.get(owner("one"), id(2))); assertEquals(2, fake.calls.get());
    }

    @Test public void failedPrefetchDoesNotRetryOnEveryViewportNotification() throws Exception {
        Fake fake = fake(); fake.failFirstOnly = true; fake.status = 0; RemotePrefetch cache = cache(fake, 0);
        JSONArray visible = rows(1, 2); cache.schedule(owner("one"), visible, new JSONArray()); idle(cache);
        for (int repeat = 0; repeat < 100; repeat++) cache.schedule(owner("one"), visible, new JSONArray());
        idle(cache); assertEquals(2, fake.calls.get()); assertNull(cache.get(owner("one"), id(1))); assertNotNull(cache.get(owner("one"), id(2)));
        cache.cancel(); cache.schedule(owner("one"), rows(1, 1), new JSONArray()); idle(cache); assertEquals(3, fake.calls.get());
    }

    @Test public void cacheIsDetachedAndContainsNoControlState() throws Exception {
        RemotePrefetch cache = cache(fake(), 0); JSONObject input = snapshot(1, "old");
        cache.put(owner("one"), input); input.getJSONArray("messages").getJSONObject(0).put("text", "changed");
        JSONObject cached = cache.get(owner("one"), id(1)); assertFalse(cached.has("live")); assertFalse(cached.has("permission")); assertFalse(cached.has("settings"));
        cached.getJSONArray("messages").getJSONObject(0).put("text", "returned changed");
        assertEquals("old", cache.get(owner("one"), id(1)).getJSONArray("messages").getJSONObject(0).getString("text"));
        assertNull(cache.get(new JSONObject(owner("one").toString()).put("token", "other"), id(1)));
    }

    @Test public void eightEntryLruRetainsRecentlyReadConversation() throws Exception {
        RemotePrefetch cache = cache(fake(), 0);
        for (int number = 1; number <= 8; number++) cache.put(owner("one"), snapshot(number, "text"));
        assertNotNull(cache.get(owner("one"), id(1))); cache.put(owner("one"), snapshot(9, "text"));
        assertNull(cache.get(owner("one"), id(2))); assertNotNull(cache.get(owner("one"), id(1))); assertEquals(8, map(cache, "entries").size());
    }

    @Test public void utf16AccountingBoundsStoredStringsAtTwoMiB() throws Exception {
        RemotePrefetch cache = cache(fake(), 0); String text = "中".repeat(300_000);
        for (int number = 1; number <= 5; number++) cache.put(owner("one"), snapshot(number, text));
        assertEquals(3, map(cache, "entries").size()); assertNull(cache.get(owner("one"), id(1))); assertNotNull(cache.get(owner("one"), id(5)));
        long size = (long) field(cache, "size"), budget = (long) field(cache, "budget");
        assertEquals(2 * 1024 * 1024L, budget); assertTrue(size <= budget); assertTrue(size > 1_800_000);
    }

    @Test public void oversizedEntryInvalidatesItsOlderPreview() throws Exception {
        RemotePrefetch cache = cache(fake(), 0); cache.put(owner("one"), snapshot(1, "old"));
        cache.put(owner("one"), snapshot(1, "x".repeat(600_000))); assertNull(cache.get(owner("one"), id(1)));
        assertEquals(0L, field(cache, "size")); assertTrue(map(cache, "entries").isEmpty());
    }

    @Test public void freshVersionSkipsAndExpiredVersionGetsOneNewAttempt() throws Exception {
        Fake fake = fake(); AtomicLong clock = new AtomicLong(100);
        RemotePrefetch cache = new RemotePrefetch(fake::client, 0, clock::get, 64L * 1024 * 1024); caches.add(cache);
        JSONArray visible = rows(1, 1); cache.schedule(owner("one"), visible, new JSONArray()); idle(cache);
        cache.schedule(owner("one"), visible, new JSONArray()); idle(cache); assertEquals(1, fake.calls.get());
        clock.addAndGet(60_001); cache.schedule(owner("one"), visible, new JSONArray()); idle(cache); assertEquals(2, fake.calls.get());
    }

    @Test public void invalidIdentityClearsThePreviousSelection() throws Exception {
        RemotePrefetch cache = cache(fake(), 60_000); cache.schedule(owner("one"), new JSONArray(), rows(1, 2));
        cache.schedule(new JSONObject().put("address", "two"), rows(10, 4), new JSONArray());
        assertTrue(map(cache, "pending").isEmpty()); assertTrue(map(cache, "desired").isEmpty()); assertTrue(executor(cache).getQueue().isEmpty());
    }

    private Fake fake() { Fake fake = new Fake(); fakes.add(fake); return fake; }
    private RemotePrefetch cache(Fake fake, long delay) {
        RemotePrefetch cache = new RemotePrefetch(fake::client, delay, () -> TimeUnit.NANOSECONDS.toMillis(System.nanoTime()), 64L * 1024 * 1024);
        caches.add(cache); return cache;
    }
    static String id(int number) { return String.format(Locale.ROOT, "00000000-0000-0000-0000-%012d", number); }
    static JSONObject owner(String address) throws Exception { return new JSONObject().put("address", address).put("token", "token"); }
    static JSONObject snapshot(int number, String text) throws Exception {
        return new JSONObject().put("conversation", new JSONObject().put("id", id(number)).put("seq", 2).put("updatedAt", number))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", text)))
            .put("live", new JSONObject()).put("permission", "control").put("settings", new JSONObject());
    }
    static JSONArray rows(int first, int count) throws Exception {
        JSONArray rows = new JSONArray();
        for (int number = first; number < first + count; number++) rows.put(snapshot(number, "").getJSONObject("conversation"));
        return rows;
    }
    static Object field(Object value, String name) throws Exception { Field field = value.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(value); }
    static Map<?, ?> map(Object value, String name) throws Exception { return (Map<?, ?>) field(value, name); }
    static ScheduledThreadPoolExecutor executor(RemotePrefetch cache) throws Exception { return (ScheduledThreadPoolExecutor) field(cache, "worker"); }
    static void idle(RemotePrefetch cache) throws Exception { await(() -> { synchronized (cache) { return field(cache, "active") == null && map(cache, "pending").isEmpty(); } }); }
    interface Check { boolean done() throws Exception; }
    static void await(Check check) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) { if (check.done()) return; Thread.sleep(5); }
        fail("Timed out waiting for prefetch");
    }

    static final class Fake {
        final AtomicInteger calls = new AtomicInteger(), active = new AtomicInteger(), peak = new AtomicInteger();
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        final List<Integer> order = new CopyOnWriteArrayList<>();
        boolean block, failFirstOnly; int status = -1, limit;
        RemoteApi client(String address) {
            return new RemoteApi("http://100.64.0.1:43128") {
                @Override JSONObject json(String path, String token, JSONObject payload, int responseLimit) throws IOException {
                    int call = calls.incrementAndGet(); int running = active.incrementAndGet(); peak.accumulateAndGet(running, Math::max);
                    limit = responseLimit;
                    try {
                        assertNull(payload); assertFalse(path.contains("?"));
                        int number = Integer.parseInt(path.substring(path.lastIndexOf('-') + 1)); order.add(number); entered.countDown();
                        if (block && call == 1) assertTrue(release.await(5, TimeUnit.SECONDS));
                        if (status >= 0 && (!failFirstOnly || call == 1)) { if (status == 0) throw new IOException("Oversized response"); throw new RemoteApi.Failure(status); }
                        return snapshot(number, "request-" + call);
                    } catch (InterruptedException error) { throw new IOException(error); }
                    catch (org.json.JSONException error) { throw new IOException(error); }
                    catch (Exception error) { if (error instanceof IOException) throw (IOException) error; throw new IOException(error); }
                    finally { active.decrementAndGet(); }
                }
                @Override public void cancel() { }
            };
        }
    }
}
