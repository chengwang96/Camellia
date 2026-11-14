package app.camellia.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/** A drawn checkbox/radio indicator; never a platform widget. */
@android.annotation.SuppressLint("ViewConstructor")
final class SelectionMark extends View {
    private final Palette palette;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path tick = new Path();
    private final boolean circular;
    private boolean checked;

    SelectionMark(Context context, boolean circular) {
        super(context);
        this.circular = circular;
        palette = Palette.of(context);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }

    void setChecked(boolean value) {
        if (checked == value) return;
        checked = value;
        invalidate();
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int size = Math.round(dp(22));
        setMeasuredDimension(resolveSize(size, widthSpec), resolveSize(size, heightSpec));
    }

    @Override protected void onDraw(Canvas canvas) {
        float stroke = Math.max(1f, dp(1));
        float inset = stroke / 2f + dp(0.5f);
        float radius = circular ? (getWidth() - inset * 2) / 2f : dp(5);

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(checked ? palette.accent : palette.card);
        canvas.drawRoundRect(inset, inset, getWidth() - inset, getHeight() - inset, radius, radius, paint);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(stroke);
        paint.setColor(checked ? palette.accent : palette.selectedBorder);
        canvas.drawRoundRect(inset, inset, getWidth() - inset, getHeight() - inset, radius, radius, paint);

        if (!checked) return;
        tick.reset();
        tick.moveTo(getWidth() * .29f, getHeight() * .52f);
        tick.lineTo(getWidth() * .44f, getHeight() * .67f);
        tick.lineTo(getWidth() * .72f, getHeight() * .36f);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2));
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        paint.setColor(0xffffffff);
        canvas.drawPath(tick, paint);
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
