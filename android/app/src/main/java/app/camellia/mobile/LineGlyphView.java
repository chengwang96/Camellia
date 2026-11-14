package app.camellia.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.view.View;

/**
 * Draws a {@link LineIcon} into an explicit viewport.
 *
 * <p>An ImageView can render the same drawable, but its bounds are configured
 * later in the view pipeline. The permission control is a small always-visible
 * glyph, so keeping the bounds here makes the drawing path deterministic.
 */
@SuppressLint("ViewConstructor")
final class LineGlyphView extends View {
    private LineIcon icon;
    private final int inset;

    LineGlyphView(Context context, String kind, int color) {
        super(context);
        inset = Math.max(1, Math.round(context.getResources().getDisplayMetrics().density));
        glyph(kind, color);
        setWillNotDraw(false);
    }

    void glyph(String kind, int color) {
        icon = new LineIcon(kind, color);
        invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        if (icon == null) return;
        int left = getPaddingLeft() + inset;
        int top = getPaddingTop() + inset;
        int right = getWidth() - getPaddingRight() - inset;
        int bottom = getHeight() - getPaddingBottom() - inset;
        int size = Math.min(right - left, bottom - top);
        if (size <= 0) return;
        int drawLeft = left + (right - left - size) / 2;
        int drawTop = top + (bottom - top - size) / 2;
        icon.setBounds(drawLeft, drawTop, drawLeft + size, drawTop + size);
        icon.draw(canvas);
    }
}
