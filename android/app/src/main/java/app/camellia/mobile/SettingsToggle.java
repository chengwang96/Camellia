package app.camellia.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.widget.Switch;

/** Switch behavior with an outlined track and a softly shaded thumb. */
@android.annotation.SuppressLint("ViewConstructor")
final class SettingsToggle extends Switch {
    private final Palette palette;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    SettingsToggle(Context context) { super(context); palette = Palette.of(context); setShowText(false); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public void onMeasure(int width, int height) { setMeasuredDimension(resolveSize(dp(52), width), resolveSize(dp(48), height)); }

    @Override protected void onDraw(Canvas canvas) {
        float left = (getWidth() - dp(48)) / 2f, top = (getHeight() - dp(28)) / 2f;
        float edge = Math.max(1f, dp(1));
        int alpha = isEnabled() ? 255 : 105;
        float pressedInset = isPressed() ? dp(1) : 0;

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(isChecked() ? palette.ink : palette.trackOff);
        paint.setAlpha(alpha);
        canvas.drawRoundRect(left, top, left + dp(48), top + dp(28), dp(14), dp(14), paint);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(edge);
        paint.setColor(isChecked() ? palette.selectedBorder : palette.cardBorder);
        paint.setAlpha(alpha);
        canvas.drawRoundRect(left + edge / 2f, top + edge / 2f, left + dp(48) - edge / 2f,
            top + dp(28) - edge / 2f, dp(14), dp(14), paint);

        boolean right = isChecked() != (getLayoutDirection() == LAYOUT_DIRECTION_RTL);
        float thumbX = left + dp(right ? 34 : 14);
        float thumbY = top + dp(14);
        float radius = Math.max(dp(10), dp(12) - pressedInset);

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(0x30000000);
        paint.setAlpha(Math.round(0x30 * alpha / 255f));
        float density = getResources().getDisplayMetrics().density;
        canvas.drawCircle(thumbX, thumbY + dp(1), radius + 0.5f * density, paint);

        paint.setColor(isChecked() ? palette.card : Color.WHITE);
        paint.setAlpha(alpha);
        canvas.drawCircle(thumbX, thumbY, radius, paint);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(Math.max(0.75f, 0.75f * density));
        paint.setColor(palette.cardBorder);
        paint.setAlpha(alpha);
        canvas.drawCircle(thumbX, thumbY, radius, paint);
    }

    @Override protected void drawableStateChanged() {
        super.drawableStateChanged();
        invalidate();
    }
}
