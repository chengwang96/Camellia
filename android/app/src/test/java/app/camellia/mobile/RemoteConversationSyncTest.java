package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class RemoteConversationSyncTest {
    private static final String ADDRESS = "http://100.80.1.2:43127";
    private static final String TOKEN = "a".repeat(43);

    private static class FakeApi extends RemoteApi {
        final CountDownLatch opened = new CountDownLatch(1), stopped = new CountDownLatch(1);
        final AtomicInteger reads = new AtomicInteger();
        final boolean legacy;
        volatile SnapshotListener listener;
        FakeApi(boolean legacy) { super(ADDRESS); this.legacy = legacy; }
        @Override public void listEvents(String token, SnapshotListener target) throws IOException {
            listener = target;
            try {
                target.onSnapshot(legacy ? new JSONObject().put("listVersion", "1")
                    : new JSONObject().put("conversationList", page("running")));
                opened.countDown();
                stopped.await();
            } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            catch (org.json.JSONException error) { throw new IOException(error); }
        }
        @Override public JSONObject json(String path, String token, JSONObject payload) {
            reads.incrementAndGet();
            return page("idle");
        }
        @Override public void cancel() { stopped.countDown(); }
    }

    private static JSONObject page(String activity) {
        try { return new JSONObject().put("conversations", new JSONArray().put(new JSONObject()
            .put("id", "conversation").put("activity", activity))).put("nextOffset", JSONObject.NULL); }
        catch (Exception error) { throw new AssertionError(error); }
    }

    @Test public void pushedStateUpdatesNeedNoFetchAndStopRejectsLateFrames() throws Exception {
        FakeApi api = new FakeApi(false);
        AtomicInteger delivered = new AtomicInteger(), clients = new AtomicInteger();
        try (RemoteConversationSync sync = new RemoteConversationSync(address -> { clients.incrementAndGet(); return api; })) {
            sync.start(ADDRESS, TOKEN, page -> delivered.incrementAndGet());
            assertTrue(api.opened.await(2, TimeUnit.SECONDS));
            sync.start(ADDRESS, TOKEN, page -> fail("Duplicate subscription"));
            assertEquals(1, clients.get());
            assertEquals(1, delivered.get());
            api.listener.onSnapshot(new JSONObject().put("conversationList", page("idle")));
            assertEquals(2, delivered.get());
            assertEquals(0, api.reads.get());
            sync.stop();
            assertTrue(api.stopped.await(2, TimeUnit.SECONDS));
            api.listener.onSnapshot(new JSONObject().put("conversationList", page("running")));
            assertEquals(2, delivered.get());
        }
    }

    @Test public void oldDesktopInvalidationsFetchTheCurrentPage() throws Exception {
        FakeApi api = new FakeApi(true);
        CountDownLatch delivered = new CountDownLatch(1);
        try (RemoteConversationSync sync = new RemoteConversationSync(address -> api)) {
            sync.start(ADDRESS, TOKEN, page -> { assertEquals("idle", page.optJSONArray("conversations").optJSONObject(0).optString("activity")); delivered.countDown(); });
            assertTrue(delivered.await(2, TimeUnit.SECONDS));
            assertEquals(1, api.reads.get());
        }
    }

    @Test public void switchingComputerCancelsOldSubscriptionAndRejectsItsLateFrames() throws Exception {
        FakeApi first = new FakeApi(false), second = new FakeApi(false);
        AtomicInteger delivered = new AtomicInteger(), clients = new AtomicInteger();
        try (RemoteConversationSync sync = new RemoteConversationSync(address -> clients.getAndIncrement() == 0 ? first : second)) {
            sync.start(ADDRESS, TOKEN, page -> delivered.incrementAndGet());
            assertTrue(first.opened.await(2, TimeUnit.SECONDS));
            sync.start("http://100.80.1.3:43127", TOKEN, page -> delivered.incrementAndGet());
            assertTrue(first.stopped.await(2, TimeUnit.SECONDS));
            assertTrue(second.opened.await(2, TimeUnit.SECONDS));
            first.listener.onSnapshot(new JSONObject().put("conversationList", page("running")));
            assertEquals(2, delivered.get());
        }
    }
}
