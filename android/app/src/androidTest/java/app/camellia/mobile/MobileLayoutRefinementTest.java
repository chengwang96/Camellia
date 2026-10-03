package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONObject;

public class MobileLayoutRefinementTest extends InstrumentationTestCase {
    private MainActivity activity;
    private CredentialStore encrypted;
    private ComputerStore computers;
    private JSONObject first, second;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        encrypted = new CredentialStore(context, "layout-refinement-test"); encrypted.clear(); computers = new ComputerStore(encrypted);
        first = computer("http://100.64.0.11:43127", "Research laptop", "a");
        second = computer("http://100.64.0.12:43127", "Studio", "b");
        computers.save(second); computers.save(first);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> { invoke("stopNetwork"); field("store", computers); field("credentials", first); field("chinese", true); field("foreground", false); });
    }

    private JSONObject computer(String address, String name, String token) throws Exception {
        return new JSONObject().put("address", address).put("computerName", name).put("token", token.repeat(43));
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> activity.finish()); getInstrumentation().waitForIdleSync(); encrypted.clear(); super.tearDown();
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
    }
    private Object field(String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private void render(JSONObject live) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("renderMessages", JSONObject.class); method.setAccessible(true); method.invoke(activity, live);
    }
    private View root() { return activity.getWindow().getDecorView(); }
    private void detail() throws Exception { field("conversationId", "layout-chat"); field("conversationTitle", "移动端布局评审"); invoke("detailScreen"); }

    public void testSwitchingComputerPreservesDraftAndPendingRequest() throws Exception {
        ui(() -> { detail(); ((EditText) root().findViewWithTag("remoteComposer")).setText("尚未发送的修改意见"); field("editingSeq", 7L); });
        getInstrumentation().waitForIdleSync();
        ui(() -> root().findViewWithTag("remoteComputerPicker").performClick());
        getInstrumentation().waitForIdleSync(); screenshot("layout-computer-picker");
        ui(() -> {
            ComputerPickerPopup popup = (ComputerPickerPopup) field("computerPicker"); assertTrue(popup.isShowing());
            assertTrue(popup.panel.findViewWithTag("switchComputer:" + first.getString("address")).isSelected());
            assertNotNull(popup.panel.findViewWithTag("pickerAddComputer")); assertNotNull(popup.panel.findViewWithTag("pickerManageComputers"));
            JSONObject credentials = (JSONObject) field("credentials");
            credentials.put("pendingCommand", new JSONObject().put("requestId", "keep-this-id"));
            popup.panel.findViewWithTag("switchComputer:" + second.getString("address")).performClick();
            assertEquals(second.getString("address"), ((JSONObject) field("credentials")).getString("address"));
            assertEquals("list", field("screen")); assertFalse(popup.isShowing());
            JSONObject saved = computers.all().stream().filter(value -> value.optString("address").equals(first.optString("address"))).findFirst().get();
            assertEquals("尚未发送的修改意见", saved.getJSONObject("drafts").getString("layout-chat"));
            assertEquals(7, saved.getJSONObject("draftEdits").getInt("layout-chat"));
            assertEquals("keep-this-id", saved.getJSONObject("pendingCommand").getString("requestId"));
        });
    }

    public void testEmptyChatDisappearsForMessagesAndLiveOutput() throws Exception {
        ui(() -> {
            detail(); assertEquals(View.GONE, ((View) field("remoteEmptyState")).getVisibility());
            field("displayedConversation", new JSONObject().put("id", "layout-chat")); render(null);
            assertEquals(View.VISIBLE, ((View) field("remoteEmptyState")).getVisibility());
        });
        getInstrumentation().waitForIdleSync(); screenshot("layout-empty-chat");
        ui(() -> {
            render(new JSONObject().put("text", "正在处理").put("runId", "live"));
            assertEquals(View.GONE, ((View) field("remoteEmptyState")).getVisibility());
            @SuppressWarnings("unchecked") java.util.Map<Long, JSONObject> history = (java.util.Map<Long, JSONObject>) field("history");
            history.put(1L, new JSONObject().put("role", "user").put("seq", 1).put("text", "开始工作")); render(null);
            assertEquals(View.GONE, ((View) field("remoteEmptyState")).getVisibility());
        });
    }

    public void testListKeepsStatusInlineWithLongTitleWithoutFilePreview() throws Exception {
        ui(() -> {
            invoke("listScreen"); field("canCreate", true); field("allowIndependent", true);
            @SuppressWarnings("unchecked") java.util.Map<String, JSONObject> rows = (java.util.Map<String, JSONObject>) field("conversations");
            rows.put("layout-chat", new JSONObject().put("id", "layout-chat").put("title", "整理项目设计方案与移动端功能对照评审记录")
                .put("activity", "running").put("pinned", true).put("lastReplyAt", 1000)
                .put("filePreview", new JSONObject().put("name", "移动端设计评审报告.pdf").put("count", 2)));
            invoke("renderConversations");
        });
        getInstrumentation().waitForIdleSync(); screenshot("layout-conversation-list");
        ui(() -> {
            View row = root().findViewWithTag("conversation:layout-chat");
            TextView title = row.findViewWithTag("conversationRowTitle"), state = row.findViewWithTag("conversationStatus:layout-chat");
            for (int width : new int[]{280, 320, 360}) {
                row.measure(View.MeasureSpec.makeMeasureSpec(Math.round(width * activity.getResources().getDisplayMetrics().density), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                row.layout(0, 0, row.getMeasuredWidth(), row.getMeasuredHeight());
                assertTrue(title.getWidth() > 0);
                assertEquals(1, title.getLineCount()); assertEquals(1, state.getLineCount());
                assertTrue(title.getRight() <= state.getLeft());
                assertTrue(Math.abs(title.getTop() + title.getHeight() / 2 - state.getTop() - state.getHeight() / 2) <= 1);
            }
            assertNull(row.findViewWithTag("conversationFilePreview"));
            assertFalse(row.getContentDescription().toString().contains("移动端设计评审报告.pdf"));
        });
    }

    public void testConnectionAndWorkStatusStaySeparateWithAStableFooterHeight() throws Exception {
        ui(() -> {
            detail(); TextView status = (TextView) field("status");
            field("connected", true); field("controlAllowed", true); invoke("updateControls");
            TextView header = root().findViewWithTag("headerConnectionState");
            assertEquals("已连接", header.getText().toString()); assertEquals("就绪", status.getText().toString());
            int height = statusHeight(status);
            field("lastLive", new JSONObject().put("text", "reply")); invoke("updateControls");
            assertEquals("正在回复…", status.getText().toString()); assertEquals(height, statusHeight(status));
            assertEquals("已连接", header.getText().toString());
            field("remoteCompaction", new JSONObject().put("state", "running")); invoke("updateControls");
            assertEquals("正在压缩上下文…", status.getText().toString()); assertEquals(height, statusHeight(status));
            field("lastLive", null); field("remoteCompaction", new JSONObject().put("state", "completed")); invoke("updateControls");
            assertEquals("就绪", status.getText().toString()); assertEquals(height, statusHeight(status));
            assertEquals(View.VISIBLE, status.getVisibility()); assertEquals(1, status.getMaxLines());
        });
    }

    public void testStatusFailureSurvivesSyncAndKeepsDetailsClickable() throws Exception {
        ui(() -> {
            detail(); field("connected", true); field("controlAllowed", true); invoke("updateControls");
            var failure = MainActivity.class.getDeclaredMethod("setStatusError", String.class); failure.setAccessible(true);
            failure.invoke(activity, "发送未确认：网络超时\n保留同一请求 ID");
            field("lastLive", new JSONObject().put("text", "reply")); invoke("updateControls");
            TextView status = (TextView) field("status");
            assertTrue(status.getText().toString().startsWith("发送未确认")); assertTrue(status.isClickable());
            assertEquals("已连接", ((TextView) root().findViewWithTag("headerConnectionState")).getText().toString());
            ((ChatStatusLine) field("workStatus")).clear(); invoke("updateControls");
            assertEquals("正在回复…", status.getText().toString());
        });
    }

    private int statusHeight(TextView status) {
        status.measure(View.MeasureSpec.makeMeasureSpec(280, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        return status.getMeasuredHeight();
    }

    private void screenshot(String name) throws Exception {
        ui(() -> ((PageTransitions) field("pages")).finishTransition());
        getInstrumentation().waitForIdleSync();
        getInstrumentation().getUiAutomation().waitForIdle(150, 3000);
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }
}
