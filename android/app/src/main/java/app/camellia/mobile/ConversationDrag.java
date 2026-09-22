package app.camellia.mobile;

import android.animation.ValueAnimator;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Point;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.view.DragEvent;
import android.view.View;
import android.view.animation.PathInterpolator;
import android.widget.ScrollView;
import java.util.ArrayList;

final class ConversationDrag {
    interface Move { void apply(String id, String workspace, String target, boolean after); }
    private record Target(View view, String workspace, String id) {}
    private final View root;
    private final ScrollView scroll;
    private final Move move;
    private final ArrayList<Target> targets = new ArrayList<>();
    private View source;
    private String sourceId;
    private Target target;
    private GradientDrawable indicator;
    private boolean after;
    private float screenX, screenY;
    private final PathInterpolator easing = new PathInterpolator(.2f, .8f, .2f, 1f);
    private ValueAnimator lift, highlight;
    private LiftShadow shadow;
    private long lastFrame;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (source == null) return;
            Rect bounds = new Rect(); scroll.getGlobalVisibleRect(bounds);
            int edge = (int) (40 * root.getResources().getDisplayMetrics().density);
            if (bounds.contains((int) screenX, (int) screenY)) {
                float distance = screenY < bounds.top + edge ? screenY - bounds.top - edge
                    : screenY > bounds.bottom - edge ? screenY - bounds.bottom + edge : 0;
                long now = android.os.SystemClock.uptimeMillis();
                float elapsed = lastFrame == 0 ? 16 : Math.min(32, now - lastFrame);
                scroll.scrollBy(0, Math.round(distance * elapsed / 64));
                lastFrame = now;
            }
            locate(); root.postOnAnimation(this);
        }
    };

    ConversationDrag(View root, ScrollView scroll, Move move) {
        this.root = root; this.scroll = scroll; this.move = move;
        root.setOnDragListener((view, event) -> {
            if (event.getLocalState() != this) return false;
            switch (event.getAction()) {
                case DragEvent.ACTION_DRAG_STARTED: return true;
                case DragEvent.ACTION_DRAG_LOCATION:
                    int[] location = new int[2]; root.getLocationOnScreen(location);
                    screenX = location[0] + event.getX(); screenY = location[1] + event.getY(); locate(); return true;
                case DragEvent.ACTION_DRAG_EXITED: clearIndicator(); target = null; previewGap(); screenX = -1; screenY = -1; return true;
                case DragEvent.ACTION_DROP:
                    Target selected = target; String id = sourceId; boolean placeAfter = after;
                    finish();
                    if (selected != null) move.apply(id, selected.workspace, selected.id, placeAfter);
                    return selected != null;
                case DragEvent.ACTION_DRAG_ENDED: finish(); return true;
                default: return true;
            }
        });
    }

    void target(View view, String workspace, String id) { targets.add(new Target(view, workspace, id)); }

    void source(View view, String id) {
        view.setOnLongClickListener(selected -> {
            if (source != null) return true;
            selected.animate().cancel(); selected.setAlpha(1);
            source = selected; sourceId = id;
            shadow = new LiftShadow(selected);
            if (!selected.startDragAndDrop(null, shadow, this, 0)) { finish(); return false; }
            selected.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
            selected.animate().alpha(.28f).setDuration(duration(180)).setInterpolator(easing).start();
            if (ValueAnimator.areAnimatorsEnabled()) {
                lift = ValueAnimator.ofFloat(0, 1); lift.setDuration(220); lift.setInterpolator(easing);
                lift.addUpdateListener(animation -> {
                    if (source == null || shadow == null) return;
                    shadow.progress = (float) animation.getAnimatedValue(); source.updateDragShadow(shadow);
                });
                lift.start();
            } else { shadow.progress = 1; selected.updateDragShadow(shadow); }
            screenX = -1; screenY = -1; lastFrame = 0; root.postOnAnimation(tick);
            return true;
        });
    }

    boolean active() { return source != null; }
    void cancel() { if (source != null) source.cancelDragAndDrop(); finish(); }

    private void locate() {
        Target next = null;
        boolean nextAfter = false;
        Rect visible = new Rect();
        for (Target candidate : targets) {
            float translation = candidate.view.getTranslationY();
            boolean shown = candidate.view.getGlobalVisibleRect(visible);
            visible.offset(0, -Math.round(translation));
            if (shown && visible.contains((int) screenX, (int) screenY)) {
                next = java.util.Objects.equals(candidate.id, sourceId) ? null : candidate;
                nextAfter = screenY >= visible.exactCenterY();
            }
        }
        if (next == target && (next == null || next.id == null || nextAfter == after)) return;
        clearIndicator(); target = next; after = nextAfter;
        previewGap();
        if (target == null) return;
        int thickness = Math.max(2, (int) (2 * root.getResources().getDisplayMetrics().density));
        indicator = new GradientDrawable();
        if (target.id == null) {
            indicator.setColor(Color.TRANSPARENT); indicator.setStroke(thickness, 0xff4176e6);
            indicator.setCornerRadius(thickness * 4); indicator.setBounds(0, 0, target.view.getWidth(), target.view.getHeight());
        } else {
            indicator.setColor(0xff4176e6);
            int top = after ? target.view.getHeight() - thickness : 0;
            indicator.setBounds(0, top, target.view.getWidth(), top + thickness);
        }
        target.view.getOverlay().add(indicator);
        if (ValueAnimator.areAnimatorsEnabled()) {
            indicator.setAlpha(0);
            highlight = ValueAnimator.ofInt(0, 255); highlight.setDuration(130);
            highlight.addUpdateListener(animation -> { if (indicator != null) indicator.setAlpha((int) animation.getAnimatedValue()); });
            highlight.start();
        }
    }

    private long duration(long milliseconds) { return ValueAnimator.areAnimatorsEnabled() ? milliseconds : 0; }

    private void previewGap() {
        float gap = 5 * root.getResources().getDisplayMetrics().density;
        for (Target candidate : targets) {
            if (candidate.id == null) continue;
            float offset = 0;
            if (target != null && target.id != null && candidate.view != source
                && candidate.view.getParent() == target.view.getParent()) {
                boolean below = candidate.view.getTop() > target.view.getTop() || candidate == target && !after;
                offset = below ? gap : -gap;
            }
            candidate.view.animate().translationY(offset).setDuration(duration(180)).setInterpolator(easing).start();
        }
    }

    private void clearIndicator() {
        if (highlight != null) { highlight.cancel(); highlight = null; }
        if (target != null && indicator != null) target.view.getOverlay().remove(indicator);
        indicator = null;
    }

    private void finish() {
        root.removeCallbacks(tick); clearIndicator(); target = null;
        if (lift != null) { lift.cancel(); lift = null; }
        if (shadow != null) { shadow.dispose(); shadow = null; }
        previewGap();
        if (source != null) source.animate().alpha(1).setDuration(duration(180)).setInterpolator(easing).start();
        source = null; sourceId = null;
    }

    private static final class LiftShadow extends View.DragShadowBuilder {
        private final Bitmap snapshot;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        private final float padding, radius;
        private final int background;
        private float progress;

        LiftShadow(View view) {
            super(view);
            float density = view.getResources().getDisplayMetrics().density;
            padding = 24 * density; radius = 12 * density;
            background = (view.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES ? 0xff292b30 : 0xfffafbfc;
            snapshot = Bitmap.createBitmap(Math.max(1, view.getWidth()), Math.max(1, view.getHeight()), Bitmap.Config.ARGB_8888);
            view.draw(new Canvas(snapshot));
        }

        @Override public void onProvideShadowMetrics(Point size, Point touch) {
            size.set((int) (snapshot.getWidth() + padding * 2), (int) (snapshot.getHeight() + padding * 2));
            touch.set(size.x / 2, size.y / 2);
        }

        @Override public void onDrawShadow(Canvas canvas) {
            if (snapshot.isRecycled()) return;
            canvas.save();
            canvas.translate(padding, padding);
            float scale = 1 + .035f * progress;
            canvas.scale(scale, scale, snapshot.getWidth() / 2f, snapshot.getHeight() / 2f);
            paint.setColor(background);
            paint.setShadowLayer(radius * (.3f + .5f * progress), 0, radius * .35f * progress, 0x38000000);
            canvas.drawRoundRect(0, 0, snapshot.getWidth(), snapshot.getHeight(), radius, radius, paint);
            paint.clearShadowLayer();
            canvas.drawBitmap(snapshot, 0, 0, paint);
            canvas.restore();
        }

        void dispose() { snapshot.recycle(); }
    }
}
