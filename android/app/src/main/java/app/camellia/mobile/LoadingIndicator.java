package app.camellia.mobile;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.os.SystemClock;
import android.view.View;

final class LoadingIndicator extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    LoadingIndicator(Context context) {
        super(context);
        paint.setColor(new ChatStyle(context).muted); paint.setStrokeCap(Paint.Cap.ROUND);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float radius = Math.min(getWidth(), getHeight()) / 2f;
        paint.setStrokeWidth(radius * .19f);
        int phase = ValueAnimator.areAnimatorsEnabled() ? (int) (SystemClock.uptimeMillis() / 75 % 12) : 0;
        int saved = canvas.save(); canvas.translate(getWidth() / 2f, getHeight() / 2f);
        for (int index = 0; index < 12; index++) {
            paint.setAlpha(55 + (index - phase + 12) % 12 * 18);
            canvas.drawLine(0, -radius * .5f, 0, -radius * .82f, paint); canvas.rotate(30);
        }
        canvas.restoreToCount(saved);
        if (isShown() && getWindowVisibility() == VISIBLE && ValueAnimator.areAnimatorsEnabled()) postInvalidateOnAnimation();
    }
}
