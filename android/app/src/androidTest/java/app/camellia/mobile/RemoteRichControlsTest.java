package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicReference;

public class RemoteRichControlsTest extends InstrumentationTestCase {
    private Activity activity; private AlertDialog dialog; private RemoteSettingsPopup popup;
    private String oldTheme, oldLanguage;
    interface Checked { void run() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private static Object field(Object value, String name) throws Exception { var f = value.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(value); }
    private void set(String name, Object value) throws Exception { var f = MainActivity.class.getDeclaredField(name); f.setAccessible(true); f.set(activity, value); }
    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        oldTheme = MobilePreferences.get(context, "theme"); oldLanguage = MobilePreferences.get(context, "language");
        android.os.Bundle args = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        if (args.containsKey("discussionTheme")) MobilePreferences.set(context, "theme", args.getString("discussionTheme"));
        if (args.containsKey("discussionLanguage")) MobilePreferences.set(context, "language", args.getString("discussionLanguage"));
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
    }
    @Override protected void tearDown() throws Exception {
        ui(() -> { if (dialog != null) dialog.dismiss(); if (popup != null) popup.dismiss(); activity.finish(); }); getInstrumentation().waitForIdleSync();
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", oldTheme); MobilePreferences.set(getInstrumentation().getTargetContext(), "language", oldLanguage); super.tearDown();
    }
    public void testDiscussionsAreSearchableCollapsiblePeerRowsWithDirectNavigation() throws Exception {
        AtomicReference<Intent> launched = new AtomicReference<>();
        android.app.Instrumentation.ActivityMonitor monitor = new android.app.Instrumentation.ActivityMonitor() {
            @Override public android.app.Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (intent.getComponent() != null && intent.getComponent().getClassName().equals(RemoteDiscussionsActivity.class.getName())) {
                    launched.set(intent); return new android.app.Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null);
                }
                return null;
            }
        };
        getInstrumentation().addMonitor(monitor);
        try {
            ui(() -> {
                set("credentials", new JSONObject().put("address", "http://100.64.0.1:43129").put("computerName", "Test computer"));
                var list = MainActivity.class.getDeclaredMethod("listScreen"); list.setAccessible(true); list.invoke(activity);
                set("canDiscussions", true); set("allowIndependent", true);
                set("availableWorkspaces", new JSONArray().put(new JSONObject().put("id", "test-workspace").put("name", "Camellia")));
                ((java.util.Map<String, JSONObject>) field(activity, "conversations")).put("ordinary", new JSONObject().put("id", "ordinary").put("title", "测试计划").put("workspaceId", JSONObject.NULL));
                ((java.util.Map<?, ?>) field(activity, "collapsedGroups")).clear();
                activity.getPreferences(Activity.MODE_PRIVATE).edit().remove("collapsed:http://100.64.0.1:43129/discussions").apply();
                set("discussionGroups", new JSONArray().put(new JSONObject().put("id", "group-1").put("title", "研究方案讨论").put("members", 2).put("pinned", true)));
                var render = MainActivity.class.getDeclaredMethod("renderConversations"); render.setAccessible(true); render.invoke(activity);
                View root = activity.getWindow().getDecorView();
                assertNull(root.findViewWithTag("remoteDiscussionsEntry"));
                assertNotNull(root.findViewWithTag("group:"));
                View row = root.findViewWithTag("discussion:group-1"); assertNotNull(row);
                root.findViewWithTag("group:discussions").performClick(); assertNull(root.findViewWithTag("discussion:group-1"));
                // Search still reveals matching rows while the section is collapsed.
                ((EditText) field(activity, "searchInput")).setText("研究"); assertNotNull(root.findViewWithTag("discussion:group-1"));
                ((EditText) field(activity, "searchInput")).setText("missing"); assertNull(root.findViewWithTag("discussion:group-1"));
                ((EditText) field(activity, "searchInput")).setText(""); root.findViewWithTag("group:discussions").performClick();
                root.findViewWithTag("discussion:group-1").performClick();
                assertEquals("group-1", launched.get().getStringExtra("groupId")); assertTrue(launched.get().getBooleanExtra("fromNavigation", false));
                assertFalse(launched.get().getBooleanExtra("createGroup", false));
                root.findViewWithTag("newDiscussion").performClick(); assertTrue(launched.get().getBooleanExtra("createGroup", false));
                assertNull(launched.get().getStringExtra("groupId"));
                root.findViewWithTag("discussion:group-1").performLongClick(); assertTrue(launched.get().getBooleanExtra("showActions", false));
            });
            getInstrumentation().waitForIdleSync(); Thread.sleep(300);
            ui(() -> ((ScrollView) field(activity, "scroll")).fullScroll(View.FOCUS_DOWN));
            getInstrumentation().waitForIdleSync(); Thread.sleep(300);
            android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
            if (image != null) try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "discussion-navigation.png"))) { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); image.recycle(); }
        } finally { getInstrumentation().removeMonitor(monitor); }
    }
    public void testQuestionsRequireAnswersAndPreserveMultipleChoices() throws Exception {
        AtomicReference<JSONObject> result = new AtomicReference<>();
        JSONObject request = new JSONObject().put("toolName", "Ask").put("questions", new JSONArray()
            .put(new JSONObject().put("id", "single").put("question", "Role").put("options", new JSONArray().put(new JSONObject().put("label", "Scientist"))))
            .put(new JSONObject().put("id", "multi").put("question", "Formats").put("multiSelect", true).put("options", new JSONArray().put(new JSONObject().put("label", "Text")).put(new JSONObject().put("label", "Image"))))
            .put(new JSONObject().put("id", "notes").put("question", "Notes")));
        ui(() -> {
            dialog = RemoteApprovalDialog.show(activity, request, "Agent", (allow, input, optionId) -> { assertTrue(allow); result.set(input); return true; });
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertNull(result.get()); assertTrue(dialog.isShowing());
            View root = dialog.getWindow().getDecorView(); root.findViewWithTag("Scientist").performClick(); root.findViewWithTag("Text").performClick(); root.findViewWithTag("Image").performClick();
            ((EditText) root.findViewWithTag("approvalAnswer:notes")).setText("Research"); dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertEquals("Scientist", result.get().getString("single")); assertEquals(2, result.get().getJSONArray("multi").length()); assertEquals("Research", result.get().getString("notes"));
        });
    }
    public void testSameModelIdCanSelectItsOtherConnection() throws Exception {
        AtomicReference<JSONObject> result = new AtomicReference<>();
        JSONObject settings = new JSONObject().put("connection", "subscription").put("model", "same").put("modelEditable", true).put("models", new JSONArray()
            .put(new JSONObject().put("id", "same").put("connection", "subscription")).put(new JSONObject().put("id", "same").put("connection", "api")));
        ui(() -> {
            FrameLayout frame = new FrameLayout(activity); TextView anchor = new TextView(activity); anchor.setText("Model");
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(200, 100, android.view.Gravity.BOTTOM); frame.addView(anchor, params); activity.setContentView(frame);
            popup = new RemoteSettingsPopup(activity, true, -1, 0xff111111, 0xff666666, 0xff4176e6, settings, (key, value) -> {
                try { assertEquals("modelChoice", key); result.set(new JSONObject(value)); } catch (Exception error) { throw new AssertionError(error); }
            }); popup.show(anchor, false);
            LinearLayout body = (LinearLayout) field(popup, "body"); View last = null;
            for (int i = 0; i < body.getChildCount(); i++) if ("remoteModelOption:same".equals(body.getChildAt(i).getTag())) last = body.getChildAt(i);
            assertNotNull(last); last.performClick(); assertEquals("api", result.get().getString("connection")); assertEquals("same", result.get().getString("model"));
        });
    }
    public void testActiveConversationEnablesNextTurnModelsButKeepsPermissionsLockedWithoutTokenDisplay() throws Exception {
        ui(() -> {
            String id = "11111111-1111-4111-8111-111111111111";
            set("credentials", new JSONObject()); set("conversationId", id); set("conversationTitle", "Active");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            JSONObject settings = new JSONObject().put("model", "same").put("modelEditable", true).put("editable", false).put("appliesNextTurn", true).put("version", "v");
            JSONObject snapshot = new JSONObject().put("instanceId", "fixture").put("cursor", 1).put("permission", "control")
                .put("conversation", new JSONObject().put("id", id).put("title", "Active").put("seq", 1))
                .put("messages", new JSONArray()).put("settings", settings).put("context", new JSONObject().put("used", 123).put("cap", 32000).put("source", "estimate").put("compacting", true));
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true); apply.invoke(activity, snapshot);
            assertTrue(((View) field(activity, "modelButton")).isEnabled()); assertFalse(((View) field(activity, "permissionButton")).isEnabled());
            assertNull(activity.getWindow().getDecorView().findViewWithTag("remoteContext"));
            View marker = activity.getWindow().getDecorView().findViewWithTag("remoteCompaction:compaction:live");
            assertNotNull(marker);
            String value = ((TextView) ((LinearLayout) marker).getChildAt(2)).getText().toString();
            assertFalse(value.contains("123")); assertFalse(value.contains("32000"));
        });
    }

    public void testCompactionTimelineShowsProgressAndRestoresOneCompletionWithoutTokenCounts() throws Exception {
        ui(() -> {
            String id = "11111111-1111-4111-8111-111111111111";
            set("credentials", new JSONObject()); set("conversationId", id); set("conversationTitle", "Compaction");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
            JSONArray rows = new JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("text", "Continue"));
            JSONObject snapshot = new JSONObject().put("instanceId", "fixture").put("cursor", 1).put("permission", "control")
                .put("conversation", new JSONObject().put("id", id).put("title", "Compaction").put("seq", 1))
                .put("messages", rows).put("nextBefore", JSONObject.NULL)
                .put("context", new JSONObject().put("used", 123456).put("cap", 32000).put("source", "estimate"));
            apply.invoke(activity, snapshot);
            LinearLayout messages = (LinearLayout) field(activity, "messages");
            assertEquals(1, messages.getChildCount());
            assertNull(activity.getWindow().getDecorView().findViewWithTag("remoteContext"));
            snapshot.put("compaction", new JSONObject().put("state", "running").put("afterSeq", 1).put("stage", "summarizing").put("chunk", 2));
            snapshot.put("live", new JSONObject().put("text", "").put("userSeq", 1));
            apply.invoke(activity, snapshot);
            ContextCompactionView marker = messages.findViewWithTag("remoteCompaction:compaction:live");
            assertNotNull(marker); assertSame(marker, messages.getChildAt(1));
            assertEquals(View.VISIBLE, marker.getChildAt(0).getVisibility());
            assertTrue(((TextView) marker.getChildAt(2)).getText().toString().contains("2"));
            JSONObject completion = new JSONObject().put("state", "completed").put("durationMs", 42000).put("seq", 2);
            rows.put(new JSONObject().put("seq", 2).put("role", "notice").put("text", "Context compacted").put("compaction", completion));
            snapshot.put("compaction", completion); snapshot.getJSONObject("conversation").put("seq", 2);
            apply.invoke(activity, snapshot); apply.invoke(activity, snapshot);
            assertNull(messages.findViewWithTag("remoteCompaction:compaction:live"));
            marker = messages.findViewWithTag("remoteCompaction:message:2"); assertNotNull(marker);
            assertEquals(3, messages.getChildCount()); assertEquals(View.GONE, marker.getChildAt(0).getVisibility());
            boolean zh = (Boolean) field(activity, "chinese");
            String value = ((TextView) marker.getChildAt(2)).getText().toString();
            assertTrue(value.contains(zh ? "上下文已压缩" : "Context compacted")); assertTrue(value.contains("42"));
            assertFalse(value.contains("123456")); assertFalse(value.contains("32000")); assertFalse(value.contains("tokens"));
            // Reopening and older hosts' text-only history still restore completion.
            detail.invoke(activity); snapshot.put("compaction", JSONObject.NULL); snapshot.remove("live");
            rows.getJSONObject(1).remove("compaction"); apply.invoke(activity, snapshot);
            messages = (LinearLayout) field(activity, "messages"); assertEquals(2, messages.getChildCount());
            assertNotNull(messages.findViewWithTag("remoteCompaction:message:2"));
            for (String state : new String[] { "failed", "cancelled" }) {
                snapshot.put("compaction", new JSONObject().put("state", state).put("afterSeq", 2)); apply.invoke(activity, snapshot);
                marker = messages.findViewWithTag("remoteCompaction:compaction:live");
                assertNotNull(marker); assertEquals(View.GONE, marker.getChildAt(0).getVisibility());
                assertTrue(((TextView) marker.getChildAt(2)).getText().toString().contains(zh ? "原对话已保留" : "original conversation is retained"));
            }
            set("conversationId", "22222222-2222-4222-8222-222222222222"); detail.invoke(activity); apply.invoke(activity, snapshot);
            assertEquals(0, ((LinearLayout) field(activity, "messages")).getChildCount());
        });
    }
}
