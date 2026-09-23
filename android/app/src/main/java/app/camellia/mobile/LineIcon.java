package app.camellia.mobile;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;

final class LineIcon extends Drawable {
    private final String kind;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    LineIcon(String kind, int color) {
        this.kind = kind; paint.setColor(color); paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1.7f); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
    }

    @Override public void draw(Canvas canvas) {
        canvas.save(); canvas.translate(getBounds().left, getBounds().top);
        canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
        Path path = new Path();
        switch (kind) {
            case "edit":
                path.moveTo(4, 16); path.lineTo(16, 4); path.lineTo(20, 8); path.lineTo(8, 20); path.lineTo(3, 21); path.close();
                path.moveTo(14, 6); path.lineTo(18, 10); canvas.drawPath(path, paint); break;
            case "select":
                for (int row = 0; row < 3; row++) {
                    float top = 5 + row * 7;
                    path.moveTo(3, top); path.lineTo(5, top + 2); path.lineTo(8, top - 2);
                    path.moveTo(12, top); path.lineTo(21, top);
                }
                canvas.drawPath(path, paint); break;
            case "pin":
                path.moveTo(7, 3); path.lineTo(17, 3); path.moveTo(9, 3); path.lineTo(9, 9);
                path.lineTo(5, 14); path.lineTo(19, 14); path.lineTo(15, 9); path.lineTo(15, 3);
                path.moveTo(12, 14); path.lineTo(12, 22); canvas.drawPath(path, paint); break;
            case "delete":
                path.moveTo(3, 6); path.lineTo(21, 6); path.moveTo(9, 3); path.lineTo(15, 3);
                path.moveTo(6, 6); path.lineTo(7, 21); path.lineTo(17, 21); path.lineTo(18, 6);
                path.moveTo(10, 10); path.lineTo(10, 17); path.moveTo(14, 10); path.lineTo(14, 17);
                canvas.drawPath(path, paint); break;
            case "code-nowrap":
                path.moveTo(12, 3); path.lineTo(12, 8); path.moveTo(12, 16); path.lineTo(12, 21);
                path.moveTo(3, 12); path.lineTo(21, 12); path.moveTo(17, 8); path.lineTo(21, 12); path.lineTo(17, 16);
                canvas.drawPath(path, paint); break;
            case "code-wrap":
                path.moveTo(21, 3); path.lineTo(21, 21); path.moveTo(3, 7); path.lineTo(11, 7);
                path.cubicTo(16.33f, 7, 16.33f, 15, 11, 15); path.lineTo(3, 15);
                path.moveTo(7, 11); path.lineTo(3, 15); path.lineTo(7, 19);
                canvas.drawPath(path, paint); break;
            case "copy":
                canvas.drawRoundRect(8, 8, 21, 21, 2.5f, 2.5f, paint);
                path.moveTo(5, 16); path.lineTo(4, 16); path.quadTo(2, 16, 2, 14); path.lineTo(2, 4);
                path.quadTo(2, 2, 4, 2); path.lineTo(14, 2); path.quadTo(16, 2, 16, 4); path.lineTo(16, 5);
                canvas.drawPath(path, paint); break;
            case "shield":
                path.moveTo(12, 2); path.lineTo(21, 6); path.lineTo(20, 15); path.quadTo(18, 20, 12, 23);
                path.quadTo(6, 20, 4, 15); path.lineTo(3, 6); path.close(); canvas.drawPath(path, paint);
                canvas.drawLine(8, 12, 11, 15, paint); canvas.drawLine(11, 15, 16, 9, paint); break;
            case "key":
                canvas.drawCircle(8, 8, 4.5f, paint); path.moveTo(11.5f, 11.5f); path.lineTo(21, 21); path.moveTo(16, 16); path.lineTo(19, 13);
                path.moveTo(18.5f, 18.5f); path.lineTo(21.5f, 15.5f); canvas.drawPath(path, paint); break;
            case "archive":
                canvas.drawRoundRect(3, 3, 21, 8, 1.5f, 1.5f, paint); path.moveTo(5, 8); path.lineTo(5, 21); path.lineTo(19, 21); path.lineTo(19, 8);
                path.moveTo(9, 12); path.lineTo(15, 12); canvas.drawPath(path, paint); break;
            case "appearance":
                canvas.drawCircle(12, 12, 4, paint);
                for (int index = 0; index < 8; index++) {
                    double angle = index * Math.PI / 4;
                    canvas.drawLine(12 + (float) Math.cos(angle) * 8, 12 + (float) Math.sin(angle) * 8,
                        12 + (float) Math.cos(angle) * 10, 12 + (float) Math.sin(angle) * 10, paint);
                }
                break;
            case "language":
                canvas.drawCircle(12, 12, 9, paint); canvas.drawOval(8, 3, 16, 21, paint); canvas.drawLine(3, 12, 21, 12, paint); break;
            case "settings":
                canvas.drawLine(3, 6, 21, 6, paint); canvas.drawLine(3, 12, 21, 12, paint); canvas.drawLine(3, 18, 21, 18, paint);
                canvas.drawCircle(8, 6, 2, paint); canvas.drawCircle(16, 12, 2, paint); canvas.drawCircle(10, 18, 2, paint); break;
            case "close": canvas.drawLine(6, 6, 18, 18, paint); canvas.drawLine(18, 6, 6, 18, paint); break;
            case "back": path.moveTo(15, 4); path.lineTo(7, 12); path.lineTo(15, 20); canvas.drawPath(path, paint); break;
            case "search": canvas.drawCircle(10.5f, 10.5f, 6.5f, paint); canvas.drawLine(16, 16, 21, 21, paint); break;
            case "folder":
                path.moveTo(3, 18); path.lineTo(3, 7); path.quadTo(3, 5.2f, 5, 5.2f); path.lineTo(10, 5.2f); path.lineTo(13, 7.8f); path.lineTo(19, 7.8f); path.quadTo(21, 7.8f, 21, 9.5f);
                path.moveTo(3, 18); path.lineTo(6, 10.3f); path.lineTo(22, 10.3f); path.lineTo(19, 18.8f); path.lineTo(3, 18.8f); canvas.drawPath(path, paint); break;
            case "computer": canvas.drawRoundRect(4, 3, 20, 15, 2, 2, paint); canvas.drawLine(12, 15, 12, 20, paint); canvas.drawLine(7, 20, 17, 20, paint); break;
            case "phone": canvas.drawRoundRect(6, 2, 18, 22, 3, 3, paint); canvas.drawLine(10, 18, 14, 18, paint); break;
            case "more":
                canvas.drawCircle(5, 12, .8f, paint); canvas.drawCircle(12, 12, .8f, paint); canvas.drawCircle(19, 12, .8f, paint); break;
            case "new":
                path.moveTo(5, 17); path.cubicTo(-1, 5, 11, 0, 18, 5); path.cubicTo(26, 12, 20, 22, 10, 20); path.lineTo(3, 21); path.close(); canvas.drawPath(path, paint);
                canvas.drawLine(9, 12, 17, 12, paint); canvas.drawLine(13, 8, 13, 16, paint); break;
            case "down": path.moveTo(6, 9); path.lineTo(12, 15); path.lineTo(18, 9); canvas.drawPath(path, paint); break;
            case "right": path.moveTo(9, 6); path.lineTo(15, 12); path.lineTo(9, 18); canvas.drawPath(path, paint); break;
            default: canvas.drawLine(5, 12, 19, 12, paint); canvas.drawLine(12, 5, 12, 19, paint); break;
        }
        canvas.restore();
    }

    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
