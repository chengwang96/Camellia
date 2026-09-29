package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONArray;
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

    public void testListKeepsStatusInlineWithLongTitleAboveFile() throws Exception {
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
                View headline = (View) title.getParent(), preview = (View) row.findViewWithTag("conversationFilePreview").getParent();
                assertTrue(preview.getTop() >= headline.getBottom());
            }
            assertEquals("移动端设计评审报告.pdf", ((TextView) row.findViewWithTag("conversationFilePreview")).getText().toString());
            assertTrue(row.getContentDescription().toString().contains("移动端设计评审报告.pdf"));
        });
    }

    public void testHealthyStatusMovesToHeaderButErrorsStayVisible() throws Exception {
        ui(() -> {
            detail(); TextView status = (TextView) field("status");
            status.setText("已连接 · 空闲"); assertEquals(View.GONE, status.getVisibility());
            assertEquals("空闲", ((TextView) root().findViewWithTag("headerConnectionState")).getText().toString());
            status.setText("正在重连，当前显示上次同步内容。"); assertEquals(View.VISIBLE, status.getVisibility()); assertEquals(1, status.getMaxLines());
            status.setText("操作待确认，请重试同一请求；不要重复发送。"); assertEquals(View.VISIBLE, status.getVisibility());
        });
    }

    public void testFilePreviewReadsLocalMetadataAndWorksWithOlderServers() throws Exception {
        assertNull(ConversationPreview.remote(new JSONObject().put("title", "Older server")));
        JSONObject chat = new JSONObject().put("messages", new JSONArray().put(new JSONObject().put("role", "user")
            .put("documents", new JSONArray().put(new JSONObject().put("name", "会议材料.pdf")))
            .put("images", new JSONArray().put("stored-image"))));
        ConversationPreview preview = ConversationPreview.local(chat, true);
        assertEquals("会议材料.pdf", preview.name); assertEquals(2, preview.count); assertFalse(preview.image);
        ConversationPreview safe = ConversationPreview.remote(new JSONObject().put("filePreview", new JSONObject().put("name", "C:\\private\\\u202ereport\n.pdf")));
        assertEquals("report.pdf", safe.name);
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
