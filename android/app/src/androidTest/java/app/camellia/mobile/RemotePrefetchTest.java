package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class RemotePrefetchTest extends InstrumentationTestCase {
    private String id(int number) { return String.format(java.util.Locale.ROOT, "00000000-0000-0000-0000-%012d", number); }
    private JSONObject identity() throws Exception {
        return new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43));
    }
    private JSONObject snapshot(int number, String text) throws Exception {
        return new JSONObject().put("conversation", new JSONObject().put("id", id(number)).put("seq", 2).put("updatedAt", number))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", text)))
            .put("permission", "control").put("live", new JSONObject().put("approvals", new JSONArray().put("private")))
            .put("settings", new JSONObject().put("editable", true)).put("instanceId", "server");
    }
    private void awaitIdle(RemotePrefetch cache) throws Exception {
        var active = RemotePrefetch.class.getDeclaredField("active"); active.setAccessible(true);
        var pending = RemotePrefetch.class.getDeclaredField("pending"); pending.setAccessible(true);
        long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            synchronized (cache) { if (active.get(cache) == null && ((java.util.Map<?, ?>) pending.get(cache)).isEmpty()) return; }
            Thread.sleep(10);
        }
        fail("Prefetch did not finish");
    }

    public void testMemoryCacheIsIsolatedBoundedAndContainsNoControlState() throws Exception {
        RemotePrefetch cache = new RemotePrefetch();
        try {
            JSONObject owner = identity();
            cache.put(owner, snapshot(1, "cached reply"));
            JSONObject entry = cache.get(owner, id(1));
            assertNotNull(entry);
            assertFalse(entry.has("live")); assertFalse(entry.has("permission")); assertFalse(entry.has("settings"));
            assertNull(cache.get(new JSONObject(owner.toString()).put("token", "b".repeat(43)), id(1)));
            assertNull(cache.get(new JSONObject(owner.toString()).put("address", "http://100.64.0.2:43128"), id(1)));
            entry.getJSONArray("messages").getJSONObject(0).put("text", "mutated");
            assertEquals("cached reply", cache.get(owner, id(1)).getJSONArray("messages").getJSONObject(0).getString("text"));
            for (int number = 2; number <= 30; number++) cache.put(owner, snapshot(number, "reply"));
            assertNotNull(cache.get(owner, id(1))); assertNotNull(cache.get(owner, id(30)));
            cache.put(owner, snapshot(31, "x".repeat(2 * 1024 * 1024)));
            assertNull(cache.get(owner, id(31)));
            for (int number = 32; number <= 70; number++) cache.put(owner, snapshot(number, "x".repeat(1024 * 1024)));
            assertNull(cache.get(owner, id(1))); assertNotNull(cache.get(owner, id(70)));
            cache.remove(owner, null); assertNull(cache.get(owner, id(70)));
        } finally { cache.close(); }
    }

    public void testTenRecentConversationsThenIdleRemainderAndFreshEntriesSkipped() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        CountDownLatch firstTen = new CountDownLatch(10);
        java.util.List<Integer> order = new java.util.concurrent.CopyOnWriteArrayList<>();
        RemotePrefetch cache = new RemotePrefetch(address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                assertNull(payload); requests.incrementAndGet(); firstTen.countDown();
                int number = Integer.parseInt(path.substring(path.lastIndexOf('-') + 1)); order.add(number);
                try { return snapshot(number, "prefetched"); }
                catch (Exception error) { throw new IOException(error); }
            }
        }, 600);
        try {
            JSONArray rows = new JSONArray();
            for (int number = 1; number <= 15; number++) rows.put(snapshot(number, "").getJSONObject("conversation"));
            cache.schedule(identity(), rows); assertTrue(firstTen.await(2, TimeUnit.SECONDS));
            for (int repeat = 0; repeat < 4; repeat++) { cache.interaction(); Thread.sleep(200); }
            assertEquals(10, requests.get()); assertEquals(Integer.valueOf(15), order.get(0));
            assertNull(cache.get(identity(), id(1)));
            awaitIdle(cache); assertEquals(15, requests.get());
            assertNotNull(cache.get(identity(), id(15))); assertNotNull(cache.get(identity(), id(1)));
            cache.schedule(identity(), rows); awaitIdle(cache); assertEquals(15, requests.get());
            rows.getJSONObject(14).put("seq", 3);
            cache.schedule(identity(), rows); awaitIdle(cache); assertEquals(16, requests.get());
        } finally { cache.close(); }
    }

    public void testCancelledPrefetchCannotPublishLateResponse() throws Exception {
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1), ended = new CountDownLatch(1);
        RemotePrefetch cache = new RemotePrefetch(address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                started.countDown();
                try { release.await(3, TimeUnit.SECONDS); return snapshot(1, "late"); }
                catch (Exception error) { throw new IOException(error); }
                finally { ended.countDown(); }
            }
        });
        try {
            cache.schedule(identity(), new JSONArray().put(snapshot(1, "").getJSONObject("conversation")));
            assertTrue(started.await(2, TimeUnit.SECONDS)); cache.cancel(); release.countDown();
            assertTrue(ended.await(2, TimeUnit.SECONDS));
            cache.close();
            assertNull(cache.get(identity(), id(1)));
        } finally { release.countDown(); cache.close(); }
    }

    public void testRevocationClearsAlreadyCachedContent() throws Exception {
        RemotePrefetch cache = new RemotePrefetch(address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException { throw new RemoteApi.Failure(401); }
        });
        try {
            cache.put(identity(), snapshot(1, "old"));
            cache.schedule(identity(), new JSONArray().put(snapshot(2, "").getJSONObject("conversation")));
            awaitIdle(cache); assertNull(cache.get(identity(), id(1)));
        } finally { cache.close(); }
    }

    public void testIdleLoadsLaterListPagesAndDoesNotRepeatThem() throws Exception {
        AtomicInteger pages = new AtomicInteger(), replies = new AtomicInteger();
        RemotePrefetch cache = new RemotePrefetch(address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                assertNull(payload);
                try {
                    if (path.contains("?offset=")) {
                        pages.incrementAndGet();
                        int offset = Integer.parseInt(path.substring(path.indexOf('=') + 1));
                        return new JSONObject().put("conversations", new JSONArray().put(snapshot(offset, "").getJSONObject("conversation")))
                            .put("nextOffset", offset == 100 ? 200 : JSONObject.NULL);
                    }
                    replies.incrementAndGet();
                    return snapshot(Integer.parseInt(path.substring(path.lastIndexOf('-') + 1)), "reply");
                } catch (Exception error) { throw new IOException(error); }
            }
        }, 100);
        try {
            JSONArray rows = new JSONArray().put(snapshot(1, "").getJSONObject("conversation"));
            cache.schedule(identity(), rows, 100); awaitIdle(cache);
            assertEquals(2, pages.get()); assertEquals(3, replies.get());
            assertNotNull(cache.get(identity(), id(100))); assertNotNull(cache.get(identity(), id(200)));
            cache.schedule(identity(), rows, 100); awaitIdle(cache);
            assertEquals(2, pages.get()); assertEquals(3, replies.get());
        } finally { cache.close(); }
    }

    public void testCancelRemovesIdleQueueAndOtherComputersAreNotDropped() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        RemotePrefetch cache = new RemotePrefetch(address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                requests.incrementAndGet();
                try { return snapshot(Integer.parseInt(path.substring(path.lastIndexOf('-') + 1)), "reply"); }
                catch (Exception error) { throw new IOException(error); }
            }
        }, 500);
        try {
            JSONObject other = new JSONObject(identity().toString()).put("address", "http://100.64.0.2:43128");
            JSONArray rows = new JSONArray().put(snapshot(1, "").getJSONObject("conversation"));
            cache.scheduleIdle(identity(), rows, -1); cache.cancel();
            Thread.sleep(700); assertEquals(0, requests.get());
            cache.scheduleIdle(identity(), rows, -1); cache.schedule(other, rows); awaitIdle(cache);
            assertEquals(2, requests.get());
            assertNotNull(cache.get(identity(), id(1))); assertNotNull(cache.get(other, id(1)));
        } finally { cache.close(); }
    }
}
