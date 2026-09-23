package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ScrollView;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteScrollTest extends InstrumentationTestCase {
    private Object field(Activity activity, String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(activity);
    }

    public void testLastMessageActionsClearDockAfterComposerResizes() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var conversationId = MainActivity.class.getDeclaredField("conversationId"); conversationId.setAccessible(true); conversationId.set(activity, "scroll-test");
                    var credentials = MainActivity.class.getDeclaredField("credentials"); credentials.setAccessible(true); credentials.set(activity, new JSONObject());
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    apply.invoke(activity, new JSONObject().put("instanceId", "scroll-test").put("cursor", 1).put("permission", "control")
                        .put("conversation", new JSONObject().put("id", "scroll-test").put("seq", 1))
                        .put("messages", new JSONArray().put(new JSONObject().put("seq", 1).put("role", "assistant")
                            .put("text", "Paragraph of remote conversation content.\n\n".repeat(40) + "Final answer.")))
                        .put("nextBefore", JSONObject.NULL));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            assertBottomReachable(activity);
            getInstrumentation().runOnMainSync(() -> {
                try { ((EditText) field(activity, "composer")).setText("First line\nSecond line\nThird line\nFourth line"); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            assertBottomReachable(activity);
            getInstrumentation().runOnMainSync(() -> {
                try { ((EditText) field(activity, "composer")).setText(""); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            assertBottomReachable(activity);
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private void assertBottomReachable(Activity activity) {
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            try { ((ScrollView) field(activity, "scroll")).fullScroll(View.FOCUS_DOWN); }
            catch (Exception error) { throw new AssertionError(error); }
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            try {
                ScrollView scroll = (ScrollView) field(activity, "scroll");
                scroll.scrollTo(0, scroll.getChildAt(0).getHeight());
                ViewGroup messages = (ViewGroup) field(activity, "messages");
                View copy = messages.getChildAt(messages.getChildCount() - 1).findViewWithTag("copyMessage");
                View dock = activity.getWindow().getDecorView().findViewWithTag("composerBarDock");
                int[] copyPosition = new int[2], dockPosition = new int[2];
                copy.getLocationOnScreen(copyPosition); dock.getLocationOnScreen(dockPosition);
                assertTrue("Last copy button must be entirely above the dock, including its fade", copyPosition[1] + copy.getHeight() <= dockPosition[1]);
                assertFalse("The assertion must check the actual scroll limit", scroll.canScrollVertically(1));
                assertEquals(dock.getHeight() + Math.round(16 * activity.getResources().getDisplayMetrics().density), scroll.getChildAt(0).getPaddingBottom());
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }
}
