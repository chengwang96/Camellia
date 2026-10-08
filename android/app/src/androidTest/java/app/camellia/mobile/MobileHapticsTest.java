package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import org.json.JSONArray;
import org.json.JSONObject;

public class MobileHapticsTest extends InstrumentationTestCase {
    private Activity activity;
    private FeedbackLayout feedback;
    private String originalPreference, originalNotices;

    private static final class FeedbackLayout extends LinearLayout {
        int feedbacks;
        FeedbackLayout(Activity activity) { super(activity); }
        @Override public boolean performHapticFeedback(int effect) { feedbacks++; return true; }
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check action) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private void set(String name, Object value) throws Exception {
        var field = activity.getClass().getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private void notifyRequests() throws Exception {
        var method = activity.getClass().getDeclaredMethod("notifyApprovalRequests"); method.setAccessible(true); method.invoke(activity);
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        assertTrue("Use a disposable emulator", android.os.Build.HARDWARE.equals("ranchu") || android.os.Build.HARDWARE.equals("goldfish"));
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        originalPreference = MobilePreferences.get(context, "hapticFeedback");
        originalNotices = context.getSharedPreferences("mobile-haptic-notices", 0).getString("approvals", "[]");
        MobilePreferences.set(context, "hapticFeedback", "enabled");
        context.getSharedPreferences("mobile-haptic-notices", 0).edit().putString("approvals", "[]").commit();
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(activity::finish);
        getInstrumentation().waitForIdleSync();
        var context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "hapticFeedback", originalPreference);
        context.getSharedPreferences("mobile-haptic-notices", 0).edit().putString("approvals", originalNotices).commit();
        super.tearDown();
    }

    private void checkRequests(Class<? extends Activity> client) {
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), client).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            feedback = new FeedbackLayout(activity); feedback.setMinimumHeight(100); activity.setContentView(feedback);
            set("foreground", false); set("connected", true);
            set("instance", "host-instance");
            set("credentials", new JSONObject().put("address", "http://100.64.0.1:43128").put("deviceId", "test-device"));
        });
        getInstrumentation().waitForIdleSync();
        long deadline = android.os.SystemClock.uptimeMillis() + 3000;
        while (!activity.hasWindowFocus() && android.os.SystemClock.uptimeMillis() < deadline) android.os.SystemClock.sleep(20);
        ui(() -> {
            assertTrue(activity.hasWindowFocus());
            JSONArray pending = new JSONArray().put(new JSONObject().put("requestId", "permission-1").put("runId", 7));
            JSONObject snapshot = new JSONObject();
            boolean chat = client == MainActivity.class;
            if (chat) {
                set("screen", "detail"); set("controlAllowed", true); set("conversationId", "chat-1");
                snapshot.put("runId", 7).put("approvals", pending); set("lastLive", snapshot); set("approvals", feedback);
            } else {
                set("address", "http://100.64.0.1:43128"); set("groupId", "group-1");
                snapshot.put("pendingApprovals", pending); set("group", snapshot); set("content", feedback);
            }
            notifyRequests(); assertEquals(0, feedback.feedbacks);
            set("foreground", true);
            notifyRequests(); assertEquals(1, feedback.feedbacks);
            notifyRequests(); assertEquals(1, feedback.feedbacks);
            pending.getJSONObject(0).put("details", "Updated preview");
            notifyRequests(); assertEquals(1, feedback.feedbacks);
            feedback.setVisibility(View.INVISIBLE);
            pending.put(new JSONObject().put("requestId", "question-2").put("runId", 7).put("questions", new JSONArray().put(new JSONObject().put("question", "Continue?"))));
            notifyRequests(); assertEquals(1, feedback.feedbacks);
            feedback.setVisibility(View.VISIBLE);
            notifyRequests(); assertEquals(2, feedback.feedbacks);
            MobilePreferences.set(activity, "hapticFeedback", "disabled");
            pending.put(new JSONObject().put("requestId", "permission-3").put("runId", 7));
            notifyRequests(); assertEquals(2, feedback.feedbacks);
            MobilePreferences.set(activity, "hapticFeedback", "enabled");
            notifyRequests(); assertEquals(2, feedback.feedbacks);
            set(chat ? "conversationId" : "groupId", "another-conversation");
            notifyRequests(); assertEquals(3, feedback.feedbacks);
            notifyRequests(); assertEquals(3, feedback.feedbacks);
        });
    }

    public void testChatRequestsOnlyNotifyOnceInForegroundAndRespectTheSwitch() { checkRequests(MainActivity.class); }
    public void testDiscussionRequestsOnlyNotifyOnceInForegroundAndRespectTheSwitch() { checkRequests(RemoteDiscussionsActivity.class); }
}
