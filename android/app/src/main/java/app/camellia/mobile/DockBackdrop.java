package app.camellia.mobile;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;

// Opaque mask for the bottom dock. The fill starts below the fade band so the gradient
// composites over scrolling content instead of over an opaque surface, and getPadding()
// stays empty so the backdrop never shifts the dock's children.
final class DockBackdrop extends Drawable {
    private final Paint paint = new Paint();
    private final int fadeHeight;

    DockBackdrop(int color, int fadeHeight) { paint.setColor(color); this.fadeHeight = fadeHeight; }

    @Override public void draw(Canvas canvas) {
        Rect bounds = getBounds();
        int top = bounds.top + fadeHeight;
        if (top < bounds.bottom) canvas.drawRect(bounds.left, top, bounds.right, bounds.bottom, paint);
    }

    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }

    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }

    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
