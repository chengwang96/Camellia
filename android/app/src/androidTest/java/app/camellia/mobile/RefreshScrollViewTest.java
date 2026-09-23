package app.camellia.mobile;

import android.content.Intent;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.MotionEvent;
import android.view.View;
import android.widget.TextView;
import java.util.concurrent.atomic.AtomicInteger;

public class RefreshScrollViewTest extends InstrumentationTestCase {
    private MainActivity activity;
    private RefreshScrollView scroll;
    private TextView content;
    private final AtomicInteger refreshes = new AtomicInteger();
    private float density;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().runOnMainSync(() -> {
            density = activity.getResources().getDisplayMetrics().density;
            scroll = new RefreshScrollView(activity);
            content = new TextView(activity); content.setText("Remote computer"); content.setHeight((int) (1800 * density));
            content.setOnClickListener(view -> {});
            scroll.addView(content);
            scroll.setRefreshAction(refreshes::incrementAndGet, ready -> {});
            activity.setContentView(scroll);
        });
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        getInstrumentation().runOnMainSync(() -> activity.finish());
        getInstrumentation().waitForIdleSync();
        super.tearDown();
    }

    private void touch(int action, float horizontal, float vertical) {
        long time = SystemClock.uptimeMillis();
        MotionEvent event = MotionEvent.obtain(time, time, action, horizontal * density, vertical * density, 0);
        scroll.dispatchTouchEvent(event); event.recycle();
    }

    public void testRefreshActionIsDiscoverableAndDoesNotRepeatWhileBusy() {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            try {
                android.view.accessibility.AccessibilityNodeInfo info = scroll.createAccessibilityNodeInfo();
                boolean found = false;
                for (android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction action : info.getActionList()) {
                    if (action.getId() == android.R.id.button1) {
                        found = true;
                        assertTrue(action.getLabel().length() > 0);
                    }
                }
                assertTrue(found);
                assertTrue(scroll.performAccessibilityAction(android.R.id.button1, null));
                assertEquals(1, refreshes.get());
                assertFalse(scroll.performAccessibilityAction(android.R.id.button1, null));
                assertEquals(1, refreshes.get());
                scroll.setRefreshing(false);
                assertTrue(scroll.performAccessibilityAction(android.R.id.button1, null));
                assertEquals(2, refreshes.get());
                scroll.setRefreshing(false);
                scroll.setRefreshAction(null, null);
                assertFalse(scroll.performAccessibilityAction(android.R.id.button1, null));
                for (android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction action : scroll.createAccessibilityNodeInfo().getActionList()) {
                    assertFalse(action.getId() == android.R.id.button1);
                }
            } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    public void testPullClickFeedbackOccursOnceAndNeverOnCancel() {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            try {
                AtomicInteger clicks = new AtomicInteger();
                scroll.setOnClickListener(view -> clicks.incrementAndGet());
                touch(MotionEvent.ACTION_DOWN, 80, 30);
                touch(MotionEvent.ACTION_MOVE, 80, 130);
                touch(MotionEvent.ACTION_CANCEL, 80, 130);
                assertEquals(0, clicks.get());
                assertEquals(0, refreshes.get());
                touch(MotionEvent.ACTION_DOWN, 80, 30);
                touch(MotionEvent.ACTION_MOVE, 80, 130);
                touch(MotionEvent.ACTION_UP, 80, 130);
                assertEquals(1, clicks.get());
                assertEquals(1, refreshes.get());
            } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    public void testPullRevealsIndicatorAndRefreshesOnlyOnce() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            touch(MotionEvent.ACTION_DOWN, 80, 30);
            touch(MotionEvent.ACTION_MOVE, 80, 130);
            assertTrue(content.getTranslationY() > 0);
            assertEquals(0, refreshes.get());
            touch(MotionEvent.ACTION_UP, 80, 130);
            assertEquals(1, refreshes.get());
            touch(MotionEvent.ACTION_DOWN, 80, 30);
            touch(MotionEvent.ACTION_MOVE, 80, 140);
            touch(MotionEvent.ACTION_UP, 80, 140);
            assertEquals(1, refreshes.get());
            scroll.setRefreshing(false);
        });
        SystemClock.sleep(350);
        getInstrumentation().runOnMainSync(() -> assertEquals(0f, content.getTranslationY(), 0.1f));
    }

    public void testShortPullAndCancelledPullReturnWithoutRefresh() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            touch(MotionEvent.ACTION_DOWN, 80, 30);
            touch(MotionEvent.ACTION_MOVE, 80, 65);
            assertTrue(content.getTranslationY() > 0);
            touch(MotionEvent.ACTION_UP, 80, 65);
        });
        SystemClock.sleep(350);
        getInstrumentation().runOnMainSync(() -> {
            assertEquals(0f, content.getTranslationY(), 0.1f);
            touch(MotionEvent.ACTION_DOWN, 80, 30);
            touch(MotionEvent.ACTION_MOVE, 80, 140);
            touch(MotionEvent.ACTION_CANCEL, 80, 140);
            assertEquals(0, refreshes.get());
        });
        SystemClock.sleep(350);
        getInstrumentation().runOnMainSync(() -> assertEquals(0f, content.getTranslationY(), 0.1f));
    }

    public void testHorizontalAndNonTopGesturesDoNotRefresh() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            touch(MotionEvent.ACTION_DOWN, 30, 30);
            touch(MotionEvent.ACTION_MOVE, 180, 130);
            touch(MotionEvent.ACTION_UP, 180, 130);
            assertEquals(0f, content.getTranslationY(), 0.1f);
            scroll.scrollTo(0, (int) (300 * density));
            touch(MotionEvent.ACTION_DOWN, 80, 30);
            touch(MotionEvent.ACTION_MOVE, 80, 130);
            touch(MotionEvent.ACTION_UP, 80, 130);
            assertEquals(0, refreshes.get());
            assertEquals(0f, content.getTranslationY(), 0.1f);
        });
    }

    public void testAccessibleRefreshAndDetachResetAnimation() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            assertTrue(scroll.performAccessibilityAction(android.R.id.button1, null));
            assertEquals(1, refreshes.get());
        });
        SystemClock.sleep(350);
        getInstrumentation().runOnMainSync(() -> {
            assertEquals(52 * density, content.getTranslationY(), 0.1f);
            activity.setContentView(new View(activity));
            assertEquals(0f, content.getTranslationY(), 0.1f);
        });
    }

    public void testContinuousPullCanRefreshAfterReachingTop() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            scroll.scrollTo(0, (int) (60 * density));
            touch(MotionEvent.ACTION_DOWN, 80, 30);
            touch(MotionEvent.ACTION_MOVE, 80, 110);
            touch(MotionEvent.ACTION_MOVE, 80, 150);
            touch(MotionEvent.ACTION_MOVE, 80, 260);
            touch(MotionEvent.ACTION_MOVE, 80, 300);
            touch(MotionEvent.ACTION_MOVE, 80, 410);
            touch(MotionEvent.ACTION_UP, 80, 410);
            assertEquals(1, refreshes.get());
        });
    }
}
