package app.camellia.mobile;

import android.content.Context;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.accessibility.AccessibilityNodeInfo;
import android.os.Bundle;
import android.widget.ScrollView;

final class RefreshScrollView extends ScrollView {
    private float startX, startY;
    private boolean eligible, pulling, armed, refreshing;
    private Runnable refresh;
    private java.util.function.Consumer<Boolean> hint;
    private final float threshold;
    private final int slop;

    RefreshScrollView(Context context) {
        super(context);
        threshold = 72 * getResources().getDisplayMetrics().density;
        slop = ViewConfiguration.get(context).getScaledTouchSlop();
    }

    void setRefreshAction(Runnable action, java.util.function.Consumer<Boolean> hint) {
        refresh = action;
        this.hint = hint;
    }

    void setRefreshing(boolean value) { refreshing = value; }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            startX = event.getX(); startY = event.getY();
            eligible = !canScrollVertically(-1) && !refreshing && refresh != null;
            pulling = false; armed = false;
        } else if (event.getActionMasked() == MotionEvent.ACTION_MOVE && eligible) {
            float distance = event.getY() - startY;
            if (Math.abs(event.getX() - startX) > Math.max(slop, distance) || distance < -slop) eligible = false;
            else if (distance > slop) { pulling = true; return true; }
        }
        return super.onInterceptTouchEvent(event);
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (pulling) {
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
                armed = event.getY() - startY >= threshold;
                hint.accept(armed);
            } else if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                boolean trigger = armed && event.getActionMasked() == MotionEvent.ACTION_UP;
                pulling = false; armed = false;
                hint.accept(false);
                if (trigger && !refreshing) { performClick(); refresh.run(); }
            }
            return true;
        }
        return super.onTouchEvent(event);
    }

    @Override public boolean performClick() { super.performClick(); return true; }

    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        if (refresh != null) info.addAction(new AccessibilityNodeInfo.AccessibilityAction(android.R.id.button1,
            getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? "刷新" : "Refresh"));
    }

    @Override public boolean performAccessibilityAction(int action, Bundle arguments) {
        if (action == android.R.id.button1 && refresh != null && !refreshing) { refresh.run(); return true; }
        return super.performAccessibilityAction(action, arguments);
    }
}
