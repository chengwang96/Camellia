package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

// The phone shows the goal and scheduled-task state the desktop already reports
// in its snapshot, and pauses or resumes them with the existing commands.
public class RemoteAutomationTest extends InstrumentationTestCase {
    private MainActivity activity;
    private JSONObject credentials;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        context.getSharedPreferences("remote-status-test", 0).edit().clear().commit();
        credentials = new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "test");
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            var stop = MainActivity.class.getDeclaredMethod("stopNetwork"); stop.setAccessible(true); stop.invoke(activity);
            field("credentials", credentials); field("chinese", true); field("foreground", false);
            field("conversationId", "automation-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
        });
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> activity.finish());
        getInstrumentation().waitForIdleSync();
        // onStop persists drafts. Finish the old fixture's lifecycle before
        // another test writes its own credentials and pending command.
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (!activity.isDestroyed() && android.os.SystemClock.uptimeMillis() < deadline) android.os.SystemClock.sleep(20);
        assertTrue("Automation fixture activity did not finish", activity.isDestroyed());
        super.tearDown();
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
    }

    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }

    private void render(JSONObject automation) throws Exception {
        render(automation, new JSONArray());
    }

    private void render(JSONObject automation, JSONArray rows) throws Exception {
        render(automation, rows, null, "control");
    }

    private void render(JSONObject automation, JSONArray rows, JSONObject live, String permission) throws Exception {
        var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
        JSONObject snapshot = new JSONObject().put("instanceId", "test").put("cursor", 1)
            .put("conversation", new JSONObject().put("id", "automation-test").put("title", "自动化"))
            .put("messages", rows).put("nextBefore", JSONObject.NULL).put("permission", permission);
        if (live != null) snapshot.put("live", live);
        if (automation != null) snapshot.put("automation", automation);
        apply.invoke(activity, snapshot);
    }

    private ViewGroup bar() { return activity.getWindow().getDecorView().findViewWithTag("remoteAutomation"); }

    private android.app.Dialog workSheet() throws Exception {
        var member = MainActivity.class.getDeclaredField("workDialog"); member.setAccessible(true);
        return (android.app.Dialog) member.get(activity);
    }

    private View openWorkSheet() throws Exception {
        assertNull(activity.getWindow().getDecorView().findViewWithTag("remoteWorkSummary"));
        TextView footer = activity.getWindow().getDecorView().findViewWithTag("connectionStatus");
        assertTrue(footer.isShown());
        assertTrue(footer.getText().toString().contains("目标") || footer.getText().toString().contains("定时任务"));
        assertTrue(footer.performClick());
        assertTrue(workSheet().isShowing());
        return workSheet().getWindow().getDecorView();
    }

    public void testWorkSheetShowsRootGoalDuringLiveTurnAndUpdatesInPlace() {
        ui(() -> {
            String objective = "核对原文后建立从零起转的十秒脚本基线，保存每一步证据与进度，随后验证因果反馈和扰动恢复。";
            JSONObject goal = new JSONObject().put("id", "live-goal").put("objective", objective)
                .put("phase", "active").put("armed", true).put("roundsStarted", 3);
            JSONObject automation = new JSONObject().put("goal", goal);
            JSONObject live = new JSONObject().put("runId", 3).put("text", "正在核对原文");
            render(automation, new JSONArray(), live, "control");
            View sheet = openWorkSheet();
            TextView detail = sheet.findViewWithTag("remoteGoalObjective");
            assertNotNull("The summary must open the goal from snapshot.automation, not live.automation", detail);
            assertEquals(objective, detail.getText().toString());
            assertEquals(Integer.MAX_VALUE, detail.getMaxLines());
            assertEquals("目标进行中", ((TextView) sheet.findViewWithTag("remoteGoalState")).getText().toString());
            assertTrue(sheet.findViewWithTag("remoteGoalToggle").isEnabled());
            live.put("text", "原文核对仍在进行");
            render(automation, new JSONArray(), live, "control");
            assertSame("Live text updates must preserve selectable goal content", detail, sheet.findViewWithTag("remoteGoalObjective"));
            goal.put("phase", "paused").put("armed", false);
            render(automation, new JSONArray(), null, "control");
            assertTrue(workSheet().isShowing());
            assertEquals("目标已暂停", ((TextView) sheet.findViewWithTag("remoteGoalState")).getText().toString());
            assertEquals("恢复", ((TextView) sheet.findViewWithTag("remoteGoalToggle")).getText().toString());
            render(automation, new JSONArray(), null, "view");
            assertFalse("Read-only devices cannot control the goal", sheet.findViewWithTag("remoteGoalToggle").isEnabled());
            render(null);
            assertNull("Removing automation must clear an open sheet", sheet.findViewWithTag("remoteGoal"));
            assertEquals("就绪", ((TextView) activity.getWindow().getDecorView().findViewWithTag("connectionStatus")).getText().toString());
        });
    }

    public void testFooterCombinesLiveGoalScheduledAndBackgroundWork() {
        ui(() -> {
            JSONObject automation = new JSONObject().put("goal", new JSONObject().put("id", "footer-goal")
                .put("objective", "核对测试结果").put("phase", "active").put("armed", true))
                .put("tasks", new JSONArray().put(new JSONObject().put("id", "footer-task")
                    .put("instruction", "检查构建").put("status", "scheduled").put("intervalMinutes", 10)));
            render(automation, new JSONArray(), new JSONObject().put("runId", 7).put("text", "正在核对"), "control");
            field("displayedConversation", new JSONObject().put("id", "automation-test").put("activity", "running").put("backgroundTaskCount", 2));
            var update = MainActivity.class.getDeclaredMethod("updateControls"); update.setAccessible(true); update.invoke(activity);
            TextView footer = activity.getWindow().getDecorView().findViewWithTag("connectionStatus");
            assertEquals("正在回复… · 目标进行中 · 定时任务 1 · 后台任务 2  ›", footer.getText().toString());
            assertEquals(1, footer.getMaxLines());
            View sheet = openWorkSheet();
            assertNotNull(sheet.findViewWithTag("remoteGoalObjective"));
            assertNotNull(sheet.findViewWithTag("remoteTask"));
        });
    }

    public void testWorkSheetShowsWaitingGoalWithoutLiveTurn() throws Exception {
        ui(() -> {
            render(new JSONObject().put("goal", new JSONObject().put("id", "waiting-sheet")
                .put("objective", "完成十秒基线验证后，继续因果反馈和扰动恢复研究，并保存可复查的进度。")
                .put("phase", "active").put("armed", true).put("waiting", new JSONObject()
                    .put("reason", "仿真仍在运行，等待结果后继续核对。").put("until", System.currentTimeMillis() + 120000))));
            View sheet = openWorkSheet();
            assertNotNull(sheet.findViewWithTag("remoteGoalObjective"));
            assertEquals("目标等待中", ((TextView) sheet.findViewWithTag("remoteGoalState")).getText().toString());
            assertNotNull(sheet.findViewWithTag("remoteGoalWaitingReason"));
            assertNotNull(sheet.findViewWithTag("remoteGoalNextCheck"));
            assertEquals("暂停", ((TextView) sheet.findViewWithTag("remoteGoalToggle")).getText().toString());
        });
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(300);
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, "goal-work-sheet.png"))) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally { screenshot.recycle(); }
    }

    public void testWorkSheetKeepsTasksButDoesNotReviveAnOldCompletedGoal() {
        ui(() -> {
            JSONObject task = new JSONObject().put("id", "task-sheet").put("instruction", "每十分钟检查构建与测试结果，失败时保留完整日志。")
                .put("status", "scheduled").put("intervalMinutes", 10);
            JSONObject automation = new JSONObject().put("goal", new JSONObject().put("id", "old-goal")
                .put("objective", "旧目标").put("phase", "complete").put("completedAt", 2000))
                .put("tasks", new JSONArray().put(task));
            render(automation, new JSONArray().put(message(1, "user", 3000)));
            View sheet = openWorkSheet();
            assertNull(sheet.findViewWithTag("remoteGoal"));
            assertEquals(task.optString("instruction"), ((TextView) sheet.findViewWithTag("remoteTaskInstruction")).getText().toString());
            assertEquals("暂停", ((TextView) sheet.findViewWithTag("remoteTaskToggle")).getText().toString());
            task.put("status", "paused"); render(automation);
            assertEquals("恢复", ((TextView) sheet.findViewWithTag("remoteTaskToggle")).getText().toString());
            var rebuild = MainActivity.class.getDeclaredMethod("rebuildDetailForConfiguration"); rebuild.setAccessible(true); rebuild.invoke(activity);
            assertNull("Rebuilding the page must dismiss its old sheet", workSheet());
            sheet = openWorkSheet();
            assertNotNull("Retained automation must survive a layout rebuild", sheet.findViewWithTag("remoteTask"));
            assertNull(sheet.findViewWithTag("remoteGoal"));
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            assertNull(workSheet());
            render(null);
            assertEquals("就绪", ((TextView) activity.getWindow().getDecorView().findViewWithTag("connectionStatus")).getText().toString());
        });
    }

    private JSONObject message(long seq, String role, long at) throws Exception {
        return new JSONObject().put("seq", seq).put("role", role).put("at", at).put("text", "会话内容 " + seq);
    }

    public void testCompletedGoalDisappearsAfterNewUserMessageAndStaysHiddenOnReopen() {
        ui(() -> {
            JSONObject automation = new JSONObject().put("goal", new JSONObject().put("id", "goal-1")
                .put("objective", "完成季度报告").put("phase", "complete").put("completedAt", 2000));
            JSONArray rows = new JSONArray().put(message(1, "user", 1000)).put(message(2, "assistant", 2000));
            render(automation, rows);
            assertNotNull(bar().findViewWithTag("remoteGoal"));
            // Drafts, failed/unconfirmed sends, and assistant-only updates are
            // not a later user turn in the confirmed transcript.
            var composer = MainActivity.class.getDeclaredField("composer"); composer.setAccessible(true);
            ((android.widget.EditText) composer.get(activity)).setText("下一项任务的草稿");
            field("outgoingMessage", new JSONObject().put("conversationId", "automation-test").put("delivery", "failed")
                .put("payload", new JSONObject().put("action", "send").put("requestId", "failed-send").put("prompt", "下一项任务")));
            rows.put(message(3, "assistant", 2500)); render(automation, rows);
            assertNotNull(bar().findViewWithTag("remoteGoal"));
            field("outgoingMessage", null);
            rows.put(message(4, "user", 3000)); render(automation, rows);
            assertEquals(View.GONE, bar().getVisibility());
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            render(automation, rows);
            assertEquals(View.GONE, bar().getVisibility());
            // A distinct goal with the same objective still gets its notice.
            automation.getJSONObject("goal").put("id", "goal-2").put("completedAt", 4000);
            render(automation, rows);
            assertNotNull(bar().findViewWithTag("remoteGoal"));
        });
    }

    public void testLegacyCompletionDoesNotReturnAndTasksRemainVisible() {
        ui(() -> {
            JSONObject goal = new JSONObject().put("objective", "完成季度报告").put("phase", "complete");
            JSONObject automation = new JSONObject().put("goal", goal).put("tasks", new JSONArray()
                .put(new JSONObject().put("id", "t1").put("instruction", "检查日志").put("status", "paused").put("intervalMinutes", 10)));
            JSONArray rows = new JSONArray().put(message(1, "user", 1000));
            render(automation, rows);
            assertNull(bar().findViewWithTag("remoteGoal"));
            assertNotNull(bar().findViewWithTag("remoteTask"));
            goal.put("phase", "active").put("armed", true); render(automation, rows);
            goal.put("phase", "complete").put("armed", false); render(automation, rows);
            assertNotNull(bar().findViewWithTag("remoteGoal"));
            rows.put(message(2, "user", 2000)); render(automation, rows);
            assertNull(bar().findViewWithTag("remoteGoal"));
            assertEquals(View.VISIBLE, bar().getVisibility());
            assertEquals("恢复", ((TextView) bar().findViewWithTag("remoteTaskToggle")).getText().toString());
        });
    }

    public void testNewMessagesKeepUnfinishedGoalControls() {
        ui(() -> {
            JSONObject goal = new JSONObject().put("id", "goal-1").put("objective", "完成季度报告").put("phase", "active").put("armed", true);
            JSONObject automation = new JSONObject().put("goal", goal);
            JSONArray rows = new JSONArray().put(message(1, "user", 1000));
            render(automation, rows);
            rows.put(message(2, "user", 3000)); render(automation, rows);
            assertEquals("暂停", ((TextView) bar().findViewWithTag("remoteGoalToggle")).getText().toString());
            goal.put("phase", "blocked").put("armed", false); render(automation, rows);
            assertEquals("恢复", ((TextView) bar().findViewWithTag("remoteGoalToggle")).getText().toString());
        });
    }

    public void testGoalStateIsVisibleWithItsObjective() {
        ui(() -> {
            render(new JSONObject().put("goal", new JSONObject()
                .put("objective", "完成季度报告").put("phase", "active").put("armed", true).put("roundsStarted", 2)));
            assertEquals(View.VISIBLE, bar().getVisibility());
            View card = bar().findViewWithTag("remoteGoal");
            assertNotNull(card);
            assertEquals("目标进行中", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertEquals("完成季度报告", ((TextView) card.findViewWithTag("remoteGoalObjective")).getText().toString());
            // A running goal offers Pause; the label must match the state.
            TextView toggle = card.findViewWithTag("remoteGoalToggle");
            assertNotNull(toggle);
            assertEquals("暂停", toggle.getText().toString());
            assertTrue(toggle.hasOnClickListeners());
        });
    }

    public void testPausedAndBlockedGoalsOfferResumeAndCompletedGoalsDoNotAct() {
        ui(() -> {
            render(new JSONObject().put("goal", new JSONObject()
                .put("objective", "完成季度报告").put("phase", "active").put("armed", false)));
            View card = bar().findViewWithTag("remoteGoal");
            assertEquals("目标已暂停", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertEquals("恢复", ((TextView) card.findViewWithTag("remoteGoalToggle")).getText().toString());
            // The real pause command and reopening a saved Goal use phase=paused.
            render(new JSONObject().put("goal", new JSONObject()
                .put("objective", "完成季度报告").put("phase", "paused").put("armed", false)));
            card = bar().findViewWithTag("remoteGoal");
            assertEquals("目标已暂停", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertEquals("恢复", ((TextView) card.findViewWithTag("remoteGoalToggle")).getText().toString());
            assertTrue(card.findViewWithTag("remoteGoalToggle").hasOnClickListeners());
            render(new JSONObject().put("goal", new JSONObject()
                .put("objective", "完成季度报告").put("phase", "blocked").put("armed", false)));
            card = bar().findViewWithTag("remoteGoal");
            assertEquals("目标受阻", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertEquals("恢复", ((TextView) card.findViewWithTag("remoteGoalToggle")).getText().toString());
            // A finished goal is reported, never toggled.
            render(new JSONObject().put("goal", new JSONObject()
                .put("objective", "完成季度报告").put("phase", "complete").put("armed", false)));
            card = bar().findViewWithTag("remoteGoal");
            assertEquals("目标已完成", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertNull(card.findViewWithTag("remoteGoalToggle"));
        });
    }

    public void testWaitingGoalShowsDetailsAndClearsThemWhenPausedOrRunningAgain() {
        ui(() -> {
            long until = System.currentTimeMillis() + 120000;
            JSONObject goal = new JSONObject().put("id", "waiting-goal").put("objective", "等待构建完成")
                .put("phase", "active").put("armed", true).put("waiting", new JSONObject()
                    .put("reason", "构建仍在运行，请等待下一次检查。").put("until", until));
            JSONObject automation = new JSONObject().put("goal", goal);
            render(automation);
            View card = bar().findViewWithTag("remoteGoal");
            assertEquals("目标等待中", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertEquals("构建仍在运行，请等待下一次检查。", ((TextView) card.findViewWithTag("remoteGoalWaitingReason")).getText().toString());
            String date = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT,
                java.util.Locale.SIMPLIFIED_CHINESE).format(new java.util.Date(until));
            assertEquals("下次检查：" + date, ((TextView) card.findViewWithTag("remoteGoalNextCheck")).getText().toString());
            assertEquals("暂停", ((TextView) card.findViewWithTag("remoteGoalToggle")).getText().toString());
            field("chinese", false); render(automation);
            card = bar().findViewWithTag("remoteGoal");
            assertEquals("Goal waiting", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertTrue(((TextView) card.findViewWithTag("remoteGoalNextCheck")).getText().toString().startsWith("Next check: "));
            field("chinese", true);
            goal.put("phase", "paused").put("armed", false); render(automation);
            card = bar().findViewWithTag("remoteGoal");
            assertEquals("恢复", ((TextView) card.findViewWithTag("remoteGoalToggle")).getText().toString());
            assertNull(card.findViewWithTag("remoteGoalWaitingReason")); assertNull(card.findViewWithTag("remoteGoalNextCheck"));
            goal.remove("waiting"); goal.put("phase", "active").put("armed", true); render(automation);
            card = bar().findViewWithTag("remoteGoal");
            assertEquals("目标进行中", ((TextView) card.findViewWithTag("remoteGoalState")).getText().toString());
            assertNull(card.findViewWithTag("remoteGoalWaitingReason")); assertNull(card.findViewWithTag("remoteGoalNextCheck"));
        });
    }

    public void testScheduledTaskOffersPauseBetweenChecksAndResumeAfterPausing() {
        ui(() -> {
            JSONObject task = new JSONObject().put("id", "scheduled-task").put("instruction", "检查构建")
                .put("status", "scheduled").put("intervalMinutes", 10);
            JSONObject automation = new JSONObject().put("tasks", new JSONArray().put(task));
            render(automation);
            View card = bar().findViewWithTag("remoteTask");
            assertEquals("等待", ((TextView) card.findViewWithTag("remoteTaskState")).getText().toString());
            assertEquals("暂停", ((TextView) card.findViewWithTag("remoteTaskToggle")).getText().toString());
            assertTrue(card.findViewWithTag("remoteTaskToggle").hasOnClickListeners());
            task.put("status", "paused"); render(automation);
            card = bar().findViewWithTag("remoteTask");
            assertEquals("恢复", ((TextView) card.findViewWithTag("remoteTaskToggle")).getText().toString());
            task.put("status", "complete"); render(automation);
            assertNull(bar().findViewWithTag("remoteTaskToggle"));
        });
    }

    public void testScheduledTasksAreListedWithTheirIntervalAndControls() {
        ui(() -> {
            render(new JSONObject().put("tasks", new JSONArray()
                .put(new JSONObject().put("id", "t1").put("instruction", "检查训练日志").put("status", "running").put("intervalMinutes", 10))
                .put(new JSONObject().put("id", "t2").put("instruction", "核对指标").put("status", "paused").put("intervalMinutes", 30))));
            assertEquals(View.VISIBLE, bar().getVisibility());
            ViewGroup bar = bar();
            int tasks = 0;
            for (int index = 0; index < bar.getChildCount(); index++) {
                View child = bar.getChildAt(index);
                if (child.getTag() != null && child.getTag().toString().equals("remoteTask")) tasks++;
            }
            assertEquals(2, tasks);
            // A running task pauses, a paused one resumes.
            View first = null, second = null;
            for (int index = 0; index < bar.getChildCount(); index++) {
                View child = bar.getChildAt(index);
                if (child.getTag() != null && child.getTag().toString().equals("remoteTask")) {
                    if (first == null) first = child; else second = child;
                }
            }
            assertEquals("检查中", ((TextView) first.findViewWithTag("remoteTaskState")).getText().toString());
            assertEquals("暂停", ((TextView) first.findViewWithTag("remoteTaskToggle")).getText().toString());
            assertEquals("已暂停", ((TextView) second.findViewWithTag("remoteTaskState")).getText().toString());
            assertEquals("恢复", ((TextView) second.findViewWithTag("remoteTaskToggle")).getText().toString());
        });
    }

    public void testNoAutomationLeavesTheBarHidden() {
        ui(() -> {
            render(null);
            assertEquals(View.GONE, bar().getVisibility());
            render(new JSONObject().put("goal", JSONObject.NULL).put("tasks", new JSONArray()));
            assertEquals(View.GONE, bar().getVisibility());
        });
    }
}
