package app.camellia.mobile;

import android.content.Intent;
import android.content.SharedPreferences;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONObject;

public class RemoteConversationStatusTest extends InstrumentationTestCase {
    public void testEnglishBackgroundStopLayout() { backgroundStopLayout(false); }
    public void testChineseBackgroundStopLayout() { backgroundStopLayout(true); }
    public void testEnglishUnknownBackgroundLayout() { backgroundStopLayout(false, true); }
    public void testChineseUnknownBackgroundLayout() { backgroundStopLayout(true, true); }

    private void backgroundStopLayout(boolean zh) {
        backgroundStopLayout(zh, false);
    }

    private void backgroundStopLayout(boolean zh, boolean unknown) {
        String description = zh ? "Wait for the scheduled report to finish and verify its generated files before continuing"
            : "等待定时报告完成，然后检查生成的文件并继续整理结果";
        ui(() -> {
            field("chinese", zh); field("conversationId", "status-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            field("displayedConversation", new JSONObject().put("id", "status-test").put("backgroundWork",
                new JSONObject().put("tasks", new org.json.JSONArray().put(new JSONObject().put("id", "shell").put("engine", "kimi")
                    .put("runId", 7).put("canStop", true).put("status", unknown ? "unknown" : "running").put("description", description)))));
            field("canStopBackgroundWork", true); field("connected", true); field("controlAllowed", true);
            var update = MainActivity.class.getDeclaredMethod("updateControls"); update.setAccessible(true); update.invoke(activity);
            // Inline work cards live inside the collapsible work strip; reveal it
            // before checking the legacy background-control geometry.
            var inlineField = MainActivity.class.getDeclaredField("workInline"); inlineField.setAccessible(true);
            ((View) inlineField.get(activity)).setVisibility(View.VISIBLE);
        });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            View root = activity.getWindow().getDecorView(), bar = root.findViewWithTag("remoteBackgroundWork");
            PageTransitions transitions = root.findViewWithTag("pageTransitions");
            if (transitions != null) transitions.finishTransition();
            TextView stop = root.findViewWithTag("remoteBackgroundStop");
            assertTrue(stop.isEnabled());
            assertTrue("stop width " + stop.getWidth() + ", bar " + bar.getWidth() + ", root " + root.getWidth(), stop.getWidth() > 0);
            assertTrue("bar " + bar.getWidth() + " exceeds root " + root.getWidth(), bar.getWidth() <= root.getWidth());
            TextView label = (TextView) ((android.widget.LinearLayout) bar).getChildAt(0);
            assertEquals(unknown ? (zh ? "后台状态未知 · 1" : "Background status unknown · 1") : (zh ? "后台任务 · 1" : "Background tasks · 1"), label.getText().toString());
            assertTrue(label.getWidth() > 0); assertNotNull(label.getLayout());
            for (int line = 0; line < label.getLayout().getLineCount(); line++) assertEquals(0, label.getLayout().getEllipsisCount(line));
            assertEquals(zh ? "停止后台任务" : "Stop background tasks", stop.getText().toString());
            TextView footer = root.findViewWithTag("connectionStatus");
            String summary = unknown ? (zh ? "后台状态未知 · 重试中" : "Background status unknown · retrying")
                : (zh ? "1 个后台任务运行中" : "1 background task running");
            assertEquals(summary + "  ›", footer.getText().toString());
            assertEquals(1, footer.getLayout().getLineCount());
            assertEquals(0, footer.getLayout().getEllipsisCount(0));
            android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(root.getWidth(), root.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
            root.draw(new android.graphics.Canvas(bitmap));
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "background-work-" + (unknown ? "unknown-" : "") + (zh ? "zh" : "en") + ".png"))) {
                assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
            } finally { bitmap.recycle(); }
            assertTrue(footer.performClick());
            var workDialog = MainActivity.class.getDeclaredField("workDialog"); workDialog.setAccessible(true);
            android.app.Dialog dialog = (android.app.Dialog) workDialog.get(activity);
            TextView details = dialog.findViewById(android.R.id.content).findViewWithTag("workBackgroundDescriptions");
            assertEquals(description, details.getText().toString());
            dialog.dismiss();
        });
    }

    public void testBackgroundStopControlTracksHostCapabilityConnectionAndNativeState() {
        ui(() -> {
            field("conversationId", "status-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            field("displayedConversation", new JSONObject().put("id", "status-test").put("backgroundWork",
                new JSONObject().put("tasks", new org.json.JSONArray().put(new JSONObject().put("id", "shell").put("engine", "kimi").put("runId", 7).put("canStop", true)))));
            var update = MainActivity.class.getDeclaredMethod("updateControls"); update.setAccessible(true);
            field("canStopBackgroundWork", true); update.invoke(activity);
            View root = activity.getWindow().getDecorView();
            TextView stop = root.findViewWithTag("remoteBackgroundStop");
            assertNotNull(stop); assertFalse(stop.isEnabled());
            assertEquals(View.VISIBLE, root.findViewWithTag("remoteBackgroundWork").getVisibility());
            field("connected", true); field("controlAllowed", true); update.invoke(activity);
            assertTrue(stop.isEnabled());
            field("commandBusy", true); update.invoke(activity); assertFalse(stop.isEnabled());
            field("commandBusy", false); field("controlAllowed", false); update.invoke(activity); assertFalse(stop.isEnabled());
            field("canStopBackgroundWork", false); update.invoke(activity);
            assertEquals(View.GONE, root.findViewWithTag("remoteBackgroundWork").getVisibility());
            field("canStopBackgroundWork", true); field("displayedConversation", new JSONObject().put("id", "status-test")); update.invoke(activity);
            assertEquals(View.GONE, root.findViewWithTag("remoteBackgroundWork").getVisibility());
        });
    }

    private MainActivity activity;
    private SharedPreferences preferences;
    private RemoteReplyState replies;
    private JSONObject credentials;
    private boolean oldEmbedded;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        preferences = context.getSharedPreferences("remote-status-test", 0);
        preferences.edit().clear().commit();
        EmbeddedNetwork.setEnabled(oldEmbedded);
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

    public void testHarnessAndModelMetadataUsesSelectionInsteadOfAttachments() {
        ui(() -> {
            JSONObject conversation = conversation().put("engine", "codex").put("model", "gpt-6.1-sol")
                .put("modelName", "GPT-6.1 Sol").put("filePreview", new JSONObject().put("name", "private.jpg"));
            for (String state : new String[] { "idle", "running", "permission", "question" }) {
                conversation.put("activity", state);
                View row = card(conversation);
                TextView meta = row.findViewWithTag("conversationRowMeta");
                assertEquals("CODEX · GPT-6.1 Sol", meta.getText().toString());
                assertTrue(row.getContentDescription().toString().contains("GPT-6.1 Sol"));
                assertFalse(row.getContentDescription().toString().contains("private.jpg"));
            }
            conversation.put("modelName", JSONObject.NULL).put("model", "custom-model");
            assertEquals("CODEX · custom-model", ((TextView) card(conversation).findViewWithTag("conversationRowMeta")).getText().toString());
            conversation.put("model", JSONObject.NULL);
            assertEquals("CODEX", ((TextView) card(conversation).findViewWithTag("conversationRowMeta")).getText().toString());
            conversation.remove("engine"); conversation.put("currentEngine", "grok").put("modelName", "Grok Model");
            assertEquals("Grok Build · Grok Model", ((TextView) card(conversation).findViewWithTag("conversationRowMeta")).getText().toString());
        });
    }

    public void testRunningWaitingAndUnreadVisibleTogether() {
        ui(() -> {
            Palette palette = Palette.of(activity);
            JSONObject conversation = conversation().put("activity", "running");
            TextView badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("运行中 · 未读回复", badge.getText().toString());
            assertEquals(palette.success, badge.getCurrentTextColor());
            for (String state : new String[] { "permission", "question" }) {
                conversation.put("activity", state);
                badge = card(conversation).findViewWithTag("conversationStatus:status-test");
                assertEquals((state.equals("permission") ? "等待确认" : "等待回答") + " · 未读回复",
                    badge.getText().toString());
                assertEquals(palette.warning, badge.getCurrentTextColor());
            }
            conversation.put("activity", JSONObject.NULL);
            assertTrue(card(conversation).getContentDescription().toString().contains("未读回复"));
            replies.markRead(credentials, conversation);
            assertNull(card(conversation).findViewWithTag("conversationStatus:status-test"));
            conversation.put("lastReplyAt", 1001);
            badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("未读回复", badge.getText().toString());
            assertEquals(palette.accent, badge.getCurrentTextColor());
            replies.markRead(credentials, conversation);
            conversation.remove("lastReplyAt");
            conversation.put("activity", "running");
            badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("运行中", badge.getText().toString());
            assertEquals(palette.success, badge.getCurrentTextColor());
        });
    }

    public void testDraftUsesRedStatusTextUntilTheDesktopStartsRunning() {
        ui(() -> {
            Palette palette = Palette.of(activity);
            JSONObject conversation = conversation();
            conversation.remove("lastReplyAt");
            credentials.put("drafts", new JSONObject().put("status-test", "Unfinished prompt"));
            TextView badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("草稿", badge.getText().toString());
            assertEquals(palette.error, badge.getCurrentTextColor());

            conversation.put("activity", "running");
            badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("运行中", badge.getText().toString());
            assertEquals(palette.success, badge.getCurrentTextColor());
        });
    }

    public void testBackgroundTasksShowWhenTheReplyIsOver() {
        ui(() -> {
            JSONObject conversation = conversation().put("backgroundWork", new JSONObject().put("engine", "kimi")
                .put("tasks", new org.json.JSONArray().put(new JSONObject().put("id", "task-1").put("description", "Run the analysis"))));
            TextView badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("后台任务 · 未读回复", badge.getText().toString());
            assertTrue(card(conversation).getContentDescription().toString().contains("后台任务"));
            // A running reply keeps the one state column, as on the desktop.
            conversation.put("activity", "running");
            badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("运行中 · 未读回复", badge.getText().toString());
        });
    }

    public void testRunningUnreadAndPinnedUseTheSameOrderAsDesktop() {
        ui(() -> {
            JSONObject conversation = conversation().put("activity", "running").put("pinned", true);
            TextView badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("运行中 · 未读回复 · 置顶", badge.getText().toString());
            replies.markRead(credentials, conversation);
            badge = card(conversation).findViewWithTag("conversationStatus:status-test");
            assertEquals("运行中 · 置顶", badge.getText().toString());
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

    public void testUnconfirmedDeliveryIsInlineRetryAndStaysActionableOffline() {
        ui(() -> {
            JSONObject payload = new JSONObject().put("action", "send").put("requestId", "retry-test").put("prompt", "Hello");
            JSONObject pending = new JSONObject().put("conversationId", "status-test").put("payload", payload)
                .put("uncertain", true);
            credentials.put("pendingCommand", pending);
            field("conversationId", "status-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            View root = activity.getWindow().getDecorView();
            TextView retry = root.findViewWithTag("outgoingRetry");
            assertNotNull(retry);
            assertTrue(retry.getText().toString().contains("点击重试"));
            assertTrue(retry.hasOnClickListeners());
            // Checking or resolving the pending request works without a live
            // control connection, so these fields no longer gate the action.
            assertTrue(retry.isEnabled());
            var update = MainActivity.class.getDeclaredMethod("updateControls"); update.setAccessible(true);
            field("connected", true); field("controlAllowed", true); update.invoke(activity);
            assertTrue(retry.isEnabled());
            field("commandBusy", true); update.invoke(activity);
            assertTrue(retry.isEnabled());
            field("commandBusy", false); field("controlAllowed", false); update.invoke(activity);
            assertTrue(retry.isEnabled());
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

    public void testPendingSendWithoutUncertaintyShowsPreparing() {
        ui(() -> {
            JSONObject payload = new JSONObject().put("action", "send").put("requestId", "prepare-test").put("prompt", "Hello");
            credentials.put("pendingCommand", new JSONObject().put("conversationId", "status-test").put("payload", payload));
            field("conversationId", "status-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            View root = activity.getWindow().getDecorView();
            assertNotNull(root.findViewWithTag("outgoingDelivery"));
            assertNull(root.findViewWithTag("outgoingRetry"));
        });
    }
}
