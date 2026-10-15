package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteMessageQueueTest extends InstrumentationTestCase {
    private MainActivity activity;
    private ComputerStore store;
    private final String id = "remote-queue-fixture";
    private long cursor;

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
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
    private View view(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private EditText input() throws Exception { return (EditText) field("composer"); }
    private JSONObject entry(String key, String state) throws Exception {
        return new JSONObject().put("id", key).put("text", key.equals("one") ? "完成后整理测试结果，并保留附件" : "再检查移动端的队列交互")
            .put("state", state).put("attachments", new JSONArray().put(new JSONObject().put("name", "notes.txt").put("isImage", false)));
    }
    private void snapshot(boolean supported, boolean running, JSONArray queue, long version) throws Exception {
        JSONObject snapshot = new JSONObject().put("instanceId", "fixture").put("cursor", ++cursor).put("permission", "control")
            .put("conversation", new JSONObject().put("id", id).put("title", "远程消息队列").put("seq", 3)
                .put("activity", running ? "running" : JSONObject.NULL))
            .put("messages", new JSONArray()).put("nextBefore", JSONObject.NULL);
        if (supported) snapshot.put("queue", queue).put("queueVersion", version);
        if (running) snapshot.put("live", new JSONObject().put("runId", 1).put("text", "正在执行当前任务…"));
        var method = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); method.setAccessible(true); method.invoke(activity, snapshot);
    }
    private void finish(JSONObject payload, JSONObject result) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("finishCommand", JSONObject.class, JSONObject.class);
        method.setAccessible(true); method.invoke(activity, payload, result);
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        CredentialStore encrypted = new CredentialStore(context, "remote-queue-test"); encrypted.clear();
        store = new ComputerStore(encrypted);
        JSONObject credentials = new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "test");
        store.save(credentials);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            invoke("stopNetwork"); field("store", store); field("credentials", credentials);
            field("chinese", true); field("foreground", false); field("conversationId", id);
            invoke("detailScreen"); field("api", null);
        });
    }
    @Override protected void tearDown() throws Exception {
        ui(() -> { field("foreground", false); activity.finish(); });
        getInstrumentation().waitForIdleSync(); super.tearDown();
    }

    public void testRunningSendQueuesAndReceiptAllowsAnotherMessage() {
        ui(() -> {
            snapshot(true, true, new JSONArray(), 1);
            input().setText("完成后整理测试结果");
            assertTrue(view("remoteSend").isEnabled());
            assertEquals(View.VISIBLE, view("remoteSend").getVisibility());
            assertEquals("加入队列", view("remoteSend").getContentDescription());
            assertEquals(View.GONE, view("remoteStop").getVisibility());
            field("foreground", true);
            var send = MainActivity.class.getDeclaredMethod("sendMessage", String.class); send.setAccessible(true); send.invoke(activity, "");
            JSONObject pending = ((JSONObject) field("credentials")).getJSONObject("pendingCommand");
            JSONObject payload = pending.getJSONObject("payload");
            assertTrue(payload.getBoolean("queue")); assertEquals("send", payload.getString("action"));
            assertEquals("完成后整理测试结果", payload.getString("prompt"));
            assertFalse(input().isEnabled());
            finish(payload, new JSONObject().put("ok", false).put("state", "pending"));
            assertEquals(payload.getString("requestId"), ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload").getString("requestId"));
            finish(payload, new JSONObject().put("ok", true).put("state", "queued").put("queueId", "one")
                .put("queue", new JSONArray().put(entry("one", "queued"))).put("queueVersion", 2));
            assertFalse(((JSONObject) field("credentials")).has("pendingCommand"));
            assertNull(field("outgoingMessage")); assertTrue(input().isEnabled());
            assertNotNull(view("remoteQueue:one"));
            assertEquals(View.VISIBLE, view("remoteStop").getVisibility());
            input().setText("第二条消息"); assertTrue(view("remoteSend").isEnabled());
            field("commandBusy", true); invoke("updateControls"); assertFalse(view("remoteSend").isEnabled());
            assertFalse(view("remoteQueueRemove:one").isEnabled());
        });
    }

    public void testQueueSnapshotsDoNotResurrectRemovedMessagesAndOldComputersStayCompatible() {
        ui(() -> {
            snapshot(true, true, new JSONArray().put(entry("one", "queued")), 5);
            input().setText("Keep draft");
            snapshot(true, true, new JSONArray(), 7);
            JSONObject pendingPayload = new JSONObject().put("action", "queue-remove").put("requestId", "fixture");
            finish(pendingPayload, new JSONObject().put("ok", true).put("queueVersion", 6).put("queue", new JSONArray().put(entry("one", "queued"))));
            assertNull(view("remoteQueue:one")); assertEquals("Keep draft", input().getText().toString());
            snapshot(false, true, new JSONArray(), 8);
            assertFalse(view("remoteSend").isEnabled()); assertEquals(View.VISIBLE, view("remoteStop").getVisibility());
            snapshot(true, false, new JSONArray(), 9);
            // Goals and startup preparation can be busy without a live reply.
            field("displayedConversation", new JSONObject().put("activity", "running")); invoke("updateControls");
            assertTrue(view("remoteSend").isEnabled());
            field("editingSeq", 3L); invoke("updateControls"); assertFalse(view("remoteSend").isEnabled());
            field("editingSeq", -1L); field("connected", false); invoke("updateControls"); assertFalse(view("remoteSend").isEnabled());
        });
    }

    public void testPausedQueueCanResumeAndStartingMessageCannotBeRemoved() {
        ui(() -> {
            snapshot(true, true, new JSONArray().put(entry("one", "starting")).put(entry("two", "paused")), 3);
            assertFalse(view("remoteQueueRemove:one").isEnabled()); assertTrue(view("remoteQueueRemove:two").isEnabled());
            assertTrue(view("remoteQueueResume").isEnabled());
            input().setText("检查完成后再执行下一项");
            field("foreground", true); view("remoteQueueResume").performClick();
            JSONObject pending = ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload");
            assertEquals("queue-resume", pending.getString("action"));
            assertEquals("检查完成后再执行下一项", input().getText().toString());
            finish(pending, new JSONObject().put("ok", true).put("queue", new JSONArray().put(entry("two", "queued"))).put("queueVersion", 4));
            assertNull(view("remoteQueueResume"));
            view("remoteQueueRemove:two").performClick();
            pending = ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload");
            assertEquals("queue-remove", pending.getString("action")); assertEquals("two", pending.getString("queueId"));
        });
    }

    public void testQueuePreview() throws Exception {
        ui(() -> {
            snapshot(true, true, new JSONArray().put(entry("one", "queued")).put(entry("two", "queued")), 3);
            input().setText("任务完成后，把最终文件整理到一起");
        });
        getInstrumentation().waitForIdleSync();
        // Allow the page transition and the first surface frame to finish.
        android.os.SystemClock.sleep(600);
        ui(() -> {
            View queue = (View) field("queueBar");
            android.graphics.Rect bounds = new android.graphics.Rect();
            assertTrue(queue.getGlobalVisibleRect(bounds)); assertEquals(queue.getHeight(), bounds.height());
            for (String tag : new String[]{"remoteQueueEdit:one", "remoteQueueSteer:one"}) {
                android.widget.Button action = (android.widget.Button) view(tag);
                assertTrue(action.getGlobalVisibleRect(bounds)); assertEquals(action.getHeight(), bounds.height());
                assertEquals(1, action.getLineCount());
                assertTrue("Action label must fit on narrow screens", action.getPaint().measureText(action.getText().toString())
                    <= action.getWidth() - action.getPaddingLeft() - action.getPaddingRight());
            }
        });
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(screenshot);
        java.io.File target = new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null), "remote-queue.png");
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(target)) { screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); }
        screenshot.recycle();
    }

    public void testQueueEditAndSteerAvailabilityTracksRunConnectionAndStartingState() {
        ui(() -> {
            JSONArray queue = new JSONArray().put(entry("one", "queued")).put(entry("two", "starting"));
            snapshot(true, true, queue, 3);
            assertTrue(view("remoteQueueEdit:one").isEnabled()); assertTrue(view("remoteQueueSteer:one").isEnabled());
            assertFalse(view("remoteQueueEdit:two").isEnabled()); assertFalse(view("remoteQueueSteer:two").isEnabled());
            snapshot(true, false, queue, 3);
            assertTrue(view("remoteQueueEdit:one").isEnabled()); assertFalse(view("remoteQueueSteer:one").isEnabled());
            snapshot(true, true, queue, 3);
            assertTrue(view("remoteQueueSteer:one").isEnabled());
            field("connected", false); invoke("updateControls");
            assertFalse(view("remoteQueueEdit:one").isEnabled()); assertFalse(view("remoteQueueSteer:one").isEnabled());
            field("connected", true); field("controlAllowed", false); invoke("updateControls");
            assertFalse(view("remoteQueueEdit:one").isEnabled()); assertFalse(view("remoteQueueSteer:one").isEnabled());
        });
    }

    public void testSteeringJournalsSelectedQueueIdAndCurrentRunWithoutChangingComposer() {
        ui(() -> {
            snapshot(true, true, new JSONArray().put(entry("one", "queued")).put(entry("two", "queued")), 3);
            input().setText("保留正在输入的草稿");
            field("foreground", true); view("remoteQueueSteer:two").performClick();
            JSONObject pending = ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload");
            assertEquals("queue-steer", pending.getString("action")); assertEquals("two", pending.getString("queueId"));
            assertEquals(1, pending.getLong("runId")); assertEquals("保留正在输入的草稿", input().getText().toString());
            assertFalse(view("remoteQueueSteer:one").isEnabled());
            finish(pending, new JSONObject().put("ok", true).put("state", "accepted")
                .put("queue", new JSONArray().put(entry("one", "queued"))).put("queueVersion", 4));
            assertNull(view("remoteQueue:two")); assertNotNull(view("remoteQueue:one"));
            assertEquals("保留正在输入的草稿", input().getText().toString());
        });
    }

    private android.view.accessibility.AccessibilityNodeInfo accessibleText(String text) {
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            var root = getInstrumentation().getUiAutomation().getRootInActiveWindow();
            if (root != null) for (var node : root.findAccessibilityNodeInfosByText(text)) {
                if (text.equals(String.valueOf(node.getText()))) return node;
            }
            android.os.SystemClock.sleep(100);
        }
        fail("Missing accessible text: " + text); return null;
    }

    public void testQueueEditorSavesWithoutChangingDraftOrAttachmentsAndRetainsRejectedText() throws Exception {
        String original = entry("one", "queued").getString("text");
        ui(() -> {
            snapshot(true, true, new JSONArray().put(entry("one", "queued")), 3);
            input().setText("保留草稿"); field("foreground", true); view("remoteQueueEdit:one").performClick();
        });
        getInstrumentation().waitForIdleSync();
        android.os.Bundle value = new android.os.Bundle();
        value.putCharSequence(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "修改后的排队消息");
        assertTrue(accessibleText(original).performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, value));
        getInstrumentation().waitForIdleSync();
        assertTrue(accessibleText("保存").performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK));
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            JSONObject pending = ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload");
            assertEquals("queue-edit", pending.getString("action")); assertEquals("one", pending.getString("queueId"));
            assertEquals(original, pending.getString("expectedText")); assertEquals("修改后的排队消息", pending.getString("prompt"));
            assertEquals("保留草稿", input().getText().toString());
            assertEquals(1, ((JSONArray) field("remoteQueue")).getJSONObject(0).getJSONArray("attachments").length());
            finish(pending, new JSONObject().put("ok", false).put("state", "failed").put("error", "请检查后重试"));
            assertEquals("保留草稿", input().getText().toString());
        });
        getInstrumentation().waitForIdleSync();
        assertNotNull(accessibleText("修改后的排队消息"));
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(screenshot);
        java.io.File target = new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null), "remote-queue-editor.png");
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(target)) { screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); }
        screenshot.recycle();
        assertTrue(accessibleText("取消").performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK));
    }
}
