package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class ExecutionProcessTest extends InstrumentationTestCase {
    public void testRemoteSnapshotKeepsFinalAnswerOutsideProcess() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        android.app.Activity activity = getInstrumentation().startActivitySync(new android.content.Intent(context, MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "fixture");
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    JSONArray process = new JSONArray().put(new JSONObject().put("type", "tool").put("title", "Shell").put("input", "echo test").put("text", "test").put("status", "completed"));
                    JSONArray messages = new JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("text", "Hello"));
                    JSONObject snapshot = new JSONObject().put("conversation", new JSONObject().put("id", "fixture"))
                        .put("instanceId", "server").put("cursor", 1).put("messages", messages)
                        .put("live", new JSONObject().put("userSeq", 1).put("text", "Final answer").put("process", process));
                    apply.invoke(activity, snapshot);
                    View root = activity.getWindow().getDecorView();
                    String key = "fixture:turn:1";
                    assertEquals(View.GONE, root.findViewWithTag("processBody:" + key).getVisibility());
                    root.findViewWithTag("processToggle:" + key).performClick();
                    snapshot.put("cursor", 2); apply.invoke(activity, snapshot);
                    assertEquals(View.VISIBLE, root.findViewWithTag("processBody:" + key).getVisibility());
                    messages.put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", "Final answer").put("process", process));
                    snapshot.put("cursor", 3).put("live", JSONObject.NULL); apply.invoke(activity, snapshot);
                    View body = root.findViewWithTag("processBody:" + key); assertEquals(View.GONE, body.getVisibility());
                    android.view.ViewGroup block = (android.view.ViewGroup) body.getParent().getParent();
                    assertTrue(block.getChildCount() >= 2); assertEquals(View.VISIBLE, block.getChildAt(1).getVisibility());
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testDefaultCollapseLiveChoiceCompletionAndHistory() throws Throwable {
        runTestOnUiThread(() -> {
            try {
                var context = getInstrumentation().getTargetContext(); ChatStyle style = new ChatStyle(context);
                ExecutionProcessView.State state = new ExecutionProcessView.State();
                JSONArray process = new JSONArray().put(new JSONObject().put("type", "thinking").put("text", "Published reasoning"))
                    .put(new JSONObject().put("type", "tool").put("title", "Shell").put("input", "echo test").put("text", "test").put("status", "completed"));
                ExecutionProcessView view = new ExecutionProcessView(context, style, state, "turn"); view.update(process, true);
                assertEquals(View.GONE, view.findViewWithTag("processBody:turn").getVisibility());
                view.findViewWithTag("processToggle:turn").performClick();
                assertEquals(View.VISIBLE, view.findViewWithTag("processBody:turn").getVisibility());
                ExecutionProcessView rebuilt = new ExecutionProcessView(context, style, state, "turn"); rebuilt.update(process, true);
                assertEquals(View.VISIBLE, rebuilt.findViewWithTag("processBody:turn").getVisibility());
                rebuilt.update(process, false); assertEquals(View.GONE, rebuilt.findViewWithTag("processBody:turn").getVisibility());
                rebuilt.findViewWithTag("processToggle:turn").performClick(); rebuilt.update(process, false);
                assertEquals(View.VISIBLE, rebuilt.findViewWithTag("processBody:turn").getVisibility());
                ExecutionProcessView reload = new ExecutionProcessView(context, style, new ExecutionProcessView.State(), "turn"); reload.update(process, false);
                assertEquals(View.GONE, reload.findViewWithTag("processBody:turn").getVisibility());
                reload.update(new JSONArray(), false); assertEquals(View.GONE, reload.getVisibility());
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testUserBubbleHugsRightAndAssistantUsesLeft() throws Throwable {
        runTestOnUiThread(() -> {
            var context = getInstrumentation().getTargetContext(); ChatStyle style = new ChatStyle(context);
            LinearLayout parent = new LinearLayout(context); parent.setOrientation(LinearLayout.VERTICAL);
            LinearLayout user = style.messageBlock(true), assistant = style.messageBlock(false);
            TextView body = new TextView(context); body.setText("你好"); user.addView(body);
            TextView answer = new TextView(context); answer.setText("Hello"); assistant.addView(answer);
            parent.addView(user); parent.addView(assistant);
            parent.measure(View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.AT_MOST));
            parent.layout(0, 0, 1000, parent.getMeasuredHeight());
            assertEquals(1000, user.getRight()); assertTrue(user.getLeft() > 0); assertEquals(0, assistant.getLeft());
            assertTrue(user.getWidth() < assistant.getWidth()); assertNull(assistant.getBackground());
        });
    }
}
