package app.camellia.mobile;

import android.content.Intent;
import android.content.SharedPreferences;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONObject;

public class RemoteConversationStatusTest extends InstrumentationTestCase {
    private MainActivity activity;
    private SharedPreferences preferences;
    private RemoteReplyState replies;
    private JSONObject credentials;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        preferences = context.getSharedPreferences("remote-status-test", 0);
        preferences.edit().clear().commit();
        replies = new RemoteReplyState(preferences);
        credentials = new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "test");
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            var stop = MainActivity.class.getDeclaredMethod("stopNetwork"); stop.setAccessible(true); stop.invoke(activity);
            field("replyState", replies); field("credentials", credentials); field("chinese", true);
        });
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> activity.finish());
        getInstrumentation().waitForIdleSync();
        preferences.edit().clear().commit();
        super.tearDown();
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
    }

    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }

    private JSONObject conversation() throws Exception {
        return new JSONObject().put("id", "status-test").put("title", "状态测试").put("lastReplyAt", 1000);
    }

    private View card(JSONObject conversation) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("conversationCard", JSONObject.class); method.setAccessible(true);
        return (View) method.invoke(activity, conversation);
    }

    public void testRunningWaitingAndUnreadVisibleTogether() {
        ui(() -> {
            JSONObject conversation = conversation().put("activity", "running");
            TextView badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("正在运行 · 新消息", badge.getText().toString());
            for (String state : new String[] { "permission", "question" }) {
                conversation.put("activity", state);
                badge = card(conversation).findViewWithTag("conversationStatus:status-test");
                assertEquals("等待电脑处理 · 新消息", badge.getText().toString());
            }
            conversation.put("activity", JSONObject.NULL);
            assertTrue(card(conversation).getContentDescription().toString().contains("新消息"));
            replies.markRead(credentials, conversation);
            assertNull(card(conversation).findViewWithTag("conversationStatus:status-test"));
            conversation.remove("lastReplyAt");
            conversation.put("activity", "running");
            badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("正在运行", badge.getText().toString());
        });
    }

    public void testReadMarkersPersistAndStayIsolatedWithoutPhoneClock() throws Exception {
        JSONObject conversation = conversation();
        assertTrue(replies.unread(credentials, conversation));
        replies.markRead(credentials, conversation);
        replies = new RemoteReplyState(preferences);
        assertFalse(replies.unread(credentials, conversation));
        replies.markRead(credentials, new JSONObject(conversation.toString()).put("lastReplyAt", 500));
        assertFalse(replies.unread(credentials, conversation));
        assertTrue(replies.unread(credentials, new JSONObject(conversation.toString()).put("lastReplyAt", 1001)));
        assertTrue(replies.unread(new JSONObject(credentials.toString()).put("address", "http://100.64.0.2:43128"), conversation));
        assertTrue(replies.unread(new JSONObject(credentials.toString()).put("token", "other"), conversation));
        assertTrue(replies.unread(credentials, new JSONObject(conversation.toString()).put("id", "other")));
        assertFalse(replies.unread(credentials, new JSONObject().put("id", "old-desktop")));
    }

    public void testOnlySuccessfullyDisplayedSnapshotsMarkRead() {
        ui(() -> {
            field("conversationId", "status-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
            JSONObject conversation = conversation();
            JSONObject snapshot = new JSONObject().put("conversation", conversation).put("instanceId", "test").put("cursor", 1);
            apply.invoke(activity, snapshot);
            assertTrue(replies.unread(credentials, conversation));
            snapshot.put("messages", new org.json.JSONArray().put(new JSONObject().put("seq", 1).put("role", "assistant").put("text", "Reply")));
            apply.invoke(activity, snapshot);
            assertFalse(replies.unread(credentials, conversation));
        });
    }

    public void testDesktopReadMarkerClearsPhoneBadgeAndNewReplyReturns() {
        ui(() -> {
            JSONObject conversation = conversation().put("replyReadAt", 1000);
            assertFalse(replies.unread(credentials, conversation));
            assertNull(card(conversation).findViewWithTag("conversationStatus:status-test"));
            conversation.put("lastReplyAt", 1001);
            assertTrue(replies.unread(credentials, conversation));
            assertNotNull(card(conversation).findViewWithTag("conversationStatus:status-test"));
        });
    }

    public void testUnconfirmedDeliveryIsInlineRetryAndTracksAvailability() {
        ui(() -> {
            JSONObject payload = new JSONObject().put("action", "send").put("requestId", "retry-test").put("prompt", "Hello");
            JSONObject pending = new JSONObject().put("conversationId", "status-test").put("payload", payload);
            credentials.put("pendingCommand", pending);
            field("conversationId", "status-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            View root = activity.getWindow().getDecorView();
            TextView retry = root.findViewWithTag("outgoingRetry");
            assertNotNull(retry);
            assertTrue(retry.getText().toString().contains("点击重试"));
            assertTrue(retry.hasOnClickListeners());
            assertFalse(retry.isEnabled());
            var update = MainActivity.class.getDeclaredMethod("updateControls"); update.setAccessible(true);
            field("connected", true); field("controlAllowed", true); update.invoke(activity);
            assertTrue(retry.isEnabled());
            field("commandBusy", true); update.invoke(activity);
            assertFalse(retry.isEnabled());
            field("commandBusy", false); field("controlAllowed", false); update.invoke(activity);
            assertFalse(retry.isEnabled());
            var state = MainActivity.class.getDeclaredMethod("outgoingState", String.class); state.setAccessible(true);
            for (String delivery : new String[] { "sending", "preparing", "accepted", "failed" }) {
                state.invoke(activity, delivery);
                assertNull(root.findViewWithTag("outgoingRetry"));
            }
            state.invoke(activity, "unconfirmed");
            retry = root.findViewWithTag("outgoingRetry");
            assertNotNull(retry);
            credentials.remove("pendingCommand"); update.invoke(activity);
            assertFalse(retry.isEnabled());
        });
    }
}
