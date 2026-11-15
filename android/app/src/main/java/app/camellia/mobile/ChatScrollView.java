package app.camellia.mobile;

import android.content.Context;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.widget.ScrollView;

/** Keeps an already bottom-aligned conversation there when media changes size. */
class ChatScrollView extends ScrollView {
    private boolean followBottomOnLayout;
    private boolean touching;
    private boolean laidOut;
    private int previousBottom;
    private long lastScroll;
    private Runnable idleAction;
    private final Runnable checkIdle = this::runIdleAction;
    private static final long SCROLL_IDLE_MS = 180;

    ChatScrollView(Context context) { super(context); }

    void setFollowBottomOnLayout(boolean enabled) { followBottomOnLayout = enabled; }

    /** Coalesce live list changes until both the gesture and its fling have settled. */
    void whenScrollIdle(Runnable action) {
        idleAction = action;
        runIdleAction();
    }

    private void runIdleAction() {
        removeCallbacks(checkIdle);
        if (idleAction == null || touching) return;
        long remaining = SCROLL_IDLE_MS - (SystemClock.uptimeMillis() - lastScroll);
        if (remaining > 0) { postDelayed(checkIdle, remaining); return; }
        Runnable action = idleAction;
        idleAction = null;
        action.run();
    }

    @Override protected void onScrollChanged(int x, int y, int oldX, int oldY) {
        super.onScrollChanged(x, y, oldX, oldY);
        lastScroll = SystemClock.uptimeMillis();
        if (idleAction != null) runIdleAction();
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        // Compare with the PREVIOUS layout. Measuring the gap after an image
        // grows would mistake that growth for the reader scrolling up.
        boolean following = followBottomOnLayout && laidOut && !touching
            && Math.abs(previousBottom - getScrollY()) <= 1;
        super.onLayout(changed, left, top, right, bottom);
        int contentHeight = getChildCount() == 0 ? 0 : getChildAt(0).getHeight();
        previousBottom = Math.max(0, contentHeight + getPaddingTop() + getPaddingBottom() - getHeight());
        laidOut = true;
        if (following) scrollTo(0, previousBottom);
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) touching = true;
        try { return super.dispatchTouchEvent(event); }
        finally {
            if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                touching = false;
                lastScroll = SystemClock.uptimeMillis();
                if (idleAction != null) runIdleAction();
            }
        }
    }

    @Override protected void onDetachedFromWindow() {
        touching = false;
        idleAction = null;
        removeCallbacks(checkIdle);
        super.onDetachedFromWindow();
    }
}
