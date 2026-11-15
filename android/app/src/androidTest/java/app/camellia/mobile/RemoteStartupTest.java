package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

public class RemoteStartupTest extends InstrumentationTestCase {
    private Activity activity;
    private final CountDownLatch shutdown = new CountDownLatch(1), releaseReads = new CountDownLatch(1);
    private final String address = "http://100.80.1.2:43127", token = "a".repeat(43);
    private boolean downgraded, blockedEvents, blockedStatus;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        releaseReads.countDown(); shutdown.countDown();
        if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
        getInstrumentation().waitForIdleSync();
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        super.tearDown();
    }

    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }
    private void call(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }

    private void startup(boolean known, boolean sameAddress, boolean sameToken, boolean busyReads) throws Exception {
        AtomicInteger statusReads = new AtomicInteger(), otherReads = new AtomicInteger(), eventCalls = new AtomicInteger();
        CountDownLatch opened = new CountDownLatch(1), readWorkersEntered = new CountDownLatch(2), oldStreamEntered = new CountDownLatch(1), statusRead = new CountDownLatch(1);
        JSONObject info = new JSONObject().put("protocol", 1).put("permission", "control")
            .put("capabilities", new JSONArray().put("incremental-snapshots"))
            .put("engines", new JSONArray().put("codex"));
        getInstrumentation().runOnMainSync(() -> {
            try {
                field("foreground", false);
                field("credentials", new JSONObject().put("address", address).put("token", token));
                field("conversationId", "00000000-0000-0000-0000-000000000001");
                field("conversationTitle", "Startup");
                call("detailScreen");
                field("remoteClientFactory", (Function<String, RemoteApi>) target -> new RemoteApi(target) {
                    private void hold() throws IOException {
                        try { shutdown.await(); }
                        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
                    }
                    @Override public JSONObject json(String path, String credential, JSONObject payload) throws IOException {
                        if (path.equals("/v1/status")) {
                            statusReads.incrementAndGet(); statusRead.countDown();
                            if (blockedStatus) hold();
                        } else otherReads.incrementAndGet();
                        return info;
                    }
                    @Override void events(String id, String credential, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
                        eventCalls.incrementAndGet();
                        if (downgraded && incremental()) throw new Failure(400);
                        opened.countDown(); hold();
                    }
                    @Override public void listEvents(String credential, SnapshotListener listener) throws IOException { hold(); }
                    @Override public void cancel() { shutdown.countDown(); }
                });
                field("capabilityAddress", known ? sameAddress ? address : "http://100.80.1.3:43127" : "");
                field("capabilityToken", known ? sameToken ? token : "b".repeat(43) : "");
                field("canIncremental", known);
                if (busyReads) {
                    // Isolate the read pool from any Activity-startup work so
                    // the test controls exactly which two calls occupy it.
                    ((ExecutorService) field("worker")).shutdownNow();
                    ExecutorService reads = java.util.concurrent.Executors.newFixedThreadPool(2);
                    field("worker", reads);
                    for (int index = 0; index < 2; index++) reads.submit(() -> {
                        readWorkersEntered.countDown();
                        try { releaseReads.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                    });
                }
                if (blockedEvents) {
                    // Model a socket/native read whose cancellation returns late.
                    // The next connection must not queue behind that old stream.
                    ((ExecutorService) field("eventWorker")).shutdownNow();
                    ExecutorService events = java.util.concurrent.Executors.newSingleThreadExecutor();
                    field("eventWorker", events);
                    field("job", events.submit(() -> {
                        oldStreamEntered.countDown();
                        while (releaseReads.getCount() > 0) {
                            try { releaseReads.await(); } catch (InterruptedException ignored) { }
                        }
                    }));
                    assertTrue(oldStreamEntered.await(3, TimeUnit.SECONDS));
                }
                field("foreground", true);
                call("connectEvents");
            } catch (Exception error) { throw new AssertionError(error); }
        });
        if (busyReads) assertTrue("Both controlled read workers should be occupied", readWorkersEntered.await(3, TimeUnit.SECONDS));
        assertTrue("The chat stream must open without waiting for history workers", opened.await(3, TimeUnit.SECONDS));
        if (!(known && sameAddress && sameToken)) assertTrue("Capabilities should still be discovered independently", statusRead.await(3, TimeUnit.SECONDS));
        assertEquals(known && sameAddress && sameToken ? 0 : 1, statusReads.get());
        assertEquals("Opening chat should not download a duplicate sidebar or transcript", 0, otherReads.get());
        assertEquals(downgraded ? 2 : 1, eventCalls.get());
        getInstrumentation().runOnMainSync(() -> {
            try { assertFalse("Cached control capability must not authorize sends before a fresh snapshot", (boolean) field("connected")); }
            catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testWarmChatSkipsStatusAndBypassesBusyReadWorkers() throws Exception { startup(true, true, true, true); }
    public void testColdChatStillDiscoversCapabilities() throws Exception { startup(false, true, true, false); }
    public void testColdChatBypassesBusyReadWorkers() throws Exception { startup(false, true, true, true); }
    public void testNewChatBypassesCancelledStreamThatClosesLate() throws Exception { blockedEvents = true; startup(true, true, true, false); }
    public void testColdChatDoesNotWaitForAnUnresponsiveStatusEndpoint() throws Exception { blockedStatus = true; startup(false, true, true, false); }
    public void testAnotherComputerCannotReuseCapabilityMetadata() throws Exception { startup(true, false, true, false); }
    public void testChangedCredentialsCannotReuseCapabilityMetadata() throws Exception { startup(true, true, false, false); }
    public void testDesktopDowngradeRetriesTheLegacyStreamOnce() throws Exception { downgraded = true; startup(true, true, true, false); }

    private void stalledStream(boolean initiallySynced) throws Exception {
        String id = "00000000-0000-0000-0000-000000000001";
        AtomicInteger eventCalls = new AtomicInteger();
        CountDownLatch firstOpened = new CountDownLatch(1), replacementOpened = new CountDownLatch(1), cancelled = new CountDownLatch(1);
        var oldListener = new java.util.concurrent.atomic.AtomicReference<RemoteApi.SnapshotListener>();
        JSONObject fresh = new JSONObject().put("instanceId", "server").put("cursor", 2).put("permission", "control")
            .put("conversation", new JSONObject().put("id", id).put("seq", 2))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", "Recovered transcript")));
        getInstrumentation().runOnMainSync(() -> {
            try {
                field("foreground", false);
                field("credentials", new JSONObject().put("address", address).put("token", token));
                field("conversationId", id); field("conversationTitle", "Recovery"); call("detailScreen");
                field("capabilityAddress", address); field("capabilityToken", token);
                field("remoteClientFactory", (Function<String, RemoteApi>) target -> new RemoteApi(target) {
                    private final CountDownLatch closed = new CountDownLatch(1);
                    private boolean first;
                    private void hold(CountDownLatch latch) throws IOException {
                        try { latch.await(); } catch (InterruptedException error) { throw new IOException(error); }
                    }
                    @Override void events(String conversation, String credential, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
                        first = eventCalls.incrementAndGet() == 1;
                        if (first) {
                            oldListener.set(listener);
                            if (initiallySynced) listener.onSnapshot(fresh);
                            firstOpened.countDown();
                            while (releaseReads.getCount() > 0) {
                                try { releaseReads.await(); } catch (InterruptedException ignored) { }
                            }
                        } else {
                            replacementOpened.countDown(); hold(releaseReads);
                            listener.onSnapshot(fresh); hold(closed);
                        }
                    }
                    @Override public void listEvents(String credential, SnapshotListener listener) throws IOException { hold(closed); }
                    @Override public void cancel() { if (first) cancelled.countDown(); closed.countDown(); }
                });
                field("foreground", true); call("connectEvents");
            } catch (Exception error) { throw new AssertionError(error); }
        });
        assertTrue(firstOpened.await(3, TimeUnit.SECONDS));
        if (initiallySynced) awaitConnected();
        getInstrumentation().runOnMainSync(() -> {
            try {
                long now = android.os.SystemClock.elapsedRealtime();
                RemoteStreamHealth expired = new RemoteStreamHealth(now - RemoteStreamHealth.INITIAL_TIMEOUT_MS - 1);
                if (initiallySynced) expired.snapshot(now - RemoteStreamHealth.IDLE_TIMEOUT_MS - 1);
                field("streamHealth", expired); call("inspectStream");
                assertFalse("Recovery must wait for a fresh snapshot before enabling controls", (boolean) field("connected"));
            } catch (Exception error) { throw new AssertionError(error); }
        });
        assertTrue("The stalled client should be cancelled", cancelled.await(3, TimeUnit.SECONDS));
        assertTrue("Its late close must not delay the replacement", replacementOpened.await(3, TimeUnit.SECONDS));
        JSONObject stale = new JSONObject(fresh.toString()).put("cursor", 99);
        stale.put("messages", new JSONArray().put(new JSONObject().put("seq", 99).put("role", "assistant").put("text", "Stale transcript")));
        oldListener.get().onSnapshot(stale);
        android.os.SystemClock.sleep(180); getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            try { assertFalse("A late snapshot from the old generation must not re-enable controls", (boolean) field("connected")); }
            catch (Exception error) { throw new AssertionError(error); }
        });
        releaseReads.countDown(); awaitConnected();
        getInstrumentation().runOnMainSync(() -> {
            try {
                var history = (java.util.TreeMap<Long, JSONObject>) field("history");
                assertFalse(history.containsKey(99L));
                assertEquals("Recovered transcript", history.get(2L).optString("text"));
                assertEquals(2, eventCalls.get());
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    private void awaitConnected() throws Exception {
        var connected = new java.util.concurrent.atomic.AtomicBoolean();
        long deadline = android.os.SystemClock.elapsedRealtime() + 3000;
        do {
            getInstrumentation().runOnMainSync(() -> {
                try { connected.set((boolean) field("connected")); } catch (Exception error) { throw new AssertionError(error); }
            });
            if (!connected.get()) android.os.SystemClock.sleep(20);
        } while (!connected.get() && android.os.SystemClock.elapsedRealtime() < deadline);
        assertTrue("A fresh transcript should finish recovery", connected.get());
    }

    public void testInitialSnapshotTimeoutRestartsWithoutWaitingForTheOldSocket() throws Exception { stalledStream(false); }
    public void testLostHeartbeatRestartsAndRejectsLateFrames() throws Exception { stalledStream(true); }

    public void testLatePostedOldRefreshCannotConsumeTheReplacementSnapshot() throws Exception {
        var error = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> {
            android.os.Handler previous = null;
            try {
                field("foreground", false);
                field("credentials", new JSONObject().put("address", address).put("token", token));
                String id = "00000000-0000-0000-0000-000000000001";
                field("conversationId", id); call("detailScreen"); field("foreground", true);
                var callbacks = new java.util.ArrayList<Runnable>();
                previous = (android.os.Handler) field("handler");
                field("handler", new android.os.Handler(android.os.Looper.getMainLooper()) {
                    @Override public boolean sendMessageAtTime(android.os.Message message, long at) {
                        if (message.getCallback() == null) return super.sendMessageAtTime(message, at);
                        callbacks.add(message.getCallback()); return true;
                    }
                });
                var queue = MainActivity.class.getDeclaredMethod("queueSnapshot", int.class, JSONObject.class); queue.setAccessible(true);
                JSONObject snapshot = new JSONObject().put("instanceId", "server").put("cursor", 1).put("permission", "control")
                    .put("conversation", new JSONObject().put("id", id).put("seq", 1))
                    .put("messages", new JSONArray().put(new JSONObject().put("seq", 1).put("role", "assistant").put("text", "Replacement transcript")));
                queue.invoke(activity, (int) field("generation"), snapshot);
                Runnable oldRefresh = callbacks.get(callbacks.size() - 1);
                call("stopNetwork");
                queue.invoke(activity, (int) field("generation"), snapshot);
                Runnable currentRefresh = callbacks.get(callbacks.size() - 1);
                // A post racing with stopNetwork can arrive after its callback
                // cleanup. Run that old callback before the new one.
                oldRefresh.run(); currentRefresh.run();
                assertTrue("The old callback must not discard the replacement's initial snapshot", (boolean) field("connected"));
                assertEquals("Replacement transcript", ((java.util.TreeMap<Long, JSONObject>) field("history")).get(1L).optString("text"));
            } catch (Throwable failure) { error.set(failure); }
            finally {
                if (previous != null) try { field("handler", previous); } catch (Exception failure) { error.set(failure); }
            }
        });
        if (error.get() != null) throw new AssertionError(error.get());
    }
}
