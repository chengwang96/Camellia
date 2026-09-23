package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class RemoteConnectionTest extends InstrumentationTestCase {
    public void testPreloadedMessagesRenderWithoutGrantingControlOrMarkingRead() throws Exception {
        ui(() -> {
            String id = "00000000-0000-0000-0000-000000000001";
            JSONObject owner = new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43));
            var cacheField = MainActivity.class.getDeclaredField("prefetch"); cacheField.setAccessible(true);
            RemotePrefetch cache = (RemotePrefetch) cacheField.get(activity);
            cache.put(owner, new JSONObject().put("permission", "control")
                .put("conversation", new JSONObject().put("id", id).put("seq", 2))
                .put("messages", new org.json.JSONArray().put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", "preloaded text"))));
            field("credentials", owner); field("conversationId", id); invoke("detailScreen");
            for (String name : new String[]{"connected", "controlAllowed"}) {
                var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); assertFalse(member.getBoolean(activity));
            }
            var historyField = MainActivity.class.getDeclaredField("history"); historyField.setAccessible(true);
            assertEquals(1, ((java.util.Map<?, ?>) historyField.get(activity)).size());
            var send = MainActivity.class.getDeclaredField("sendButton"); send.setAccessible(true);
            assertFalse(((android.view.View) send.get(activity)).isEnabled());
            var status = MainActivity.class.getDeclaredField("status"); status.setAccessible(true);
            String text = ((android.widget.TextView) status.get(activity)).getText().toString();
            assertTrue(text.contains("预加载") || text.contains("preloaded"));
        });
    }

    public void testHttpErrorsAndNativeLoginRemainDistinct() {
        for (int code : new int[] {401, 403, 404, 409, 429, 500, 502, 503, 504}) {
            assertTrue(RemoteApi.failureMessage(new RemoteApi.Failure(code), true).contains("[HTTP " + code + "]"));
            assertTrue(RemoteApi.failureMessage(new RemoteApi.Failure(code), false).contains("[HTTP " + code + "]"));
        }
        assertEquals(ConnectionFailure.Code.LOGIN_REQUIRED, ConnectionFailure.classify(
            new IOException("Embedded connection failed", new Exception("CAMELLIA_LOGIN_REQUIRED")), true));
    }

    public void testDesktopFailureBodyIsPreservedAndRedacted() {
        RemoteApi.Failure failure = new RemoteApi.Failure(500, RemoteApi.clean(
            "{\"error\":\"upstream overloaded\",\"authorization\":\"Bearer PRIVATE_TOKEN\"}"));
        String english = RemoteApi.failureMessage(failure, false);
        assertTrue(english.contains("[HTTP 500]"));
        assertTrue(english.contains("upstream overloaded"));
        assertFalse(english.contains("PRIVATE_TOKEN"));
        assertFalse(english.contains("Bearer PRIVATE_TOKEN"));
    }

    public void testLoginFailurePreservesPairingAndOffersFullDetails() throws Exception {
        var routeField = EmbeddedNetwork.class.getDeclaredField("route"); routeField.setAccessible(true);
        Object originalRoute = routeField.get(null);
        JSONObject credential = new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43));
        try {
            ui(() -> {
                routeField.set(null, new NetworkRoute("online", "links"));
                field("credentials", credential);
                var method = MainActivity.class.getDeclaredMethod("showFailure", Exception.class, boolean.class);
                method.setAccessible(true);
                method.invoke(activity, new IOException("Embedded connection failed", new Exception("CAMELLIA_LOGIN_REQUIRED")), true);
                assertTrue(credential.has("token"));
                var statusField = MainActivity.class.getDeclaredField("status"); statusField.setAccessible(true);
                var status = (android.widget.TextView) statusField.get(activity);
                assertTrue(status.getText().toString().contains("[LOGIN_REQUIRED]"));
                assertTrue(status.hasOnClickListeners());
                status.performClick();
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        } finally {
            ui(() -> routeField.set(null, originalRoute));
        }
    }

    private MainActivity activity;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> invoke("stopNetwork"));
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> activity.finish());
        getInstrumentation().waitForIdleSync();
        super.tearDown();
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
    }

    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }

    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }

    public void testCombinedListMetadataAndLegacyFallback() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        JSONObject info = new JSONObject().put("protocol", 1);
        RemoteApi client = new RemoteApi("http://100.64.0.1:43128") {
            @Override public JSONObject json(String path, String token, JSONObject payload) {
                assertEquals("/v1/status", path); requests.incrementAndGet(); return info;
            }
        };
        var method = MainActivity.class.getDeclaredMethod("listInfo", RemoteApi.class, String.class, JSONObject.class);
        method.setAccessible(true);
        assertSame(info, method.invoke(activity, client, "", info));
        assertEquals(0, requests.get());
        assertSame(info, method.invoke(activity, client, "", new JSONObject()));
        assertEquals(1, requests.get());
        try { method.invoke(activity, client, "", new JSONObject().put("protocol", 2)); fail("Unknown protocol accepted"); }
        catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IOException); }
    }

    public void testMatchingInitialSnapshotSkipsRefreshButChangesDoNot() throws Exception {
        verifySnapshot(7, "server", 0);
        verifySnapshot(8, "server", 1);
        verifySnapshot(7, "restarted", 1);
    }

    private void verifySnapshot(long cursor, String instance, int expectedRequests) throws Exception {
        CountDownLatch handled = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger requests = new AtomicInteger();
        JSONObject snapshot = new JSONObject().put("cursor", cursor).put("instanceId", instance);
        RemoteApi client = new RemoteApi("http://100.64.0.1:43128") {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                requests.incrementAndGet();
                try { return new JSONObject().put("protocol", 1).put("instanceId", instance).put("cursor", cursor); }
                catch (Exception error) { throw new IOException(error); }
            }
            @Override public void listEvents(String token, SnapshotListener listener) throws IOException {
                try {
                    listener.onSnapshot(snapshot); handled.countDown(); release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
        };
        try {
            ui(() -> {
                invoke("stopNetwork");
                field("credentials", new JSONObject().put("address", "http://100.64.0.1:43128"));
                invoke("listScreen");
                field("foreground", true); field("listCursor", 7L); field("listInstance", "server");
                var generation = MainActivity.class.getDeclaredField("generation"); generation.setAccessible(true);
                var method = MainActivity.class.getDeclaredMethod("streamList", RemoteApi.class, int.class, int.class);
                method.setAccessible(true); method.invoke(activity, client, generation.getInt(activity), 0);
            });
            assertTrue("Snapshot not handled", handled.await(3, TimeUnit.SECONDS));
            assertEquals(expectedRequests, requests.get());
        } finally {
            ui(() -> invoke("stopNetwork")); release.countDown();
        }
    }

    public void testBackgroundGraceAndForegroundCancellation() throws Exception {
        var deadline = EmbeddedNetwork.class.getDeclaredField("backgroundDeadline"); deadline.setAccessible(true);
        ui(() -> {
            EmbeddedNetwork.background();
            long remaining = deadline.getLong(null) - android.os.SystemClock.elapsedRealtime();
            assertTrue(remaining > 290_000 && remaining <= 300_000);
            EmbeddedNetwork.foreground();
            assertEquals(0L, deadline.getLong(null));
        });
    }

    public void testOfflineRouteRetainsPendingCommandWithoutSending() throws Exception {
        var routeField = EmbeddedNetwork.class.getDeclaredField("route"); routeField.setAccessible(true);
        Object originalRoute = routeField.get(null);
        JSONObject pending = new JSONObject().put("requestId", "same-request").put("action", "send");
        JSONObject credential = new JSONObject().put("pendingCommand", pending);
        try {
            ui(() -> {
                routeField.set(null, new NetworkRoute(null, null));
                field("screen", "list"); field("foreground", true); field("credentials", credential);
                invoke("networkRouteChanged");
                assertSame(pending, credential.getJSONObject("pendingCommand"));
                var connected = MainActivity.class.getDeclaredField("connected"); connected.setAccessible(true);
                assertFalse(connected.getBoolean(activity));
                var status = MainActivity.class.getDeclaredField("status"); status.setAccessible(true);
                String text = ((android.widget.TextView) status.get(activity)).getText().toString();
                assertTrue(text.contains("Offline") || text.contains("网络已断开"));
            });
        } finally {
            ui(() -> routeField.set(null, originalRoute));
        }
    }
}
