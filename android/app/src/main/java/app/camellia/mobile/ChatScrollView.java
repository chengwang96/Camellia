package app.camellia.mobile;

import android.content.Context;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.widget.ScrollView;

/** Keeps an already bottom-aligned conversation there when media changes size. */
class ChatScrollView extends ScrollView {
    private boolean followBottomOnLayout;
    private boolean followingOutput = true;
    private boolean positioning;
    private boolean userScrolling;
    private float touchY;
    private long interactionRevision;
    private Runnable onReading;
    private final Runnable finishUserScroll = new Runnable() {
        @Override public void run() {
            if (touching) return;
            long remaining = SCROLL_IDLE_MS - (SystemClock.uptimeMillis() - lastScroll);
            if (remaining > 0) postDelayed(this, remaining);
            else userScrolling = false;
        }
    };
    private boolean touching;
    private boolean flinging;
    private boolean laidOut;
    private int previousBottom;
    private long lastScroll;
    private Runnable idleAction;
    private final Runnable checkIdle = this::runIdleAction;
    private static final long SCROLL_IDLE_MS = 180;

    ChatScrollView(Context context) { super(context); }

    void setFollowBottomOnLayout(boolean enabled) { followBottomOnLayout = enabled; }
    boolean isFollowingOutput() { return followBottomOnLayout && followingOutput; }
    long interactionRevision() { return interactionRevision; }
    void setOnReading(Runnable action) { onReading = action; }
    void followOutput() { followingOutput = true; interactionRevision++; }
    void readHistory() {
        followingOutput = false; interactionRevision++;
        if (onReading != null) onReading.run();
    }

    /** Apply a disclosure and its scroll destination before the next paint. */
    void changeProcess(android.view.View header, boolean opening, Runnable change) {
        int[] origin = new int[2], location = new int[2];
        getLocationInWindow(origin); header.getLocationInWindow(location);
        int previousTop = location[1] - origin[1];
        readHistory();
        long revision = interactionRevision;
        change.run();
        getViewTreeObserver().addOnPreDrawListener(new android.view.ViewTreeObserver.OnPreDrawListener() {
            @Override public boolean onPreDraw() {
                if (!isAttachedToWindow() || !header.isAttachedToWindow() || revision != interactionRevision) {
                    getViewTreeObserver().removeOnPreDrawListener(this); return true;
                }
                if (isLayoutRequested() || getChildAt(0).isLayoutRequested()) return false;
                getViewTreeObserver().removeOnPreDrawListener(this);
                getLocationInWindow(origin); header.getLocationInWindow(location);
                int inset = Math.round(12 * getResources().getDisplayMetrics().density);
                int preview = opening ? Math.min(Math.round(160 * getResources().getDisplayMetrics().density), getHeight() / 3) : 0;
                int target = previousTop >= getPaddingTop() + inset
                    && previousTop + header.getHeight() + preview <= getHeight() - getPaddingBottom()
                    ? previousTop : getPaddingTop() + inset;
                positioning = true;
                scrollTo(0, getScrollY() + location[1] - origin[1] - target);
                positioning = false;
                return true;
            }
        });
        invalidate();
    }

    /** Coalesce live list changes until both the gesture and its fling have settled. */
    void whenScrollIdle(Runnable action) {
        idleAction = action;
        runIdleAction();
    }

    private void runIdleAction() {
        removeCallbacks(checkIdle);
        if (idleAction == null || touching || isFlinging()) return;
        long remaining = SCROLL_IDLE_MS - (SystemClock.uptimeMillis() - lastScroll);
        if (remaining > 0) { postDelayed(checkIdle, remaining); return; }
        Runnable action = idleAction;
        idleAction = null;
        action.run();
    }

    boolean isFlinging() { return flinging; }

    @Override public void fling(int velocityY) {
        flinging = true;
        lastScroll = SystemClock.uptimeMillis();
        super.fling(velocityY);
        postInvalidateOnAnimation();
    }

    @Override public void computeScroll() {
        super.computeScroll();
        if (!flinging) return;
        if (SystemClock.uptimeMillis() - lastScroll < SCROLL_IDLE_MS) postInvalidateOnAnimation();
        else {
            flinging = false;
            if (idleAction != null) post(checkIdle);
        }
    }

    @Override protected void onScrollChanged(int x, int y, int oldX, int oldY) {
        super.onScrollChanged(x, y, oldX, oldY);
        if (!positioning && followBottomOnLayout) {
            if (y < oldY && (touching || userScrolling || isFollowingOutput())) readHistory();
            else if (y > oldY && !canScrollVertically(1)) followOutput();
        }
        lastScroll = SystemClock.uptimeMillis();
        if (userScrolling) { removeCallbacks(finishUserScroll); postDelayed(finishUserScroll, SCROLL_IDLE_MS); }
        if (idleAction != null) runIdleAction();
    }

    @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        // Elevated cards must stay inside the scrolling viewport, even when
        // the surrounding page allows shadows outside its children.
        setClipBounds(new android.graphics.Rect(0, 0, width, height));
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        // Layout growth follows only the reader's existing intent. Measuring
        // proximity after an update must never opt a history reader back in.
        boolean following = isFollowingOutput() && laidOut && !touching;
        int previousY = getScrollY();
        positioning = true;
        super.onLayout(changed, left, top, right, bottom);
        int contentHeight = getChildCount() == 0 ? 0 : getChildAt(0).getHeight();
        previousBottom = Math.max(0, contentHeight + getPaddingTop() + getPaddingBottom() - getHeight());
        laidOut = true;
        if (following) scrollTo(0, previousBottom);
        else if (followBottomOnLayout && !followingOutput) scrollTo(0, previousY);
        positioning = false;
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            touching = true; userScrolling = false; touchY = event.getY();
        } else if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
            userScrolling = true;
            if (event.getY() > touchY) readHistory();
            touchY = event.getY();
        }
        try { return super.dispatchTouchEvent(event); }
        finally {
            if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                touching = false;
                lastScroll = SystemClock.uptimeMillis();
                if (idleAction != null) runIdleAction();
                removeCallbacks(finishUserScroll); postDelayed(finishUserScroll, SCROLL_IDLE_MS);
            }
        }
    }

    @Override public boolean dispatchGenericMotionEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_SCROLL) {
            userScrolling = true;
            if (event.getAxisValue(MotionEvent.AXIS_VSCROLL) > 0) readHistory();
        }
        return super.dispatchGenericMotionEvent(event);
    }

    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        if (event.getAction() == android.view.KeyEvent.ACTION_DOWN) {
            int key = event.getKeyCode();
            if (key == android.view.KeyEvent.KEYCODE_DPAD_UP || key == android.view.KeyEvent.KEYCODE_PAGE_UP || key == android.view.KeyEvent.KEYCODE_MOVE_HOME) {
                userScrolling = true; readHistory();
            } else if (key == android.view.KeyEvent.KEYCODE_DPAD_DOWN || key == android.view.KeyEvent.KEYCODE_PAGE_DOWN || key == android.view.KeyEvent.KEYCODE_MOVE_END) userScrolling = true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override protected void onDetachedFromWindow() {
        touching = false;
        flinging = false;
        idleAction = null;
        removeCallbacks(checkIdle);
        removeCallbacks(finishUserScroll);
        super.onDetachedFromWindow();
    }
}
