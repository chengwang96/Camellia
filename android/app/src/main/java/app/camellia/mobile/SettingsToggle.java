package app.camellia.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.widget.Switch;

/** Native switch movement and touch geometry with Camellia's track and thumb. */
@android.annotation.SuppressLint("ViewConstructor")
final class SettingsToggle extends Switch {
    private final Palette palette;
    SettingsToggle(Context context) {
        super(context);
        palette = Palette.of(context);
        setShowText(false); setText(null); setSplitTrack(false);
        // A platform ripple uses the native thumb bounds. Keeping it behind a
        // separately painted switch left an offset halo after release.
        setBackground(null); setForeground(null); setButtonDrawable((Drawable) null);
        setDefaultFocusHighlightEnabled(false);
        setThumbTintList(null); setTrackTintList(null);
        setSwitchMinWidth(dp(48)); setSwitchPadding(0); setThumbTextPadding(0);
        setPadding(dp(2), dp(10), dp(2), dp(10));
        setMinimumWidth(dp(52)); setMinimumHeight(dp(48));
        setTrackDrawable(new Surface(false)); setThumbDrawable(new Surface(true));
        // Switch.onMeasure/onLayout and its own thumb animator now operate on
        // the same drawables that are visible, including drag, RTL and cancel.
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private int blend(int from, int to, float amount) {
        return Color.rgb(Math.round(Color.red(from) * (1 - amount) + Color.red(to) * amount),
            Math.round(Color.green(from) * (1 - amount) + Color.green(to) * amount),
            Math.round(Color.blue(from) * (1 - amount) + Color.blue(to) * amount));
    }

    private final class Surface extends Drawable {
        private final boolean thumb;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private int opacity = 255;

        Surface(boolean thumb) { this.thumb = thumb; }
        @Override public int getIntrinsicWidth() { return dp(thumb ? 24 : 48); }
        @Override public int getIntrinsicHeight() { return dp(28); }
        @Override public boolean isStateful() { return true; }
        @Override protected boolean onStateChange(int[] state) { invalidateSelf(); return true; }
        @Override public void setAlpha(int alpha) { opacity = alpha; invalidateSelf(); }
        @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }

        private boolean has(int attribute) {
            for (int state : getState()) if (state == attribute) return true;
            return false;
        }

        @Override public void draw(Canvas canvas) {
            Rect bounds = getBounds();
            boolean checked = has(android.R.attr.state_checked), enabled = has(android.R.attr.state_enabled);
            boolean pressed = enabled && has(android.R.attr.state_pressed);
            int alpha = enabled ? opacity : Math.round(opacity * 105 / 255f);
            float density = getResources().getDisplayMetrics().density;
            float edge = Math.max(1f, density);
            if (thumb) {
                float x = bounds.exactCenterX(), y = bounds.exactCenterY();
                float radius = Math.min(bounds.width() / 2f - density, bounds.height() / 2f - 3 * density);
                paint.setStyle(Paint.Style.FILL); paint.setColor(0x30000000); paint.setAlpha(Math.round(alpha * 0x30 / 255f));
                canvas.drawCircle(x, y + .75f * density, radius + .5f * density, paint);
                int fill = checked ? palette.card : Color.WHITE;
                paint.setColor(pressed ? blend(fill, palette.ink, .05f) : fill); paint.setAlpha(alpha);
                canvas.drawCircle(x, y, radius, paint);
                paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(.75f * density);
                paint.setColor(palette.cardBorder); paint.setAlpha(alpha);
                canvas.drawCircle(x, y, radius, paint);
            } else {
                int fill = checked ? palette.ink : palette.trackOff;
                if (pressed) fill = blend(fill, checked ? palette.card : palette.ink, .10f);
                paint.setStyle(Paint.Style.FILL); paint.setColor(fill); paint.setAlpha(alpha);
                canvas.drawRoundRect(bounds.left, bounds.top, bounds.right, bounds.bottom, dp(14), dp(14), paint);
                paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(edge);
                paint.setColor(enabled && has(android.R.attr.state_focused) ? palette.accent
                    : checked ? palette.selectedBorder : palette.cardBorder); paint.setAlpha(alpha);
                canvas.drawRoundRect(bounds.left + edge / 2, bounds.top + edge / 2,
                    bounds.right - edge / 2, bounds.bottom - edge / 2, dp(14), dp(14), paint);
            }
        }
    }
}
