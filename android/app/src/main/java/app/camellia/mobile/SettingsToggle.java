package app.camellia.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.widget.Switch;

/** Native switch behavior with a neutral track and a visible thumb in both themes. */
@android.annotation.SuppressLint("ViewConstructor")
final class SettingsToggle extends Switch {
    private final Palette palette;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    SettingsToggle(Context context) { super(context); palette = Palette.of(context); setShowText(false); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public void onMeasure(int width, int height) { setMeasuredDimension(resolveSize(dp(48), width), resolveSize(dp(48), height)); }
    @Override protected void onDraw(Canvas canvas) {
        float left = (getWidth() - dp(48)) / 2f, top = (getHeight() - dp(28)) / 2f;
        paint.setColor(isChecked() ? palette.ink : palette.trackOff); paint.setAlpha(isEnabled() ? 255 : 115);
        canvas.drawRoundRect(left, top, left + dp(48), top + dp(28), dp(14), dp(14), paint);
        boolean right = isChecked() != (getLayoutDirection() == LAYOUT_DIRECTION_RTL);
        paint.setColor(isChecked() ? palette.background : Color.WHITE); paint.setAlpha(isEnabled() ? 255 : 115);
        canvas.drawCircle(left + dp(right ? 34 : 14), top + dp(14), dp(12), paint);
    }
}
