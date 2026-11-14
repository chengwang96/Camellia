package app.camellia.mobile;

import android.content.Context;
import android.view.MotionEvent;
import android.widget.ScrollView;

/** Keeps an already bottom-aligned conversation there when media changes size. */
class ChatScrollView extends ScrollView {
    private boolean followBottomOnLayout;
    private boolean touching;
    private boolean laidOut;
    private int previousBottom;

    ChatScrollView(Context context) { super(context); }

    void setFollowBottomOnLayout(boolean enabled) { followBottomOnLayout = enabled; }

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
            if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) touching = false;
        }
    }

    @Override protected void onDetachedFromWindow() {
        touching = false;
        super.onDetachedFromWindow();
    }
}
