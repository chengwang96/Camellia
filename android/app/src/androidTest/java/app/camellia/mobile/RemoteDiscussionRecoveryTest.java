package app.camellia.mobile;

import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class RemoteDiscussionRecoveryTest extends RemoteDiscussionsTest {
    private static final String GROUP = "00000000-0000-0000-0000-000000000001";
    private static final String REQUEST = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    interface Checked { void run() throws Exception; }
    private RemoteDiscussionsActivity activity() throws Exception { var f = RemoteDiscussionsTest.class.getDeclaredField("activity"); f.setAccessible(true); return (RemoteDiscussionsActivity) f.get(this); }
    private Object get(String name) throws Exception { var f = RemoteDiscussionsActivity.class.getDeclaredField(name); f.setAccessible(true); return f.get(activity()); }
    private void set(String name, Object value) throws Exception { var f = RemoteDiscussionsActivity.class.getDeclaredField(name); f.setAccessible(true); f.set(activity(), value); }
    private void call(String name, Class<?>[] types, Object... args) throws Exception { var m = RemoteDiscussionsActivity.class.getDeclaredMethod(name, types); m.setAccessible(true); m.invoke(activity(), args); }
    private void ui(Checked action) { var error = new java.util.concurrent.atomic.AtomicReference<Throwable>(); getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable e) { error.set(e); } }); if (error.get() != null) throw new AssertionError(error.get()); }
    private void fixture() throws Exception { var m = RemoteDiscussionsTest.class.getDeclaredMethod("offlineFixture"); m.setAccessible(true); m.invoke(this); }
    private JSONObject command(String group) throws Exception { return new JSONObject().put("requestId", REQUEST).put("action", "send").put("id", group).put("parameters", new JSONObject().put("text", "message")); }
    private void waitUntil(java.util.function.BooleanSupplier predicate) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 5000;
        while (!predicate.getAsBoolean() && SystemClock.elapsedRealtime() < deadline) { getInstrumentation().waitForIdleSync(); Thread.sleep(20); }
        assertTrue(predicate.getAsBoolean()); getInstrumentation().waitForIdleSync();
    }
    private void recover(IOException failure, boolean limited) throws Exception {
        fixture(); AtomicInteger calls = new AtomicInteger(); CountDownLatch first = new CountDownLatch(1);
        RemoteApi fake = new RemoteApi("http://100.64.0.1:43129") {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                if (payload != null) throw new AssertionError("Receipt polling resent a command");
                if (calls.incrementAndGet() == 1) { first.countDown(); throw failure; }
                try { return new JSONObject().put("state", "completed"); } catch (Exception error) { throw new IOException(error); }
            }
        };
        ui(() -> {
            set("foreground", true); set("connected", true); set("api", fake); ((Set<?>) get("uncertain")).clear();
            ((JSONObject) get("pending")).put(REQUEST, command(GROUP));
            ((ChatComposer) get("composer")).input.setText("next message"); call("poll", new Class<?>[]{String.class, boolean.class}, REQUEST, false);
        }); assertTrue(first.await(3, TimeUnit.SECONDS));
        var shown = new java.util.concurrent.atomic.AtomicBoolean();
        waitUntil(() -> { ui(() -> shown.set(((ViewGroup) get("pendingBar")).getChildCount() > 0)); return shown.get(); });
        ui(() -> { assertTrue(((Set<?>) get("uncertain")).contains(REQUEST)); assertTrue(((Set<?>) get("scheduledPolls")).contains(REQUEST)); });
        if (limited) {
            assertEquals(1, calls.get()); ui(() -> call("poll", new Class<?>[]{String.class, boolean.class}, REQUEST, false));
        }
        var settled = new java.util.concurrent.atomic.AtomicBoolean();
        waitUntil(() -> { ui(() -> settled.set(!((JSONObject) get("pending")).has(REQUEST))); return settled.get(); });
        ui(() -> { assertTrue((boolean) get("connected")); assertTrue(((ChatComposer) get("composer")).send.isEnabled()); });
        assertEquals(2, calls.get());
    }
    public void testTimeoutAutomaticallyRecoversByQueryingTheSameReceipt() throws Exception { recover(new java.net.SocketTimeoutException("fixture timeout"), false); }
    public void testServiceFailureAutomaticallyRecoversByQueryingTheSameReceipt() throws Exception { recover(new RemoteApi.Failure(503, "fixture service error"), false); }
    public void testRateLimitKeepsRetryVisibleAndCanBeQueriedWithoutReuploading() throws Exception { recover(new RemoteApi.Failure(429, "fixture rate limit"), true); }
    public void testAnotherGroupsPendingRequestDoesNotBlockThisGroup() throws Exception {
        fixture(); ui(() -> {
            set("foreground", true); set("connected", true);
            ((JSONObject) get("pending")).put(REQUEST, command("00000000-0000-0000-0000-000000000002"));
            ((ChatComposer) get("composer")).input.setText("next message"); call("controls", new Class<?>[0]);
            assertTrue(((ChatComposer) get("composer")).send.isEnabled());
        });
    }
    private TextView text(View view, String label) {
        if (view instanceof TextView && ((TextView) view).getText().toString().equals(label)) return (TextView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) { TextView found = text(((ViewGroup) view).getChildAt(i), label); if (found != null) return found; }
        return null;
    }
    public void testInterruptedOutcomeOffersExplicitResolution() throws Exception {
        fixture(); ui(() -> {
            set("foreground", true); set("connected", true); set("api", new RemoteApi("http://100.64.0.1:43129"));
            JSONObject command = command(GROUP); ((JSONObject) get("pending")).put(REQUEST, command);
            call("receipt", new Class<?>[]{JSONObject.class, JSONObject.class}, command, new JSONObject().put("state", "interrupted"));
            assertTrue(((JSONObject) get("pending")).has(REQUEST)); call("poll", new Class<?>[]{String.class, boolean.class}, REQUEST, true);
            android.app.Dialog dialog = (android.app.Dialog) get("dialog"); assertTrue(dialog.isShowing());
            TextView resolve = text(dialog.getWindow().getDecorView(), (boolean) get("chinese") ? "已核对，解除待确认" : "Checked; resolve");
            assertNotNull(resolve); resolve.performClick(); assertFalse(((JSONObject) get("pending")).has(REQUEST));
        });
    }
    public void testOfflineUnconfirmedActionCanStillBeResolvedAfterInspection() throws Exception {
        fixture(); ui(() -> {
            set("foreground", true); set("connected", false); set("api", null);
            ((JSONObject) get("pending")).put(REQUEST, command(GROUP));
            @SuppressWarnings("unchecked") Set<String> uncertain = (Set<String>) get("uncertain"); uncertain.add(REQUEST); call("controls", new Class<?>[0]);
            View button = ((ViewGroup) get("pendingBar")).getChildAt(0); assertTrue(button.isEnabled()); button.performClick();
            android.app.Dialog dialog = (android.app.Dialog) get("dialog"); assertTrue(dialog.isShowing());
            TextView resolve = text(dialog.getWindow().getDecorView(), (boolean) get("chinese") ? "已核对，解除待确认" : "Checked; resolve");
            assertNotNull(resolve); resolve.performClick(); assertFalse(((JSONObject) get("pending")).has(REQUEST));
        });
    }
}
