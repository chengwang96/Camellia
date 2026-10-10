package app.camellia.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.text.Spanned;
import android.text.style.ReplacementSpan;
import org.scilab.forge.jlatexmath.TeXConstants;
import org.scilab.forge.jlatexmath.TeXFormula;
import org.scilab.forge.jlatexmath.TeXIcon;
import ru.noties.jlatexmath.JLatexMathAndroid;
import ru.noties.jlatexmath.awt.AndroidGraphics2D;
import ru.noties.jlatexmath.awt.Color;

/** A selectable, baseline-aligned native formula. Invalid TeX remains readable text. */
final class MathSpan extends ReplacementSpan {
    final String source;
    private final String latex;
    private final boolean display;
    private final int color;
    private TeXIcon icon;
    private float size = -1;
    private final AndroidGraphics2D graphics = new AndroidGraphics2D();

    MathSpan(Context context, MarkdownMath.Formula formula, int color) {
        JLatexMathAndroid.init(context);
        source = formula.source(); latex = formula.literal(); display = formula.display(); this.color = color;
    }

    private void prepare(Paint paint) {
        if (size == paint.getTextSize()) return;
        size = paint.getTextSize(); icon = null;
        if (latex.isEmpty() || latex.length() > 4096) return;
        int depth = 0;
        for (int i = 0; i < latex.length(); i++) {
            if (latex.charAt(i) == '{' && ++depth > 64) return;
            if (latex.charAt(i) == '}') depth--;
        }
        try {
            TeXIcon parsed = new TeXFormula(latex).new TeXIconBuilder()
                .setStyle(display ? TeXConstants.STYLE_DISPLAY : TeXConstants.STYLE_TEXT)
                .setSize(size).setFGColor(new Color(color)).build();
            if (parsed.getIconWidth() <= 16384 && parsed.getIconHeight() <= 4096) icon = parsed;
        } catch (RuntimeException | StackOverflowError invalid) { /* Keep the original TeX visible. */ }
    }

    boolean rendered() { return icon != null; }

    @Override public int getSize(Paint paint, CharSequence text, int start, int end, Paint.FontMetricsInt metrics) {
        prepare(paint);
        if (icon == null) {
            if (metrics != null) paint.getFontMetricsInt(metrics);
            return (int) Math.ceil(paint.measureText(text, start, end));
        }
        if (metrics != null) {
            Paint.FontMetricsInt original = paint.getFontMetricsInt();
            int descent = icon.getIconDepth(), ascent = descent - icon.getIconHeight();
            metrics.ascent = Math.min(original.ascent, ascent); metrics.descent = Math.max(original.descent, descent);
            metrics.top = Math.min(original.top, metrics.ascent); metrics.bottom = Math.max(original.bottom, metrics.descent);
        }
        return icon.getIconWidth();
    }

    @Override public void draw(Canvas canvas, CharSequence text, int start, int end, float x, int top, int y, int bottom, Paint paint) {
        prepare(paint);
        if (icon == null) { canvas.drawText(text, start, end, x, y, paint); return; }
        int save = canvas.save();
        try {
            canvas.translate(x, y - icon.getIconHeight() + icon.getIconDepth());
            graphics.setCanvas(canvas); icon.paintIcon(null, graphics, 0, 0);
        } finally { canvas.restoreToCount(save); }
    }

    /** Restore line breaks when copying formulas whose display text occupies one Android paragraph. */
    static String copy(Spanned text, int start, int end) {
        StringBuilder result = new StringBuilder(); int offset = start;
        MathSpan[] spans = text.getSpans(start, end, MathSpan.class);
        java.util.Arrays.sort(spans, java.util.Comparator.comparingInt(text::getSpanStart));
        for (MathSpan span : spans) {
            int from = text.getSpanStart(span), to = text.getSpanEnd(span);
            if (from < offset || to > end) continue;
            result.append(text, offset, from).append(span.source); offset = to;
        }
        return result.append(text, offset, end).toString();
    }
}
