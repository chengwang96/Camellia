package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.widget.EditText;
import android.widget.ScrollView;
import org.json.*;

public class RemoteSubtaskTest extends InstrumentationTestCase {
    private Object field(Object target, String name) throws Exception {
        var member = target.getClass().getDeclaredField(name); member.setAccessible(true); return member.get(target);
    }
    private void field(Object target, String name, Object value) throws Exception {
        var member = target.getClass().getDeclaredField(name); member.setAccessible(true); member.set(target, value);
    }
    private JSONObject task() throws Exception {
        return new JSONObject().put("id", "child-1").put("engine", "codex").put("userSeq", 1)
            .put("title", "Review the report").put("goal", "Check the result").put("progress", "Reading tests")
            .put("status", "running").put("turnId", "child-turn").put("canReply", true).put("canStop", true);
    }
    private MainActivity start() {
        var context = getInstrumentation().getTargetContext();
        return (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
    public void testChildPageKeepsParentDraftAndReadingPosition() throws Exception {
        MainActivity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field(activity, "conversationId", "12345678-1234-1234-1234-123456789abc");
                    field(activity, "credentials", new JSONObject());
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    field(activity, "remoteSubtasks", new JSONArray().put(task()));
                    @SuppressWarnings("unchecked") var history = (java.util.Map<Long, JSONObject>) field(activity, "history");
                    for (long i = 1; i <= 30; i++) history.put(i, new JSONObject().put("seq", i).put("role", i % 2 == 1 ? "user" : "assistant").put("engine", "codex").put("text", ("Sample " + i + "\n").repeat(12)));
                    field(activity, "initialMessageScroll", false);
                    var render = MainActivity.class.getDeclaredMethod("renderMessages", JSONObject.class); render.setAccessible(true); render.invoke(activity, new Object[]{null});
                    ((EditText) field(activity, "composer")).setText("Keep this parent draft");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            int[] position = {0};
            getInstrumentation().runOnMainSync(() -> {
                try {
                    ScrollView scroll = (ScrollView) field(activity, "scroll"); scroll.scrollTo(0, 180); position[0] = scroll.getScrollY();
                    assertTrue(position[0] > 0);
                    var open = MainActivity.class.getDeclaredMethod("openSubtask", long.class, String.class); open.setAccessible(true); open.invoke(activity, 1L, "codex:child-1");
                    SubtaskPage page = (SubtaskPage) field(activity, "subtaskPage"); assertTrue(page.isShowing());
                    ((EditText) page.getWindow().getDecorView().findViewWithTag("subtaskReply")).setText("Keep this child draft");
                    page.update(new JSONArray().put(task().put("progress", "New progress")));
                    assertEquals("Keep this child draft", ((EditText) page.getWindow().getDecorView().findViewWithTag("subtaskReply")).getText().toString());
                    page.onBackPressed();
                    assertEquals("Keep this parent draft", ((EditText) field(activity, "composer")).getText().toString());
                    assertEquals(position[0], scroll.getScrollY()); assertFalse(page.isShowing());
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            assertNull(field(activity, "subtaskPage"));
        } finally { getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync(); }
    }
    public void testChildActionsCarryOnlyTheirOwnTaskAndPreserveTypedInput() throws Exception {
        MainActivity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    java.util.List<JSONObject> actions = new java.util.ArrayList<>();
                    SubtaskPage page = new SubtaskPage(activity, false, 1, "codex:child-1", (task, operation, extra) ->
                        actions.add(new JSONObject().put("taskId", task.getString("id")).put("engine", task.getString("engine")).put("operation", operation).put("extra", extra)));
                    page.update(new JSONArray().put(task())); page.show();
                    try {
                        android.view.View root = page.getWindow().getDecorView(); EditText reply = root.findViewWithTag("subtaskReply");
                        assertFalse(root.findViewWithTag("sendSubtask").isEnabled()); reply.setText("Check cache invalidation");
                        page.update(new JSONArray().put(task().put("progress", "Still running")));
                        assertEquals("Check cache invalidation", reply.getText().toString());
                        page.setControlAvailable(false);
                        assertFalse(root.findViewWithTag("sendSubtask").isEnabled()); assertFalse(root.findViewWithTag("stopSubtask").isEnabled());
                        root.findViewWithTag("sendSubtask").performClick(); root.findViewWithTag("stopSubtask").performClick(); assertTrue(actions.isEmpty());
                        assertEquals("Check cache invalidation", reply.getText().toString()); page.setControlAvailable(true);
                        root.findViewWithTag("sendSubtask").performClick(); root.findViewWithTag("stopSubtask").performClick();
                        assertEquals(2, actions.size()); assertEquals("child-1", actions.get(0).getString("taskId"));
                        assertEquals("reply", actions.get(0).getString("operation")); assertEquals("Check cache invalidation", actions.get(0).getJSONObject("extra").getString("prompt"));
                        assertEquals("child-1", actions.get(1).getString("taskId")); assertEquals("stop", actions.get(1).getString("operation"));
                    } finally { page.dismiss(); }
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync(); }
    }
    private void invoke(MainActivity activity, String name, Class<?>[] types, Object... values) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(activity, values);
    }
    private void prepare(MainActivity activity) throws Exception {
        field(activity, "conversationId", "12345678-1234-1234-1234-123456789abc"); field(activity, "credentials", new JSONObject());
        invoke(activity, "detailScreen", new Class<?>[]{});
    }
    private JSONObject snapshot(String instance, long cursor, JSONArray tasks) throws Exception {
        JSONObject value = new JSONObject().put("conversation", new JSONObject().put("id", "12345678-1234-1234-1234-123456789abc").put("title", "Parent"))
            .put("instanceId", instance).put("cursor", cursor).put("permission", "control").put("messages", new JSONArray()).put("nextBefore", JSONObject.NULL);
        if (tasks != null) value.put("subagents", tasks); return value;
    }
    public void testRestartAndAccessLossDiscardOldChildPages() throws Exception {
        MainActivity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    prepare(activity);
                    for (int failure : new int[]{0, 403, 404}) {
                        invoke(activity, "applySnapshot", new Class<?>[]{JSONObject.class}, snapshot("desktop-" + failure, 1, new JSONArray().put(task())));
                        ((EditText) field(activity, "composer")).setText("Keep the parent draft");
                        invoke(activity, "openSubtask", new Class<?>[]{long.class, String.class}, 1L, "codex:child-1");
                        SubtaskPage page = (SubtaskPage) field(activity, "subtaskPage"); assertTrue(page.isShowing());
                        if (failure == 0) invoke(activity, "applySnapshot", new Class<?>[]{JSONObject.class}, snapshot("restarted", 0, null));
                        else invoke(activity, "showFailure", new Class<?>[]{Exception.class, boolean.class}, new RemoteApi.Failure(failure), true);
                        assertFalse(page.isShowing()); assertNull(field(activity, "subtaskPage"));
                        assertEquals(0, ((JSONArray) field(activity, "remoteSubtasks")).length());
                        assertEquals("Keep the parent draft", ((EditText) field(activity, "composer")).getText().toString());
                        if (failure != 0) { assertEquals(false, field(activity, "controlAllowed")); assertEquals(false, field(activity, "connected")); }
                    }
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync(); }
    }
    public void testReplacingAChildPageKeepsTheNewPageAndEngineIdentity() throws Exception {
        MainActivity activity = start(); SubtaskPage[] replacement = new SubtaskPage[1];
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    prepare(activity);
                    JSONArray tasks = new JSONArray().put(task()).put(task().put("engine", "claude").put("title", "Claude child"));
                    invoke(activity, "applySnapshot", new Class<?>[]{JSONObject.class}, snapshot("desktop", 1, tasks));
                    invoke(activity, "openSubtask", new Class<?>[]{long.class, String.class}, 1L, "codex:child-1");
                    invoke(activity, "openSubtask", new Class<?>[]{long.class, String.class}, 1L, "claude:child-1");
                    replacement[0] = (SubtaskPage) field(activity, "subtaskPage");
                    assertEquals("claude", ((JSONObject) field(replacement[0], "current")).getString("engine"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            assertSame(replacement[0], field(activity, "subtaskPage")); assertTrue(replacement[0].isShowing());
        } finally { getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync(); }
    }
    public void testChildFromUnloadedTurnRemainsReachable() throws Exception {
        MainActivity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    prepare(activity);
                    JSONObject value = snapshot("desktop", 1, new JSONArray().put(task().put("status", "waiting")));
                    value.put("messages", new JSONArray().put(new JSONObject().put("seq", 20).put("role", "user").put("text", "A later turn")));
                    invoke(activity, "applySnapshot", new Class<?>[]{JSONObject.class}, value);
                    @SuppressWarnings("unchecked") var rendered = (java.util.Map<String, android.view.View>) field(activity, "renderedMessages");
                    assertNotNull(rendered.get("subtasks:1"));
                    invoke(activity, "openSubtask", new Class<?>[]{long.class, String.class}, 1L, "codex:child-1");
                    assertEquals("child-1", ((JSONObject) field(field(activity, "subtaskPage"), "current")).getString("id"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync(); }
    }
}
