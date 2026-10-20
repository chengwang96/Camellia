package app.camellia.mobile;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

public class SubtaskPageLayoutTest extends InstrumentationTestCase {
    private MainActivity activity;
    private SubtaskPage page;
    private String previousTheme, previousLanguage;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        previousTheme = MobilePreferences.get(context, "theme"); previousLanguage = MobilePreferences.get(context, "language");
    }
    @Override protected void tearDown() throws Exception {
        finish();
        var context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "theme", previousTheme); MobilePreferences.set(context, "language", previousLanguage);
        super.tearDown();
    }
    private void finish() {
        getInstrumentation().runOnMainSync(() -> { if (page != null) page.dismiss(); if (activity != null) activity.finish(); });
        getInstrumentation().waitForIdleSync(); page = null; activity = null;
    }
    private void open(boolean chinese, boolean dark, JSONArray tasks) {
        var context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "theme", dark ? "dark" : "light"); MobilePreferences.set(context, "language", chinese ? "zh-CN" : "en");
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().runOnMainSync(() -> { page = new SubtaskPage(activity, chinese, 1L, null, (task, operation, extra) -> {}); page.update(tasks); page.show(); });
        getInstrumentation().waitForIdleSync();
    }
    private JSONArray tasks() throws Exception {
        return new JSONArray()
            .put(task("worker-1", "codex", "running", "正在检查任务范围与当前执行进展"))
            .put(task("worker-2", "codex", "waiting", "等待确认后继续执行"))
            .put(task("worker-3", "codex", "completed", "已完成检查，结果已同步到主会话"));
    }
    private JSONObject task(String id, String engine, String status, String progress) throws Exception {
        return new JSONObject().put("id", id).put("engine", engine).put("userSeq", 1L)
            .put("title", "v3 native scope worker " + id.replace("worker-", "w") + " continuation")
            .put("goal", "检查子任务的执行范围，并将检查结果同步到主会话。")
            .put("progress", progress).put("result", status.equals("completed") ? progress : "")
            .put("status", status).put("canReply", true).put("canStop", status.equals("running"))
            .put("turnId", "turn-" + id);
    }
    private View root() { return page.getWindow().getDecorView(); }
    private void click(String identity) {
        getInstrumentation().runOnMainSync(() -> root().findViewWithTag("subtaskCard:" + identity).performClick());
        getInstrumentation().waitForIdleSync();
    }
    private void back() { getInstrumentation().runOnMainSync(page::onBackPressed); getInstrumentation().waitForIdleSync(); }
    private void assertInside(View child, View parent) {
        int[] childAt = new int[2], parentAt = new int[2]; child.getLocationOnScreen(childAt); parent.getLocationOnScreen(parentAt);
        assertTrue("View must have a visible width", child.getWidth() > 0);
        assertTrue("Content must fit the left edge", childAt[0] >= parentAt[0]);
        assertTrue("Content must fit the right edge", childAt[0] + child.getWidth() <= parentAt[0] + parent.getWidth());
    }
    private void capture(String name) throws Exception {
        getInstrumentation().waitForIdleSync();
        // UI-thread idleness precedes SurfaceFlinger's presentation of the new window/frame.
        getInstrumentation().getUiAutomation().waitForIdle(200, 3000);
        android.os.SystemClock.sleep(200);
        Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (FileOutputStream output = new FileOutputStream(new File(activity.getExternalFilesDir(null), name + ".png"))) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { bitmap.recycle(); }
    }
    private void assertListLayout() {
        getInstrumentation().runOnMainSync(() -> {
            for (String id : new String[]{"worker-1", "worker-2", "worker-3"}) {
                LinearLayout card = root().findViewWithTag("subtaskCard:codex:" + id); assertNotNull(card); assertInside(card, root());
                TextView title = card.findViewWithTag("subtaskCardTitle"); assertInside(title, card);
                assertTrue("Long names should wrap", title.getLineCount() > 1);
                assertTrue("The entire card is a touch target", card.isClickable() && card.isFocusable());
                LinearLayout metadata = (LinearLayout) card.getChildAt(0);
                assertInside(metadata.getChildAt(1), card); assertInside(metadata.getChildAt(2), card);
            }
            assertFalse(root().findViewWithTag("subtaskControls").isShown());
            assertTrue(((TextView) root().findViewWithTag("subtaskSummary")).getText().toString().contains("3"));
        });
    }
    public void testChinesePhoneLayoutAndPinnedReply() throws Exception {
        open(true, false, tasks()); assertListLayout(); capture("subtask-list-zh"); click("codex:worker-1");
        getInstrumentation().runOnMainSync(() -> {
            EditText reply = root().findViewWithTag("subtaskReply"); Rect visible = new Rect();
            assertTrue("Reply stays visible without scrolling through the task", reply.getGlobalVisibleRect(visible));
            assertEquals(reply.getHeight(), visible.height());
            assertInside(reply, root());
        });
        capture("subtask-detail-zh"); back(); click("codex:worker-2"); back(); assertListLayout();
    }
    public void testEnglishAndDarkPhoneLayouts() throws Exception {
        JSONArray english = tasks();
        for (int i = 0; i < english.length(); i++) {
            english.getJSONObject(i).put("goal", "Review this task and send the findings to the parent conversation.")
                .put("progress", "Reviewing the current scope and execution progress");
        }
        open(false, false, english); assertListLayout(); capture("subtask-list-en"); finish();
        open(true, true, tasks()); assertListLayout(); capture("subtask-list-dark"); click("codex:worker-1"); capture("subtask-detail-dark");
    }
    public void testDraftsStayWithTheirEngineWhenNavigatingTheList() throws Exception {
        JSONArray tasks = new JSONArray().put(task("shared", "codex", "running", "First task"))
            .put(task("shared", "claude", "running", "Second task")); open(false, false, tasks);
        click("codex:shared"); getInstrumentation().runOnMainSync(() -> ((EditText) root().findViewWithTag("subtaskReply")).setText("Codex draft")); back();
        click("claude:shared"); getInstrumentation().runOnMainSync(() -> {
            EditText reply = root().findViewWithTag("subtaskReply"); assertEquals("", reply.getText().toString()); reply.setText("Claude draft");
        }); back(); click("codex:shared");
        getInstrumentation().runOnMainSync(() -> assertEquals("Codex draft", ((EditText) root().findViewWithTag("subtaskReply")).getText().toString()));
        back(); click("claude:shared");
        getInstrumentation().runOnMainSync(() -> assertEquals("Claude draft", ((EditText) root().findViewWithTag("subtaskReply")).getText().toString()));
    }
    public void testUpdatesPreserveListPositionAndRespectTheParentTurn() throws Exception {
        JSONArray many = new JSONArray(); for (int i = 0; i < 20; i++) many.put(task("child-" + i, "codex", "running", "Reading tests"));
        many.put(task("unrelated", "codex", "running", "Other turn").put("userSeq", 2L)); open(false, false, many);
        getInstrumentation().runOnMainSync(() -> {
            assertNull(root().findViewWithTag("subtaskCard:codex:unrelated"));
            ScrollView scroll = root().findViewWithTag("subtaskScroll"); scroll.scrollTo(0, 400); assertEquals(400, scroll.getScrollY());
            page.update(many); assertEquals(400, scroll.getScrollY());
            try { many.getJSONObject(0).put("progress", "New progress"); } catch (Exception error) { throw new AssertionError(error); }
            page.update(many);
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> assertEquals(400, ((ScrollView) root().findViewWithTag("subtaskScroll")).getScrollY()));
    }
    public void testCompletedAndEmptyTasksDoNotLeaveDeadControls() throws Exception {
        JSONArray tasks = new JSONArray().put(task("complete", "codex", "completed", "Finished").put("goal", "").put("canReply", false));
        open(true, false, tasks); click("codex:complete");
        getInstrumentation().runOnMainSync(() -> {
            assertFalse(root().findViewWithTag("subtaskControls").isShown());
            page.update(new JSONArray()); assertTrue(root().findViewWithTag("subtaskEmpty").isShown());
            assertFalse(root().findViewWithTag("subtaskControls").isShown());
        });
    }
    public void testLongDetailsKeepReplyAboveTheKeyboard() throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 30) return;
        JSONArray tasks = tasks(); tasks.getJSONObject(0).put("progress", "正在检查执行记录与测试结果。\n".repeat(60));
        open(true, false, tasks); click("codex:worker-1");
        getInstrumentation().runOnMainSync(() -> {
            ScrollView scroll = root().findViewWithTag("subtaskScroll"); assertTrue(scroll.canScrollVertically(1));
            EditText reply = root().findViewWithTag("subtaskReply"); reply.requestFocus(); reply.setText("检查任务结果");
            var keyboard = (android.view.inputmethod.InputMethodManager) activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
            keyboard.showSoftInput(reply, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        });
        boolean[] visible = {false}; long deadline = android.os.SystemClock.uptimeMillis() + 3000;
        do {
            getInstrumentation().runOnMainSync(() -> visible[0] = root().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
            if (!visible[0]) android.os.SystemClock.sleep(50);
        } while (!visible[0] && android.os.SystemClock.uptimeMillis() < deadline);
        assertTrue("The keyboard must be open for this check", visible[0]); getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            EditText reply = root().findViewWithTag("subtaskReply"); Rect bounds = new Rect(); assertTrue(reply.getGlobalVisibleRect(bounds));
            int keyboardTop = activity.getWindowManager().getCurrentWindowMetrics().getBounds().bottom
                - root().getRootWindowInsets().getInsets(android.view.WindowInsets.Type.ime()).bottom;
            assertTrue("The reply must sit above the keyboard", bounds.bottom <= keyboardTop);
            page.update(tasks); assertEquals("检查任务结果", reply.getText().toString());
        });
        capture("subtask-detail-keyboard");
    }
}
