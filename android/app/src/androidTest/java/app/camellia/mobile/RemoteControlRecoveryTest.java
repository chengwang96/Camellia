package app.camellia.mobile;

import android.os.SystemClock;
import android.view.View;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.*;
import tailnet.Node;

public class RemoteControlRecoveryTest extends RemoteFeedbackTest {
    private static final String ID = "12345678-1234-1234-1234-123456789abc";
    interface Checked { void run() throws Exception; }
    private MainActivity activity() throws Exception { var f = RemoteFeedbackTest.class.getDeclaredField("activity"); f.setAccessible(true); return (MainActivity) f.get(this); }
    private Object get(String name) throws Exception { var f = MainActivity.class.getDeclaredField(name); f.setAccessible(true); return f.get(activity()); }
    private void set(String name, Object value) throws Exception { var f = MainActivity.class.getDeclaredField(name); f.setAccessible(true); f.set(activity(), value); }
    private void call(String name, Class<?>[] types, Object... args) throws Exception { var m = MainActivity.class.getDeclaredMethod(name, types); m.setAccessible(true); m.invoke(activity(), args); }
    private void ui(Checked action) { var error = new java.util.concurrent.atomic.AtomicReference<Throwable>(); getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable e) { error.set(e); } }); if (error.get() != null) throw new AssertionError(error.get()); }
    private void waitUntil(java.util.function.BooleanSupplier check) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 5000;
        while (!check.getAsBoolean() && SystemClock.elapsedRealtime() < deadline) { getInstrumentation().waitForIdleSync(); Thread.sleep(20); }
        assertTrue(check.getAsBoolean()); getInstrumentation().waitForIdleSync();
    }
    private JSONObject pending(String action, String target, boolean stop) throws Exception {
        JSONObject payload = new JSONObject().put("action", action).put("instanceId", "server").put("requestId", java.util.UUID.randomUUID().toString());
        RemotePendingCommands.put((JSONObject) get("credentials"), new JSONObject().put("conversationId", target).put("payload", payload), stop);
        return payload;
    }
    public void testConfigureReceiptUpdatesSettingsBeforeTheNextSelection() throws Exception {
        ui(() -> {
            set("remoteSettings", new JSONObject().put("version", "old").put("model", "old-model").put("editable", true));
            JSONObject payload = pending("configure", ID, false).put("expectedSettings", "old");
            JSONObject updated = new JSONObject().put("version", "new").put("model", "new-model").put("editable", true);
            call("finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, payload, new JSONObject().put("ok", true).put("settings", updated));
            assertEquals("new", ((JSONObject) get("remoteSettings")).getString("version"));
            assertTrue(((View) get("modelButton")).isEnabled());
        });
    }
    public void testAnotherConversationsPendingRequestDoesNotLockThisConversation() throws Exception {
        ui(() -> {
            pending("send", "00000000-0000-0000-0000-000000000001", false);
            set("lastLive", new JSONObject().put("runId", 7)); set("canQueue", true);
            ((EditText) get("composer")).setText("next message"); call("updateControls", new Class<?>[0]);
            assertTrue(((View) get("sendButton")).isEnabled()); assertTrue(((View) get("stopButton")).isEnabled());
            assertTrue(((View) get("composer")).isEnabled());
        });
    }
    public void testStopRemainsAvailableWhileSendIsAwaitingConfirmation() throws Exception {
        ui(() -> {
            pending("send", ID, false); set("commandBusy", true); set("lastLive", new JSONObject().put("runId", 7));
            call("updateControls", new Class<?>[0]); assertTrue(((View) get("stopButton")).isEnabled());
            assertFalse(((View) get("sendButton")).isEnabled());
        });
    }
    public void testStopReceiptClearsOnlyItsOwnSlotAndDoesNotExposeTheOldRun() throws Exception {
        ui(() -> {
            JSONObject send = pending("send", ID, false);
            JSONObject stop = pending("stop", ID, true).put("runId", 7);
            set("lastLive", new JSONObject().put("runId", 7));
            call("finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, stop, new JSONObject().put("ok", true));
            assertNull(get("lastLive")); assertFalse(((View) get("stopButton")).isEnabled());
            assertNotNull(RemotePendingCommands.find((JSONObject) get("credentials"), send.optString("requestId")));
            assertNull(RemotePendingCommands.find((JSONObject) get("credentials"), stop.optString("requestId")));
        });
    }
    public void testOldStopReceiptDoesNotClearANewerRun() throws Exception {
        ui(() -> {
            JSONObject stop = pending("stop", ID, true).put("runId", 7); set("lastLive", new JSONObject().put("runId", 8));
            call("finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, stop, new JSONObject().put("ok", true));
            assertEquals(8, ((JSONObject) get("lastLive")).getLong("runId"));
        });
    }
    public void testLateReceiptFromTheRetiredHostCannotReplaceTheCurrentRunOrPermission() throws Exception {
        ui(() -> {
            JSONObject stop = pending("stop", ID, true).put("runId", 7); set("instance", "new-host"); set("cursor", 8L);
            set("lastLive", new JSONObject().put("runId", 7)); set("conversationSeq", 20L);
            JSONObject stale = new JSONObject().put("instanceId", "server").put("cursor", 99).put("permission", "read")
                .put("conversation", new JSONObject().put("id", ID).put("seq", 9));
            call("finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, stop, new JSONObject().put("ok", true).put("current", stale));
            assertEquals("new-host", get("instance")); assertTrue((boolean) get("controlAllowed"));
            assertEquals(7, ((JSONObject) get("lastLive")).getLong("runId")); assertEquals(20, (long) get("conversationSeq"));
        });
    }
    public void testResolvingAnUnconfirmedStopPreservesTheSeparatePendingSend() throws Exception {
        ui(() -> {
            JSONObject send = pending("send", ID, false), stop = pending("stop", ID, true);
            JSONObject outgoing = RemotePendingCommands.find((JSONObject) get("credentials"), send.optString("requestId"));
            set("outgoingMessage", outgoing); set("commandBusy", true);
            call("resolvePendingCommand", new Class<?>[]{String.class}, stop.optString("requestId"));
            assertSame(outgoing, get("outgoingMessage")); assertTrue((boolean) get("commandBusy"));
            assertNotNull(RemotePendingCommands.find((JSONObject) get("credentials"), send.optString("requestId")));
            assertNull(RemotePendingCommands.find((JSONObject) get("credentials"), stop.optString("requestId")));
        });
    }
    public void testUnknownCanBeExplicitlyResolvedWithoutResending() throws Exception {
        ui(() -> {
            JSONObject payload = pending("send", ID, false);
            call("finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, payload, new JSONObject().put("state", "unknown"));
            assertNotNull(RemotePendingCommands.find((JSONObject) get("credentials"), payload.optString("requestId")));
            call("resolvePendingCommand", new Class<?>[]{String.class}, payload.optString("requestId"));
            assertNull(RemotePendingCommands.find((JSONObject) get("credentials"), payload.optString("requestId")));
            assertTrue(((EditText) get("composer")).isEnabled());
        });
    }
    public void testFullSnapshotSurvivesCoalescingWithTheFollowingDelta() throws Exception {
        ui(() -> {
            JSONObject full = new JSONObject().put("instanceId", "server").put("cursor", 2).put("historyVersion", "one").put("permission", "control")
                .put("conversation", new JSONObject().put("id", ID).put("seq", 11)).put("messages", new JSONArray().put(new JSONObject().put("seq", 11).put("role", "user").put("text", "coalesced history")));
            JSONObject delta = new JSONObject(full.toString()); delta.remove("messages"); delta.put("cursor", 3);
            call("queueSnapshot", new Class<?>[]{int.class, JSONObject.class}, (int) get("generation"), full);
            call("queueSnapshot", new Class<?>[]{int.class, JSONObject.class}, (int) get("generation"), delta);
        });
        var applied = new java.util.concurrent.atomic.AtomicBoolean();
        waitUntil(() -> { ui(() -> applied.set(((java.util.Map<?, ?>) get("history")).size() == 1 && (long) get("cursor") == 3)); return applied.get(); });
        ui(() -> { assertEquals(1, ((java.util.Map<?, ?>) get("history")).size()); assertEquals(3, (long) get("cursor")); });
    }
    public void testStaleSnapshotCannotChangeTheCurrentPermissionOrSequence() throws Exception {
        ui(() -> {
            set("instance", "server"); set("cursor", 10L); set("conversationSeq", 20L); set("controlAllowed", true);
            JSONObject stale = new JSONObject().put("instanceId", "server").put("cursor", 9).put("permission", "read")
                .put("conversation", new JSONObject().put("id", ID).put("seq", 19));
            call("applySnapshot", new Class<?>[]{JSONObject.class}, stale);
            assertTrue((boolean) get("controlAllowed")); assertEquals(20, (long) get("conversationSeq"));
        });
    }
    public void testStateOnlyReceiptAcrossRestartPreservesHistoryUntilTheReplacementArrives() throws Exception {
        ui(() -> {
            JSONObject full = new JSONObject().put("instanceId", "before").put("cursor", 2).put("permission", "control").put("nextBefore", JSONObject.NULL)
                .put("conversation", new JSONObject().put("id", ID).put("seq", 1)).put("messages", new JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("text", "earlier history")));
            call("applySnapshot", new Class<?>[]{JSONObject.class}, full);
            JSONObject state = new JSONObject(full.toString()).put("instanceId", "after").put("cursor", 1); state.remove("messages");
            call("applySnapshot", new Class<?>[]{JSONObject.class}, state);
            assertEquals(1, ((java.util.Map<?, ?>) get("history")).size()); assertTrue(((java.util.Map<?, ?>) get("history")).containsKey(1L));
            state.put("messages", new JSONArray().put(new JSONObject().put("seq", 2).put("role", "user").put("text", "replacement history")));
            call("applySnapshot", new Class<?>[]{JSONObject.class}, state);
            assertEquals(1, ((java.util.Map<?, ?>) get("history")).size()); assertFalse(((java.util.Map<?, ?>) get("history")).containsKey(1L));
        });
    }
    public void testReceiptQueryHasNoOriginalMessageOrAttachmentBody() throws Exception {
        CountDownLatch queried = new CountDownLatch(1);
        RemoteApi fake = new RemoteApi("http://100.64.0.1:43128") {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                if (!path.startsWith("/v1/commands/") || payload != null) throw new AssertionError("Receipt uploaded the command again");
                queried.countDown(); try { return new JSONObject().put("ok", true); } catch (Exception error) { throw new IOException(error); }
            }
        };
        ui(() -> {
            JSONObject payload = pending("send", ID, false).put("prompt", "one message").put("image", "attachment bytes");
            RemotePendingCommands.find((JSONObject) get("credentials"), payload.optString("requestId")).put("dispatched", true);
            set("canCommandReceipts", true); set("api", fake); call("retryCommand", new Class<?>[]{boolean.class}, false);
        });
        assertTrue(queried.await(3, TimeUnit.SECONDS));
    }
    public void testPendingTimeoutKeepsAnExplicitlyResolvableRecord() throws Exception {
        ui(() -> {
            JSONObject payload = pending("send", ID, false); ((ComputerStore) get("store")).save((JSONObject) get("credentials"));
            set("commandCheckDeadline", SystemClock.elapsedRealtime() - 1);
            call("finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, payload, new JSONObject().put("state", "pending"));
            assertTrue(RemotePendingCommands.find((JSONObject) get("credentials"), payload.optString("requestId")).optBoolean("uncertain"));
            set("connected", false); call("resolvePendingCommand", new Class<?>[]{String.class}, payload.optString("requestId"));
            assertNull(RemotePendingCommands.find((JSONObject) get("credentials"), payload.optString("requestId")));
        });
    }
    public void testListPendingOperationAutomaticallyQueriesWithoutReplacingTheEventClient() throws Exception {
        CountDownLatch queried = new CountDownLatch(1); java.util.concurrent.atomic.AtomicInteger uploads = new java.util.concurrent.atomic.AtomicInteger();
        RemoteApi fake = new RemoteApi("http://100.64.0.1:43128") {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                if (payload == null) { if (!path.startsWith("/v1/commands/")) throw new AssertionError(path); queried.countDown(); }
                else { if (!path.equals("/v1/commands")) throw new AssertionError(path); uploads.incrementAndGet(); }
                try { return new JSONObject().put("state", "pending"); } catch (Exception error) { throw new IOException(error); }
            }
        };
        final int[] ticket = {0};
        ui(() -> {
            call("listScreen", new Class<?>[0]); set("api", fake); set("canCommandReceipts", true); set("connected", true);
            JSONObject saved = (JSONObject) get("credentials"); saved.put("pendingCreate", new JSONObject().put("requestId", java.util.UUID.randomUUID().toString()).put("instanceId", "server").put("action", "rename"));
            ((ComputerStore) get("store")).save(saved); ticket[0] = (int) get("generation"); call("retryCreate", new Class<?>[]{boolean.class}, true);
        });
        assertTrue(queried.await(4, TimeUnit.SECONDS));
        ui(() -> { assertEquals(ticket[0], (int) get("generation")); assertSame(fake, get("api")); assertTrue(((JSONObject) get("credentials")).has("pendingCreate")); });
        assertEquals(1, uploads.get());
    }
    public void testLateReceiptCannotReviveRemovedOrRepairedCredentials() throws Exception {
        ui(() -> {
            for (boolean repaired : new boolean[]{false, true}) {
                JSONObject saved = (JSONObject) get("credentials"); JSONObject payload = pending("send", ID, false);
                ComputerStore store = (ComputerStore) get("store"); store.save(saved); JSONObject owner = new JSONObject(saved.toString());
                store.remove(owner.getString("address"));
                if (repaired) store.save(new JSONObject().put("address", owner.getString("address")).put("token", "b".repeat(43)));
                call("receiveCommand", new Class<?>[]{JSONObject.class, JSONObject.class, JSONObject.class}, owner, payload, new JSONObject().put("ok", true));
                if (repaired) { assertEquals("b".repeat(43), store.load().optString("token")); assertFalse(store.load().has("pendingCommand")); }
                else assertTrue(store.all().isEmpty());
            }
        });
    }
    public void testLateReceiptSettlesOnlyItsOwningComputer() throws Exception {
        ui(() -> {
            JSONObject payload = pending("send", ID, false); ComputerStore store = (ComputerStore) get("store");
            JSONObject owner = new JSONObject(((JSONObject) get("credentials")).toString()); store.save(owner);
            JSONObject other = new JSONObject().put("address", "http://100.64.0.2:43128").put("token", "b".repeat(43));
            store.save(other); set("credentials", other);
            call("receiveCommand", new Class<?>[]{JSONObject.class, JSONObject.class, JSONObject.class}, owner, payload, new JSONObject().put("ok", true));
            assertEquals(other.getString("address"), store.load().getString("address")); assertSame(other, get("credentials"));
            for (JSONObject profile : store.all()) if (profile.optString("address").equals(owner.optString("address"))) assertNull(RemotePendingCommands.find(profile, payload.optString("requestId")));
        });
    }
    public void testBurstOfListEventsUsesOneBoundedRefresh() throws Exception {
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger(); CountDownLatch read = new CountDownLatch(1);
        RemoteApi fake = new RemoteApi("http://100.64.0.1:43128") {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                if (!path.startsWith("/v1/conversations?offset=0&limit=1000&query=")) throw new AssertionError(path);
                calls.incrementAndGet(); read.countDown();
                try { return new JSONObject().put("protocol", 1).put("permission", "control").put("capabilities", new JSONArray().put("list-query"))
                    .put("cursor", 50).put("query", "").put("conversations", new JSONArray()).put("nextOffset", JSONObject.NULL); }
                catch (Exception error) { throw new IOException(error); }
            }
        };
        ui(() -> {
            call("listScreen", new Class<?>[0]); set("api", fake); set("canListQuery", true); set("capabilityAddress", ((JSONObject) get("credentials")).optString("address"));
            @SuppressWarnings("unchecked") java.util.Map<String, JSONObject> entries = (java.util.Map<String, JSONObject>) get("conversations");
            for (int i = 0; i < 1000; i++) entries.put("row" + i, new JSONObject());
            for (int i = 0; i < 40; i++) call("scheduleListRefresh", new Class<?>[]{RemoteApi.class, int.class, JSONObject.class}, fake, (int) get("generation"), new JSONObject().put("cursor", i));
        });
        assertTrue(read.await(3, TimeUnit.SECONDS)); var settled = new java.util.concurrent.atomic.AtomicBoolean();
        waitUntil(() -> { ui(() -> settled.set(!(boolean) get("listRefreshBusy"))); return settled.get(); });
        assertEquals(1, calls.get()); ui(() -> assertEquals(50, (long) get("listCursor")));
    }
    public void testCancelledStatusCallsReleaseWorkersWhileInitializationContinues() throws Exception {
        var f = EmbeddedNetwork.class.getDeclaredField("lifecycle"); f.setAccessible(true);
        var routeField = EmbeddedNetwork.class.getDeclaredField("route"); routeField.setAccessible(true);
        NetworkLifecycle<?> original = (NetworkLifecycle<?>) f.get(null); original.close().get(5, TimeUnit.SECONDS);
        var executor = Executors.newSingleThreadExecutor(); var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
        NetworkLifecycle<Node> fixture = new NetworkLifecycle<>(new NetworkLifecycle.Backend<Node>() {
            public Node create() throws Exception { entered.countDown(); release.await(10, TimeUnit.SECONDS); throw new IOException("Fixture released"); }
            public void close(Node node) { } public void saveMode(boolean enabled) { } public void forget() { }
        }, executor, SystemClock::elapsedRealtime, () -> { try { return ((NetworkRoute) routeField.get(null)).revision(); } catch (Exception error) { throw new AssertionError(error); } }, true);
        try {
            ui(() -> { f.set(null, fixture); EmbeddedNetwork.foreground(); call("connectEvents", new Class<?>[0]); }); assertTrue(entered.await(3, TimeUnit.SECONDS));
            ui(() -> call("connectEvents", new Class<?>[0])); ui(() -> call("connectEvents", new Class<?>[0]));
            Thread.sleep(500);
            ThreadPoolExecutor worker = (ThreadPoolExecutor) get("worker");
            assertNotNull(get("job")); assertTrue(worker.getActiveCount() <= 1); assertEquals(0, worker.getQueue().size());
        } finally {
            ui(() -> { call("stopNetwork", new Class<?>[0]); set("foreground", false); }); release.countDown(); fixture.close().get(5, TimeUnit.SECONDS);
            ui(() -> f.set(null, original)); executor.shutdownNow();
        }
    }
}
