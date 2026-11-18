package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** Exercise real layout and the shared scroll owner, without model/network calls. */
public class ChatReadingTest extends InstrumentationTestCase {
    private android.app.Activity activity;
    private ChatScrollView scroll;
    private LinearLayout content;
    private ExecutionProcessView process;
    private JSONArray entries;

    private void ui(Runnable action) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private void settle() throws Exception {
        getInstrumentation().waitForIdleSync();
        var idle = new java.util.concurrent.CountDownLatch(1);
        getInstrumentation().runOnMainSync(() -> scroll.whenScrollIdle(idle::countDown));
        assertTrue("A touch fling must settle before measuring reading position", idle.await(5, java.util.concurrent.TimeUnit.SECONDS));
        var frames = new java.util.concurrent.CountDownLatch(1);
        getInstrumentation().runOnMainSync(() -> android.view.Choreographer.getInstance().postFrameCallback(a ->
            android.view.Choreographer.getInstance().postFrameCallback(b -> frames.countDown())));
        assertTrue("Layout must settle", frames.await(5, java.util.concurrent.TimeUnit.SECONDS));
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        activity = getInstrumentation().startActivitySync(new android.content.Intent(context, MarkdownTestActivity.class)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            try {
                ChatStyle style = new ChatStyle(activity);
                scroll = new ChatScrollView(activity); scroll.setFillViewport(true); scroll.setFollowBottomOnLayout(true);
                content = new LinearLayout(activity); content.setOrientation(LinearLayout.VERTICAL); scroll.addView(content);
                View before = new View(activity); content.addView(before, new LinearLayout.LayoutParams(-1, style.dp(1200)));
                entries = new JSONArray();
                for (int i = 0; i < 165; i++) entries.put(new JSONObject().put("type", "tool").put("id", "step" + i)
                    .put("title", "verify").put("input", "Check step " + i).put("status", "completed").put("text", "Passed"));
                process = new ExecutionProcessView(activity, style, new ExecutionProcessView.State(), "reading");
                process.update(entries, true); content.addView(process);
                TextView answer = new TextView(activity); answer.setText("Final answer\n".repeat(12)); content.addView(answer);
                activity.setContentView(scroll);
            } catch (Exception e) { throw new AssertionError(e); }
        });
        settle();
        ui(() -> { scroll.followOutput(); scroll.scrollTo(0, content.getHeight()); });
        settle();
    }

    @Override protected void tearDown() throws Exception {
        NativeActivityCleanup.finish(getInstrumentation(), activity); super.tearDown();
    }

    public void testSmallUpwardGestureAndDelayedGrowthKeepReading() throws Exception {
        int[] position = new int[1];
        ui(() -> {
            long now = android.os.SystemClock.uptimeMillis();
            var down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, 100, 100, 0);
            var move = android.view.MotionEvent.obtain(now, now + 20, android.view.MotionEvent.ACTION_MOVE, 100, 124, 0);
            var up = android.view.MotionEvent.obtain(now, now + 50, android.view.MotionEvent.ACTION_UP, 100, 124, 0);
            scroll.dispatchTouchEvent(down); scroll.dispatchTouchEvent(move); scroll.dispatchTouchEvent(up);
            down.recycle(); move.recycle(); up.recycle();
            assertFalse("A small history gesture pauses follow", scroll.isFollowingOutput());
        });
        settle();
        ui(() -> {
            position[0] = scroll.getScrollY();
            TextView incoming = new TextView(activity); incoming.setText("New output\n".repeat(40)); content.addView(incoming);
        });
        settle();
        ui(() -> {
            assertEquals(position[0], scroll.getScrollY());
            assertFalse(scroll.isFollowingOutput());
            scroll.followOutput(); scroll.scrollTo(0, content.getHeight());
        });
        settle();
        ui(() -> assertTrue(scroll.isFollowingOutput()));
    }

    public void testExpandedProcessKeepsFirstRecordAcrossUpdatesAndCompletion() throws Exception {
        View header = process.findViewWithTag("processToggle:reading");
        ui(header::performClick); settle();
        int[] top = new int[1];
        ui(() -> {
            assertFalse(scroll.isFollowingOutput());
            android.graphics.Rect visible = new android.graphics.Rect();
            assertTrue(header.getGlobalVisibleRect(visible));
            top[0] = scroll.getScrollY();
            process.update(entries, true);
        });
        settle();
        ui(() -> {
            assertEquals(top[0], scroll.getScrollY());
            process.update(entries, false);
        });
        settle();
        ui(() -> {
            assertEquals(View.VISIBLE, process.findViewWithTag("processBody:reading").getVisibility());
            assertEquals(top[0], scroll.getScrollY());
            View footer = process.findViewWithTag("processCollapse:reading");
            footer.requestRectangleOnScreen(new android.graphics.Rect(0, 0, footer.getWidth(), footer.getHeight()), true);
        });
        settle();
        getInstrumentation().runOnMainSync(() -> process.findViewWithTag("processCollapse:reading").performClick()); settle();
        ui(() -> {
            android.graphics.Rect visible = new android.graphics.Rect();
            assertTrue("Long-distance collapse reveals the header", header.getGlobalVisibleRect(visible));
            assertFalse(scroll.isFollowingOutput());
            header.performClick();
        });
        settle();
        ui(() -> {
            View first = ((LinearLayout) process.findViewWithTag("processBody:reading")).getChildAt(0);
            android.graphics.Rect visible = new android.graphics.Rect();
            assertTrue("Reopen starts at the first record", first.getGlobalVisibleRect(visible));
            assertFalse(scroll.isFollowingOutput());
        });
    }
}
