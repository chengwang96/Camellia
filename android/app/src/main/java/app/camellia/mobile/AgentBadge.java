package app.camellia.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

/** A compact engine mark used by session rows and work cards. */
@android.annotation.SuppressLint("ViewConstructor")
final class AgentBadge extends TextView {
    AgentBadge(Context context, String engine, int sizeDp) {
        super(context);
        int color = color(engine);
        setTag("agentBadge");
        setText(initial(engine));
        setTextSize(11);
        setTextColor(color);
        setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        setGravity(Gravity.CENTER);
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        GradientDrawable face = new GradientDrawable();
        face.setShape(GradientDrawable.RECTANGLE);
        face.setCornerRadius(dp(sizeDp * 0.3f));
        face.setColor(Color.argb(30, Color.red(color), Color.green(color), Color.blue(color)));
        setBackground(face);
        setMinWidth(dp(sizeDp));
        setMinHeight(dp(sizeDp));
    }

    private static String initial(String engine) {
        if (engine == null || engine.isEmpty() || engine.equals("null")) return "•";
        return switch (engine) {
            case "codex" -> "C";
            case "claude" -> "Cl";
            case "kimi" -> "K";
            case "dsh" -> "D";
            case "antigravity" -> "A";
            case "grok" -> "G";
            default -> engine.isBlank() ? "A" : engine.substring(0, 1).toUpperCase(java.util.Locale.ROOT);
        };
    }

    private static int color(String engine) {
        return switch (engine == null ? "" : engine) {
            case "codex" -> Color.rgb(77, 107, 254);
            case "claude" -> Color.rgb(194, 96, 61);
            case "kimi" -> Color.rgb(75, 103, 180);
            case "dsh" -> Color.rgb(49, 95, 209);
            case "antigravity" -> Color.rgb(52, 120, 196);
            case "grok" -> Color.rgb(72, 78, 89);
            default -> Color.rgb(105, 113, 123);
        };
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
