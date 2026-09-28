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
            field("credentials", credentials); field("chinese", true);
            field("conversationId", "automation-test");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
        });
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> activity.finish());
        getInstrumentation().waitForIdleSync();
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
        var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
        JSONObject snapshot = new JSONObject().put("instanceId", "test").put("cursor", 1)
            .put("conversation", new JSONObject().put("id", "automation-test").put("title", "自动化"))
            .put("messages", new JSONArray());
        if (automation != null) snapshot.put("automation", automation);
        apply.invoke(activity, snapshot);
    }

    private ViewGroup bar() { return activity.getWindow().getDecorView().findViewWithTag("remoteAutomation"); }

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
