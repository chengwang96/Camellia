package app.camellia.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

/** A compact one-line state label with a tonal fill. */
@android.annotation.SuppressLint("ViewConstructor")
final class StatusPill extends TextView {
    StatusPill(Context context, String label, int color) {
        super(context);
        setText(label);
        setTextSize(Palette.TEXT_TINY);
        setTextColor(color);
        setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        setGravity(Gravity.CENTER);
        setSingleLine(true);
        setEllipsize(TextUtils.TruncateAt.END);
        setMaxWidth(dp(210));
        setPadding(dp(7), dp(3), dp(7), dp(3));
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        GradientDrawable fill = new GradientDrawable();
        fill.setShape(GradientDrawable.RECTANGLE);
        fill.setCornerRadius(dp(999));
        fill.setColor(Color.argb(20, Color.red(color), Color.green(color), Color.blue(color)));
        setBackground(fill);
    }

    static int colorFor(String state, Palette palette) {
        if (state == null) return palette.muted;
        if (state.equals("running")) return palette.success;
        if (state.equals("permission") || state.equals("question") || state.equals("waiting")) return palette.warning;
        if (state.equals("draft")) return palette.error;
        if (state.equals("failed") || state.equals("error") || state.equals("offline")) return palette.error;
        return palette.muted;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
