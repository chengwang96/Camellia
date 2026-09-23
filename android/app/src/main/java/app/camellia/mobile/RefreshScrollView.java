package app.camellia.mobile;

import android.content.Context;
import android.animation.ValueAnimator;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.os.SystemClock;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.animation.DecelerateInterpolator;
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
    private final float density;
    private final Paint indicator = new Paint(Paint.ANTI_ALIAS_FLAG);
    private float reveal;
    private ValueAnimator settle;
    private long spinStarted;

    RefreshScrollView(Context context) {
        super(context);
        density = getResources().getDisplayMetrics().density;
        threshold = 72 * density;
        slop = ViewConfiguration.get(context).getScaledTouchSlop();
        indicator.setColor(new ChatStyle(context).muted);
        indicator.setStrokeWidth(2.2f * density);
        indicator.setStrokeCap(Paint.Cap.ROUND);
    }

    void setRefreshAction(Runnable action, java.util.function.Consumer<Boolean> hint) {
        refresh = action;
        this.hint = hint;
        setOverScrollMode(action == null ? OVER_SCROLL_IF_CONTENT_SCROLLS : OVER_SCROLL_NEVER);
    }

    void setRefreshing(boolean value) {
        value = value && refresh != null;
        if (refreshing == value && (value || reveal == 0)) return;
        refreshing = value;
        if (value) { spinStarted = SystemClock.uptimeMillis(); pulling = false; eligible = false; }
        animateReveal(value ? 52 * density : 0);
    }

    private void reveal(float value) {
        reveal = value;
        if (getChildCount() > 0) getChildAt(0).setTranslationY(value);
        invalidate();
    }

    private void animateReveal(float target) {
        if (settle != null) settle.cancel();
        if (!ValueAnimator.areAnimatorsEnabled()) { reveal(target); return; }
        settle = ValueAnimator.ofFloat(reveal, target);
        settle.setDuration(240);
        settle.setInterpolator(new DecelerateInterpolator());
        settle.addUpdateListener(animation -> reveal((Float) animation.getAnimatedValue()));
        settle.start();
    }

    @Override protected void dispatchDraw(Canvas canvas) {
        super.dispatchDraw(canvas);
        if (reveal <= 0) return;
        int saved = canvas.save();
        canvas.translate(getScrollX() + getWidth() / 2f, getScrollY() + reveal / 2f);
        float progress = Math.min(1, reveal / (36 * density));
        canvas.scale(progress, progress);
        int phase = refreshing && ValueAnimator.areAnimatorsEnabled()
            ? (int) ((SystemClock.uptimeMillis() - spinStarted) / 75 % 12) : 0;
        int segments = refreshing ? 12 : Math.max(1, (int) (progress * 12));
        for (int index = 0; index < 12; index++) {
            int age = (index - phase + 12) % 12;
            indicator.setAlpha(Math.round(progress * (refreshing ? 55 + age * 18 : index < segments ? 210 : 35)));
            canvas.drawLine(0, -5.5f * density, 0, -9.5f * density, indicator);
            canvas.rotate(30);
        }
        canvas.restoreToCount(saved);
        if (refreshing && isAttachedToWindow() && getWindowVisibility() == VISIBLE && ValueAnimator.areAnimatorsEnabled()) postInvalidateOnAnimation();
    }

    private void updatePull(float distance) {
        boolean ready = distance >= threshold;
        if (armed != ready) {
            armed = ready;
            if (hint != null) hint.accept(armed);
            if (armed) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
        }
        reveal(96 * density * (1 - (float) Math.exp(-Math.max(0, distance) / (150 * density))));
    }

    private void finishPull(boolean released) {
        boolean trigger = released && armed && !refreshing;
        pulling = false; eligible = false; armed = false;
        if (hint != null) hint.accept(false);
        if (trigger) { performClick(); setRefreshing(true); refresh.run(); }
        else animateReveal(refreshing ? 52 * density : 0);
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            startX = event.getX(); startY = event.getY();
            eligible = !canScrollVertically(-1) && !refreshing && refresh != null;
            pulling = false; armed = false;
            if (eligible && settle != null) settle.cancel();
        } else if (event.getActionMasked() == MotionEvent.ACTION_MOVE && eligible) {
            float distance = event.getY() - startY;
            if (Math.abs(event.getX() - startX) > Math.max(slop, distance) || distance < -slop) eligible = false;
            else if (distance > slop) { pulling = true; updatePull(distance); return true; }
        } else if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            if (!refreshing && reveal > 0) animateReveal(0);
            eligible = false;
        }
        return super.onInterceptTouchEvent(event);
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    @Override public boolean onTouchEvent(MotionEvent event) {
        if (!pulling && !eligible && !refreshing && refresh != null && event.getActionMasked() == MotionEvent.ACTION_MOVE
            && !canScrollVertically(-1) && event.getY() - startY > slop && Math.abs(event.getX() - startX) < slop) {
            eligible = true; startY = event.getY();
            if (settle != null) settle.cancel();
        }
        if (!pulling && eligible && event.getActionMasked() == MotionEvent.ACTION_MOVE) {
            float distance = event.getY() - startY;
            if (Math.abs(event.getX() - startX) > Math.max(slop, distance) || distance < -slop) eligible = false;
            else if (distance > slop) pulling = true;
        }
        if (pulling) {
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
                updatePull(event.getY() - startY);
            } else if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                finishPull(event.getActionMasked() == MotionEvent.ACTION_UP);
            } else if (event.getActionMasked() == MotionEvent.ACTION_POINTER_DOWN) {
                finishPull(false);
            }
            return true;
        }
        return super.onTouchEvent(event);
    }

    @Override public boolean performClick() { super.performClick(); return true; }

    @Override protected void onDetachedFromWindow() {
        if (settle != null) settle.cancel();
        refreshing = false; pulling = false; eligible = false; armed = false;
        reveal(0);
        super.onDetachedFromWindow();
    }

    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        if (refresh != null) info.addAction(new AccessibilityNodeInfo.AccessibilityAction(android.R.id.button1,
            getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? "刷新" : "Refresh"));
    }

    @Override public boolean performAccessibilityAction(int action, Bundle arguments) {
        if (action == android.R.id.button1 && refresh != null && !refreshing) { setRefreshing(true); refresh.run(); return true; }
        return super.performAccessibilityAction(action, arguments);
    }
}
