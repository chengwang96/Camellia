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
            assertTrue(deadline() - android.os.SystemClock.elapsedRealtime() <= 300_000);
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
        ui(() -> { prepareRemote(); invoke("onPause"); invoke("onStop"); });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            var running = RemoteKeepAliveService.class.getDeclaredField("running"); running.setAccessible(true);
            RemoteKeepAliveService service = (RemoteKeepAliveService) running.get(null);
            assertNotNull(service);
            var wakeField = RemoteKeepAliveService.class.getDeclaredField("wake"); wakeField.setAccessible(true);
            var wake = (android.os.PowerManager.WakeLock) wakeField.get(service);
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
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            var running = RemoteKeepAliveService.class.getDeclaredField("running"); running.setAccessible(true);
            assertNull(running.get(null));
        });
    }

    public void testGeneralSettingsTogglePersists() throws Exception {
        var settings = (SettingsActivity) getInstrumentation().startActivitySync(new Intent(activity, SettingsActivity.class)
            .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
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
