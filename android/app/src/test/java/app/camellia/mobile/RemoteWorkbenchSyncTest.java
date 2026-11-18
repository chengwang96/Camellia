package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class RemoteWorkbenchSyncTest {
    private static JSONObject computer(int number) throws Exception {
        return new JSONObject().put("address", "http://100.80.1." + number + ":43127").put("token", "a".repeat(43));
    }
    private static JSONObject page(String id, String activity) throws Exception {
        return new JSONObject().put("conversations", new JSONArray().put(new JSONObject()
            .put("id", id).put("activity", activity).put("updatedAt", 1).put("lastReplyAt", 0).put("replyReadAt", 0)));
    }
    private static class Api extends RemoteApi {
        final CountDownLatch opened = new CountDownLatch(1), closed = new CountDownLatch(1);
        final JSONObject initial;
        volatile SnapshotListener listener;
        volatile SseReader.HeartbeatListener heartbeat;
        Api(JSONObject initial) { super("http://100.80.1.2:43127"); this.initial = initial; }
        @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
            this.listener = listener; this.heartbeat = heartbeat;
            try {
                if (initial != null) listener.onSnapshot(new JSONObject().put("workbench", initial));
                opened.countDown(); closed.await();
            } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            catch (org.json.JSONException error) { throw new IOException(error); }
        }
        @Override public void cancel() { closed.countDown(); }
    }

    @Test public void expandingAnOlderTenRowSummaryReadsThirtyRecentRowsWithoutLosingActiveWork() throws Exception {
        verifyExpandedRecent(false);
    }

    @Test public void startingWithRecentExpandedAlsoSupportsAnOlderTenRowSummary() throws Exception {
        verifyExpandedRecent(true);
    }

    private void verifyExpandedRecent(boolean expandedBeforeStart) throws Exception {
        JSONObject computer = computer(2);
        JSONArray shortRows = new JSONArray(), allRows = new JSONArray();
        for (int i = 0; i < 40; i++) {
            JSONObject row = page("recent-" + i, "idle").getJSONArray("conversations").getJSONObject(0)
                .put("updatedAt", i).put("filePreview", "PRIVATE");
            allRows.put(row);
            if (i >= 30) shortRows.put(row);
        }
        allRows.put(page("old-running", "running").getJSONArray("conversations").getJSONObject(0).put("updatedAt", -1));
        JSONObject initial = new JSONObject().put("conversations", shortRows);
        CountDownLatch shortDelivered = new CountDownLatch(1), expanded = new CountDownLatch(1);
        AtomicReference<JSONObject> result = new AtomicReference<>(); AtomicInteger listStarts = new AtomicInteger();
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> new Api(initial) {
            @Override void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
                listStarts.incrementAndGet();
                try {
                    listener.onSnapshot(new JSONObject().put("conversationList", new JSONObject().put("conversations", allRows)));
                    closed.await();
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                catch (org.json.JSONException error) { throw new IOException(error); }
            }
            @Override public JSONObject json(String path, String token, JSONObject payload) { throw new AssertionError("No extra page is needed"); }
        })) {
            if (expandedBeforeStart) sync.setRecentLimit(30);
            sync.start(List.of(computer), update -> {
                if (update.page == null) return;
                int count = update.page.optJSONArray("conversations").length();
                if (count == 10) shortDelivered.countDown();
                if (count == 31) { result.set(update.page); expanded.countDown(); }
            });
            if (!expandedBeforeStart) {
                assertTrue(shortDelivered.await(2, TimeUnit.SECONDS)); assertEquals(0, listStarts.get());
                sync.setRecentLimit(30);
            }
            assertTrue(expanded.await(2, TimeUnit.SECONDS)); assertEquals(1, listStarts.get());
            JSONArray rows = result.get().getJSONArray("conversations");
            assertEquals("recent-39", rows.getJSONObject(0).getString("id"));
            assertEquals("recent-10", rows.getJSONObject(29).getString("id"));
            assertEquals("old-running", rows.getJSONObject(30).getString("id"));
            assertFalse(result.get().toString().contains("PRIVATE"));
            sync.setRecentLimit(3); assertEquals(RemoteWorkbenchSync.State.LIVE, sync.state(computer));
        }
    }

    @Test public void slowHostsCannotHoldFastHostsAndStartsAreCoalesced() throws Exception {
        JSONObject slowComputer = computer(2), fastComputer = computer(3);
        Api slow = new Api(null), fast = new Api(page("fast", "running"));
        CountDownLatch delivered = new CountDownLatch(1);
        AtomicInteger clients = new AtomicInteger(), updates = new AtomicInteger();
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> {
            clients.incrementAndGet(); return address.equals(slowComputer.optString("address")) ? slow : fast;
        })) {
            var computers = List.of(slowComputer, fastComputer);
            sync.start(computers, update -> { if (update.page != null) { updates.incrementAndGet(); delivered.countDown(); } });
            assertTrue(slow.opened.await(2, TimeUnit.SECONDS)); assertTrue(delivered.await(2, TimeUnit.SECONDS));
            assertEquals(RemoteWorkbenchSync.State.CONNECTING, sync.state(slowComputer));
            assertEquals(RemoteWorkbenchSync.State.LIVE, sync.state(fastComputer));
            sync.start(computers, update -> { if (update.page != null) updates.incrementAndGet(); });
            assertEquals(2, clients.get());
            sync.stop();
            assertTrue(slow.closed.await(2, TimeUnit.SECONDS)); assertTrue(fast.closed.await(2, TimeUnit.SECONDS));
            fast.listener.onSnapshot(new JSONObject().put("workbench", page("late", "idle")));
            assertEquals(1, updates.get());
        }
    }

    @Test public void removedOrRepairedHostsRejectAlreadyQueuedUpdatesAndLateFrames() throws Exception {
        JSONObject computer = computer(2), replacement = new JSONObject(computer.toString()).put("token", "b".repeat(43));
        Api first = new Api(page("same-id", "running")), second = new Api(page("same-id", "idle"));
        AtomicInteger clients = new AtomicInteger(), updates = new AtomicInteger();
        AtomicReference<RemoteWorkbenchSync.Update> queued = new AtomicReference<>();
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> clients.getAndIncrement() == 0 ? first : second)) {
            sync.start(List.of(computer), update -> { updates.incrementAndGet(); queued.set(update); });
            assertTrue(first.opened.await(2, TimeUnit.SECONDS));
            var old = queued.get();
            sync.start(List.of(replacement), update -> updates.incrementAndGet());
            assertTrue(first.closed.await(2, TimeUnit.SECONDS)); assertTrue(second.opened.await(2, TimeUnit.SECONDS));
            assertFalse(sync.current(old));
            first.listener.onSnapshot(new JSONObject().put("workbench", page("old", "running")));
            assertEquals(2, updates.get());
        }
    }

    @Test public void manualRefreshPreservesRecentVerificationAndRejectsTheReplacedStream() throws Exception {
        JSONObject computer = computer(2);
        Api first = new Api(page("task", "running")), second = new Api(null);
        AtomicInteger clients = new AtomicInteger(), updates = new AtomicInteger();
        AtomicReference<RemoteWorkbenchSync.Update> queued = new AtomicReference<>();
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> clients.getAndIncrement() == 0 ? first : second)) {
            sync.start(List.of(computer), update -> { updates.incrementAndGet(); queued.set(update); });
            assertTrue(first.opened.await(2, TimeUnit.SECONDS));
            var old = queued.get();
            sync.refresh(List.of(computer), update -> updates.incrementAndGet());
            assertTrue(second.opened.await(2, TimeUnit.SECONDS));
            assertEquals(RemoteWorkbenchSync.State.LIVE, sync.state(computer));
            assertFalse(sync.current(old));
            first.listener.onSnapshot(new JSONObject().put("workbench", page("old", "running")));
            assertEquals(1, updates.get());
            second.listener.onSnapshot(new JSONObject().put("workbench", page("task", "idle")));
            assertEquals(2, updates.get());
        }
    }

    @Test public void anOpeningTimeoutMarksOnlyThatHostStaleAndCancelsItsTransport() throws Exception {
        JSONObject slowComputer = computer(2), fastComputer = computer(3);
        Api slow = new Api(null), fast = new Api(page("fast", "running"));
        CountDownLatch stale = new CountDownLatch(1);
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> address.equals(slowComputer.optString("address")) ? slow : fast, 60, 10_000, 10_000)) {
            sync.start(List.of(slowComputer, fastComputer), update -> {
                if (update.state == RemoteWorkbenchSync.State.STALE && update.computer == slowComputer) stale.countDown();
            });
            assertTrue(fast.opened.await(2, TimeUnit.SECONDS)); assertTrue(stale.await(2, TimeUnit.SECONDS));
            assertTrue(slow.closed.await(2, TimeUnit.SECONDS));
            assertEquals(RemoteWorkbenchSync.State.LIVE, sync.state(fastComputer));
            slow.listener.onSnapshot(new JSONObject().put("workbench", page("late", "running")));
            assertEquals(RemoteWorkbenchSync.State.STALE, sync.state(slowComputer));
        }
    }

    @Test public void silentStreamsBecomeUnconfirmedAndAuthorizationFailuresStopRetries() throws Exception {
        JSONObject computer = computer(2);
        Api api = new Api(page("silent", "running")); CountDownLatch stale = new CountDownLatch(1);
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> api, 30, 80, 10_000)) {
            sync.start(List.of(computer), update -> { if (update.state == RemoteWorkbenchSync.State.STALE) stale.countDown(); });
            assertTrue(stale.await(2, TimeUnit.SECONDS)); assertTrue(api.closed.await(2, TimeUnit.SECONDS));
        }
        AtomicInteger clients = new AtomicInteger(); CountDownLatch denied = new CountDownLatch(1);
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> {
            clients.incrementAndGet(); return new Api(null) {
                @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException { throw new Failure(403); }
            };
        }, 20, 50, 1)) {
            sync.start(List.of(computer), update -> { if (update.state == RemoteWorkbenchSync.State.UNAUTHORIZED) denied.countDown(); });
            assertTrue(denied.await(2, TimeUnit.SECONDS));
            sync.start(List.of(computer), update -> fail("A denied host must wait for explicit retry"));
            assertEquals(1, clients.get());
        }
    }

    @Test public void legacyStreamFetchesRemainingPagesAndKeepsOldRunningTasksWithoutFilePayloads() throws Exception {
        JSONObject computer = computer(2); CountDownLatch delivered = new CountDownLatch(1), close = new CountDownLatch(1);
        AtomicReference<JSONObject> result = new AtomicReference<>(); AtomicInteger reads = new AtomicInteger();
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> new Api(null) {
            @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException { throw new Failure(404); }
            @Override void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
                try {
                    listener.onSnapshot(new JSONObject().put("conversationList", page("recent", "idle").put("nextOffset", 100)));
                    close.await();
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                catch (org.json.JSONException error) { throw new IOException(error); }
                catch (Exception error) { throw new IOException(error); }
            }
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                assertEquals("/v1/conversations?offset=100", path); reads.incrementAndGet();
                try { JSONObject page = page("old-running", "running"); page.getJSONArray("conversations").getJSONObject(0).put("filePreview", "PRIVATE"); return page; }
                catch (Exception error) { throw new IOException(error); }
            }
            @Override public void cancel() { /* The missing endpoint has no active stream. */ }
        })) {
            sync.start(List.of(computer), update -> { if (update.page != null) { result.set(update.page); delivered.countDown(); } });
            assertTrue(delivered.await(2, TimeUnit.SECONDS));
            assertEquals(1, reads.get()); assertEquals(2, result.get().getJSONArray("conversations").length());
            assertTrue(result.get().toString().contains("old-running")); assertFalse(result.get().toString().contains("PRIVATE"));
        } finally { close.countDown(); }
    }

    @Test public void summaryWithoutReplyMarkersUsesSessionStreamAndPreservesUnreadAndReadUpdates() throws Exception {
        JSONObject computer = computer(2), oldSummary = page("recent", "idle"), listed = page("recent", "idle");
        oldSummary.getJSONArray("conversations").getJSONObject(0).remove("lastReplyAt");
        oldSummary.getJSONArray("conversations").getJSONObject(0).remove("replyReadAt");
        listed.getJSONArray("conversations").getJSONObject(0).put("lastReplyAt", 100).put("replyReadAt", 0).put("filePreview", "PRIVATE");
        AtomicReference<RemoteApi.SnapshotListener> sessionListener = new AtomicReference<>();
        AtomicReference<JSONObject> result = new AtomicReference<>();
        AtomicInteger summaryStarts = new AtomicInteger(), sessionStarts = new AtomicInteger();
        CountDownLatch delivered = new CountDownLatch(1);
        try (RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> new Api(oldSummary) {
            @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
                summaryStarts.incrementAndGet(); super.workbenchEvents(token, listener, heartbeat);
            }
            @Override void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
                sessionStarts.incrementAndGet(); sessionListener.set(listener);
                try { listener.onSnapshot(new JSONObject().put("conversationList", listed)); closed.await(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                catch (org.json.JSONException error) { throw new IOException(error); }
            }
            @Override public JSONObject json(String path, String token, JSONObject payload) { throw new AssertionError("A full list snapshot needs no extra read"); }
        })) {
            sync.start(List.of(computer), update -> { if (update.page != null) { result.set(update.page); delivered.countDown(); } });
            assertTrue(delivered.await(2, TimeUnit.SECONDS));
            assertEquals("Old summaries must use the same data as Sessions", 1, sessionStarts.get());
            assertEquals(1, summaryStarts.get());
            assertEquals(100, result.get().getJSONArray("conversations").getJSONObject(0).getLong("lastReplyAt"));
            assertEquals(0, result.get().getJSONArray("conversations").getJSONObject(0).getLong("replyReadAt"));
            assertFalse(result.get().toString().contains("PRIVATE"));
            listed.getJSONArray("conversations").getJSONObject(0).put("replyReadAt", 100);
            sessionListener.get().onSnapshot(new JSONObject().put("conversationList", listed));
            assertEquals(100, result.get().getJSONArray("conversations").getJSONObject(0).getLong("replyReadAt"));
            listed.getJSONArray("conversations").getJSONObject(0).put("lastReplyAt", 101);
            sessionListener.get().onSnapshot(new JSONObject().put("conversationList", listed));
            assertEquals(101, result.get().getJSONArray("conversations").getJSONObject(0).getLong("lastReplyAt"));
        }
    }
}
