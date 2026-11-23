package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteKeepAliveTest extends InstrumentationTestCase {
    private MainActivity activity;
    private CredentialStore credentials;
    private JSONObject saved;
    private String preference;
    private boolean embedded;

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }
    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private long deadline() throws Exception {
        var member = RemoteKeepAliveService.class.getDeclaredField("deadline"); member.setAccessible(true); return member.getLong(null);
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            boolean notificationsGranted = context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (!notificationsGranted) getInstrumentation().getUiAutomation()
                .grantRuntimePermission(context.getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
        }
        credentials = new CredentialStore(context); saved = credentials.load(); credentials.save(new JSONObject());
        preference = MobilePreferences.get(context, "remoteKeepAlive");
        MobilePreferences.set(context, "remoteKeepAlive", "disabled");
        EmbeddedNetwork.initialize(context); embedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        var markers = context.getSharedPreferences("keep-alive-read-test", 0);
        markers.edit().clear().commit();
        ui(() -> field("replyState", new RemoteReplyState(markers)));
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> { RemoteKeepAliveService.finish(activity, false); activity.finish(); });
        getInstrumentation().waitForIdleSync();
        credentials.save(saved);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "remoteKeepAlive", preference);
        EmbeddedNetwork.setEnabled(embedded);
        super.tearDown();
    }

    private void prepareRemote() throws Exception {
        JSONObject owner = new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43));
        credentials.save(owner);
        MobilePreferences.set(activity, "remoteKeepAlive", "enabled");
        field("credentials", owner); field("conversationId", "keep-alive-test"); invoke("detailScreen");
        field("api", new RemoteApi(owner.getString("address")));
        field("connected", true);
        long now = android.os.SystemClock.elapsedRealtime();
        RemoteStreamHealth health = new RemoteStreamHealth(now);
        health.snapshot(now);
        field("streamHealth", health);
    }

    private void prepareList() throws Exception {
        JSONObject owner = new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43));
        credentials.save(owner);
        MobilePreferences.set(activity, "remoteKeepAlive", "enabled");
        field("credentials", owner); invoke("listScreen");
        field("api", new RemoteApi(owner.getString("address")));
        field("connected", true);
        field("listLastFrameAt", android.os.SystemClock.elapsedRealtime());
    }

    private void useUnavailableClient() throws Exception {
        field("remoteClientFactory", (java.util.function.Function<String, RemoteApi>) address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                try {
                    return new JSONObject().put("protocol", 1).put("permission", "control")
                        .put("conversations", new JSONArray()).put("nextOffset", JSONObject.NULL);
                } catch (org.json.JSONException error) { throw new java.io.IOException(error); }
            }
            @Override void events(String id, String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                throw new java.io.IOException("Test stream unavailable");
            }
            @Override public void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                throw new java.io.IOException("Test stream unavailable");
            }
        });
    }

    public void testNoComputerOrDisabledSettingNeverStarts() {
        ui(() -> {
            assertFalse(RemoteKeepAliveService.eligible(activity));
            MobilePreferences.set(activity, "remoteKeepAlive", "enabled");
            assertFalse(RemoteKeepAliveService.begin(activity, () -> fail("No session should be started")));
            assertFalse(RemoteKeepAliveService.active());
            credentials.save(new JSONObject().put("address", "http://100.64.0.1:43128").put("deviceId", "pending"));
            assertFalse(RemoteKeepAliveService.eligible(activity));
            prepareRemote();
            MobilePreferences.set(activity, "remoteKeepAlive", "disabled");
            invoke("onPause"); invoke("onStop");
            assertFalse(RemoteKeepAliveService.active());
            assertNull(field("api"));
        });
    }

    public void testConnectionSurvivesBackgroundAndReturnsWithoutReconnect() {
        ui(() -> {
            prepareRemote();
            Object client = field("api"); int generation = (int) field("generation");
            invoke("onPause"); invoke("onStop");
            assertTrue(RemoteKeepAliveService.active());
            assertSame(client, field("api"));
            assertEquals(generation, field("generation"));
            long remaining = deadline() - android.os.SystemClock.elapsedRealtime();
            assertTrue(remaining > 1_790_000 && remaining <= 1_800_000);
            long initial = deadline();
            assertTrue(RemoteKeepAliveService.begin(activity, () -> fail("Should not replace session")));
            assertEquals(initial, deadline());
            JSONObject conversation = new JSONObject().put("id", "keep-alive-test").put("seq", 2).put("lastReplyAt", 987654);
            JSONObject snapshot = new JSONObject().put("conversation", conversation).put("instanceId", "test").put("cursor", 1)
                .put("messages", new JSONArray().put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", "Background reply")));
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true); apply.invoke(activity, snapshot);
            var replies = MainActivity.class.getDeclaredMethod("replies"); replies.setAccessible(true);
            RemoteReplyState read = (RemoteReplyState) replies.invoke(activity);
            assertTrue(read.unread((JSONObject) field("credentials"), conversation));
            invoke("onStart");
            assertFalse(RemoteKeepAliveService.active());
            assertSame(client, field("api"));
            assertEquals(generation, field("generation"));
            assertFalse(read.unread((JSONObject) field("credentials"), conversation));
        });
    }

    public void testPendingRetryIsBypassedWhenReturningToDetail() throws Exception {
        ui(() -> {
            prepareRemote();
            Object previous = field("api");
            field("streamHealth", null); field("streamRetryPending", true);
            useUnavailableClient();
            invoke("onPause"); invoke("onStop"); invoke("onStart");
            assertNotSame("Foreground recovery must not wait for the old retry timer", previous, field("api"));
            assertFalse((boolean) field("connected"));
            RemoteStreamHealth recovery = (RemoteStreamHealth) field("streamHealth");
            long remaining = recovery.remaining(android.os.SystemClock.elapsedRealtime());
            assertTrue(remaining > 0 && remaining <= RemoteStreamHealth.RECOVERY_INITIAL_TIMEOUT_MS);
        });
    }

    public void testForegroundGraceReplacesStaleStreamBeforeIdleTimeout() throws Exception {
        ui(() -> {
            prepareRemote();
            Object previous = field("api");
            long now = android.os.SystemClock.elapsedRealtime();
            RemoteStreamHealth stale = new RemoteStreamHealth(now - 6_000);
            stale.snapshot(now - 5_001);
            assertTrue(stale.remaining(now) > 0);
            field("streamHealth", stale); useUnavailableClient();
            invoke("onPause"); invoke("onStop"); invoke("onStart");
            assertNotSame("The five-second foreground grace must not wait for the idle timeout", previous, field("api"));
        });
    }

    public void testRetainedDetailKeepsItsVisibleHistoryDuringRecovery() throws Exception {
        ui(() -> {
            prepareRemote();
            JSONObject conversation = new JSONObject().put("id", "keep-alive-test").put("seq", 2);
            JSONObject snapshot = new JSONObject().put("conversation", conversation).put("instanceId", "test").put("cursor", 1)
                .put("messages", new JSONArray().put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", "Visible history")));
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true); apply.invoke(activity, snapshot);
            Object previous = field("api"), currentScroll = field("scroll"), currentMessages = field("messages");
            long now = android.os.SystemClock.elapsedRealtime();
            RemoteStreamHealth stale = new RemoteStreamHealth(now - 6_000); stale.snapshot(now - 5_001);
            field("streamHealth", stale); useUnavailableClient();
            invoke("onPause"); invoke("onStop"); invoke("onStart");
            assertNotSame(previous, field("api"));
            assertSame("Recovery must not rebuild the chat viewport", currentScroll, field("scroll"));
            assertSame("Recovery must not rebuild the message container", currentMessages, field("messages"));
            var history = (java.util.TreeMap<Long, JSONObject>) field("history");
            assertEquals("Visible history", history.get(2L).optString("text"));
        });
    }

    public void testEmptyRetainedHistoryUsesPrefetchBeforeFreshSnapshot() throws Exception {
        ui(() -> {
            prepareRemote();
            JSONObject conversation = new JSONObject().put("id", "keep-alive-test").put("seq", 3);
            JSONObject snapshot = new JSONObject().put("conversation", conversation).put("instanceId", "test").put("cursor", 1)
                .put("messages", new JSONArray().put(new JSONObject().put("seq", 3).put("role", "assistant").put("text", "Prefetched history")));
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true); apply.invoke(activity, snapshot);
            invoke("clearHistory");
            assertTrue(((java.util.TreeMap<Long, JSONObject>) field("history")).isEmpty());
            long now = android.os.SystemClock.elapsedRealtime();
            RemoteStreamHealth stale = new RemoteStreamHealth(now - 6_000); stale.snapshot(now - 5_001);
            field("streamHealth", stale); useUnavailableClient();
            invoke("onPause"); invoke("onStop"); invoke("onStart");
            var history = (java.util.TreeMap<Long, JSONObject>) field("history");
            assertEquals("Prefetched history", history.get(3L).optString("text"));
        });
    }

    public void testFreshListConnectionSurvivesBackgroundWithoutReload() throws Exception {
        ui(() -> {
            prepareList();
            Object previous = field("api"); int generation = (int) field("generation");
            invoke("onPause"); invoke("onStop"); invoke("onStart");
            assertSame(previous, field("api"));
            assertEquals(generation, field("generation"));
        });
    }

    private void assertListReconnects(boolean retryPending) throws Exception {
        ui(() -> {
            prepareList();
            Object previous = field("api");
            if (retryPending) field("listRetryPending", true);
            else field("listLastFrameAt", android.os.SystemClock.elapsedRealtime() - 5_001);
            useUnavailableClient();
            invoke("onPause"); invoke("onStop"); invoke("onStart");
            assertNotSame("A stale list must refresh immediately with a new client", previous, field("api"));
        });
    }

    public void testListRetryIsBypassedWhenReturning() throws Exception { assertListReconnects(true); }
    public void testStaleListRefreshesWhenReturning() throws Exception { assertListReconnects(false); }

    public void testExpiryDisconnectsAndCannotRenewInBackground() {
        ui(() -> {
            prepareRemote(); invoke("onPause"); invoke("onStop");
            assertTrue(RemoteKeepAliveService.active());
            var expire = RemoteKeepAliveService.class.getDeclaredField("expire"); expire.setAccessible(true);
            ((Runnable) expire.get(null)).run();
            assertFalse(RemoteKeepAliveService.active());
            assertNull(field("api"));
            assertFalse((boolean) field("backgroundConnection"));
            assertFalse((boolean) field("connected"));
        });
    }

    public void testReturningAfterFrozenExpiryReconnectsInsteadOfReusing() throws Exception {
        ui(() -> {
            prepareRemote();
            Object client = field("api");
            invoke("onPause"); invoke("onStop");
            assertTrue(RemoteKeepAliveService.active());
            assertTrue((boolean) field("backgroundConnection"));
            // A frozen process never runs the keep-alive nor the retention timer,
            // so both deadlines are simply in the past when the user returns.
            var deadline = RemoteKeepAliveService.class.getDeclaredField("deadline"); deadline.setAccessible(true);
            deadline.setLong(null, android.os.SystemClock.elapsedRealtime() - 1);
            assertFalse(RemoteKeepAliveService.active());
            invoke("onStart");
            assertFalse((boolean) field("backgroundConnection"));
            assertFalse(RemoteKeepAliveService.active());
            assertNotSame("An expired background session must reconnect with a fresh client", client, field("api"));
        });
        getInstrumentation().waitForIdleSync();
    }

    public void testReturningBeforeRetentionExpiresStillReplacesAStalledStream() {
        ui(() -> {
            prepareRemote();
            Object previous = field("api");
            long now = android.os.SystemClock.elapsedRealtime();
            RemoteStreamHealth stale = new RemoteStreamHealth(now - 60_000);
            stale.snapshot(now - RemoteStreamHealth.IDLE_TIMEOUT_MS - 1);
            field("streamHealth", stale);
            field("remoteClientFactory", (java.util.function.Function<String, RemoteApi>) address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) { return new JSONObject(); }
                @Override void events(String id, String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                    throw new java.io.IOException("Test stream unavailable");
                }
                @Override public void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException { throw new java.io.IOException("Test stream unavailable"); }
            });
            invoke("onPause"); invoke("onStop");
            assertTrue(RemoteKeepAliveService.active());
            invoke("onStart");
            assertNotSame("A retained service alone does not prove the stream is alive", previous, field("api"));
            assertFalse((boolean) field("connected"));
            assertTrue((boolean) field("reconnecting"));
        });
    }

    public void testDisablingStopsSessionImmediately() {
        ui(() -> {
            prepareRemote(); invoke("onPause"); invoke("onStop");
            MobilePreferences.set(activity, "remoteKeepAlive", "disabled");
            RemoteKeepAliveService.finish(activity, false);
            assertFalse(RemoteKeepAliveService.active());
            assertNull(field("api"));
        });
    }

    public void testForegroundServiceOwnsBoundedWakeLockAndStopsAtDeadline() throws Exception {
        var lease = new java.util.concurrent.atomic.AtomicReference<android.os.PowerManager.WakeLock>();
        ui(() -> { prepareRemote(); invoke("onPause"); invoke("onStop"); });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            var running = RemoteKeepAliveService.class.getDeclaredField("running"); running.setAccessible(true);
            RemoteKeepAliveService service = (RemoteKeepAliveService) running.get(null);
            assertNotNull(service);
            var wakeField = RemoteKeepAliveService.class.getDeclaredField("wake"); wakeField.setAccessible(true);
            var wake = (android.os.PowerManager.WakeLock) wakeField.get(service);
            lease.set(wake);
            assertNotNull(wake); assertTrue(wake.isHeld());
            assertTrue(RemoteKeepAliveService.active());
            long original = deadline();
            invoke("stopNetwork");
            assertEquals(original, deadline());
            var timer = RemoteKeepAliveService.class.getDeclaredField("stopAtDeadline"); timer.setAccessible(true);
            ((Runnable) timer.get(service)).run();
            assertFalse(RemoteKeepAliveService.active());
            assertNull(field("api"));
        });
        // stopSelf() completes through the system service manager; an idle main looper is not its completion signal.
        long stopDeadline = android.os.SystemClock.elapsedRealtime() + 5000;
        while (android.os.SystemClock.elapsedRealtime() < stopDeadline) {
            var stopped = new java.util.concurrent.atomic.AtomicBoolean();
            ui(() -> {
                var running = RemoteKeepAliveService.class.getDeclaredField("running"); running.setAccessible(true);
                stopped.set(running.get(null) == null);
            });
            if (stopped.get()) break;
            Thread.sleep(25);
        }
        ui(() -> {
            var running = RemoteKeepAliveService.class.getDeclaredField("running"); running.setAccessible(true);
            assertNull(running.get(null));
            assertFalse("The destroyed service must release its wake lock", lease.get().isHeld());
        });
    }

    public void testGeneralSettingsTogglePersists() throws Exception {
        var settings = (SettingsActivity) getInstrumentation().startActivitySync(new Intent(activity, SettingsActivity.class)
            .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        long readyDeadline = android.os.SystemClock.elapsedRealtime() + 5000;
        while (android.os.SystemClock.elapsedRealtime() < readyDeadline) {
            var ready = new java.util.concurrent.atomic.AtomicBoolean();
            ui(() -> ready.set(settings.getWindow().getDecorView().findViewWithTag("preference:remoteKeepAlive") != null));
            if (ready.get()) break;
            Thread.sleep(25);
        }
        try {
            ui(() -> {
                View toggle = settings.getWindow().getDecorView().findViewWithTag("preference:remoteKeepAlive");
                assertNotNull(toggle);
                ((android.widget.Switch) toggle).setChecked(true);
                assertTrue(RemoteKeepAliveService.enabled(settings));
                assertFalse(RemoteKeepAliveService.active());
                ((android.widget.Switch) toggle).setChecked(false);
                assertFalse(RemoteKeepAliveService.enabled(settings));
            });
        } finally { ui(settings::finish); }
    }
}
