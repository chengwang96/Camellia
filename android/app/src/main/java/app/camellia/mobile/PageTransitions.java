package app.camellia.mobile;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.animation.AnimationUtils;
import android.widget.FrameLayout;
import android.widget.ImageView;

@android.annotation.SuppressLint("ViewConstructor")
final class PageTransitions extends FrameLayout {
    private View page;
    private String route;
    private int depth;
    private Bitmap snapshot;
    private ImageView outgoing;
    private AnimatorSet animation;
    private ViewTreeObserver.OnPreDrawListener pending;

    PageTransitions(Activity activity) {
        super(activity);
        setTag("pageTransitions");
        activity.setContentView(this);
    }

    void show(View next, String nextRoute, int nextDepth) {
        finishTransition();
        boolean animate = page != null && !nextRoute.equals(route) && isLaidOut()
            && getWidth() > 0 && getHeight() > 0 && ValueAnimator.areAnimatorsEnabled();
        boolean back = nextDepth < depth;
        if (animate) {
            snapshot = Bitmap.createBitmap(getWidth(), getHeight(), Bitmap.Config.ARGB_8888);
            page.draw(new Canvas(snapshot));
        }
        removeAllViews();
        page = next; route = nextRoute; depth = nextDepth;
        addView(page, new FrameLayout.LayoutParams(-1, -1));
        if (!animate) return;
        outgoing = new ImageView(getContext());
        outgoing.setImageBitmap(snapshot);
        outgoing.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(outgoing, back ? 1 : 0, new FrameLayout.LayoutParams(-1, -1));
        float width = getWidth();
        page.setTranslationX(back ? -width * 0.3f : width);
        pending = () -> {
            getViewTreeObserver().removeOnPreDrawListener(pending); pending = null;
            animation = new AnimatorSet();
            animation.playTogether(ObjectAnimator.ofFloat(page, View.TRANSLATION_X, 0f),
                ObjectAnimator.ofFloat(outgoing, View.TRANSLATION_X, back ? width : -width * 0.3f));
            animation.setDuration(getResources().getInteger(R.integer.page_transition_duration));
            animation.setInterpolator(AnimationUtils.loadInterpolator(getContext(), R.interpolator.page_ease));
            animation.addListener(new AnimatorListenerAdapter() {
                @Override public void onAnimationEnd(Animator animator) { finishTransition(); }
            });
            animation.start();
            return true;
        };
        getViewTreeObserver().addOnPreDrawListener(pending);
    }

    void finishTransition() {
        if (pending != null) {
            if (getViewTreeObserver().isAlive()) getViewTreeObserver().removeOnPreDrawListener(pending);
            pending = null;
        }
        if (animation != null) {
            animation.removeAllListeners(); animation.cancel(); animation = null;
        }
        if (page != null) page.setTranslationX(0f);
        if (outgoing != null) {
            outgoing.setImageDrawable(null); removeView(outgoing); outgoing = null;
        }
        if (snapshot != null) { snapshot.recycle(); snapshot = null; }
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        return outgoing != null || super.dispatchTouchEvent(event);
    }

    @Override protected void onDetachedFromWindow() {
        finishTransition(); super.onDetachedFromWindow();
    }

    static void configureActivity(Activity activity) {
        if (Build.VERSION.SDK_INT >= 34) {
            activity.overrideActivityTransition(Activity.OVERRIDE_TRANSITION_OPEN, R.anim.page_push_enter, R.anim.page_push_exit);
            activity.overrideActivityTransition(Activity.OVERRIDE_TRANSITION_CLOSE, R.anim.page_pop_enter, R.anim.page_pop_exit);
        }
    }

    static void openActivity(Activity activity) {
        if (Build.VERSION.SDK_INT < 34) activity.overridePendingTransition(R.anim.page_push_enter, R.anim.page_push_exit);
    }

    static void closeActivity(Activity activity) {
        if (Build.VERSION.SDK_INT < 34) activity.overridePendingTransition(R.anim.page_pop_enter, R.anim.page_pop_exit);
    }
}
