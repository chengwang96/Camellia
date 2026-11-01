package app.camellia.mobile;

import android.app.AlertDialog;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.Locale;

/** Shared local/remote footer and a scrollable accounting sheet. */
final class TurnUsage {
    private TurnUsage() {}

    static void bind(LinearLayout wrapper, JSONObject json, boolean chinese) {
        if (wrapper == null) return;
        LinearLayout footer = wrapper.findViewWithTag("messageFooter");
        if (footer == null) return;
        String signature = json == null ? "" : json.toString();
        View previous = footer.findViewWithTag("turnUsage");
        // The signature is stored separately from the spoken button label.
        if (previous instanceof UsageButton && signature.equals(((UsageButton) previous).signature)) return;
        if (previous != null) footer.removeView(previous);
        TurnDetails details = new TurnDetails(json); if (!details.hasUsage()) return;
        ChatStyle style = new ChatStyle(wrapper.getContext());
        UsageButton button = new UsageButton(wrapper.getContext(), signature);
        button.setTag("turnUsage"); button.setText(wrapper.getContext().getString(R.string.turn_usage_summary, compact(details.total())));
        button.setTextSize(Palette.TEXT_SMALL); button.setTextColor(style.faint); button.setGravity(Gravity.CENTER);
        button.setPadding(style.dp(6), 0, style.dp(6), 0); button.setMinimumHeight(style.dp(48)); button.setFocusable(true);
        button.setContentDescription((chinese ? "本轮用量 " : "Turn usage ") + TurnDetails.tokens(details.total()));
        button.setOnClickListener(view -> show(button, details, chinese));
        footer.addView(button, Math.min(1, footer.getChildCount()), new LinearLayout.LayoutParams(-2, -1));
    }

    private static final class UsageButton extends TextView {
        final String signature;
        AlertDialog dialog;
        UsageButton(android.content.Context context, String signature) { super(context); this.signature = signature; }
        @Override protected void onDetachedFromWindow() { if (dialog != null) dialog.dismiss(); super.onDetachedFromWindow(); }
    }

    private static String compact(long value) {
        if (value < 1000) return Long.toString(value);
        return String.format(Locale.US, "%.1f", value / (value < 1000000 ? 1000d : 1000000d)).replaceAll("\\.0$", "") + (value < 1000000 ? "K" : "M");
    }

    private static void show(UsageButton anchor, TurnDetails details, boolean chinese) {
        SettingsStyle style = new SettingsStyle(anchor.getContext());
        LinearLayout panel = new LinearLayout(anchor.getContext()); style.sheetPanel(panel); panel.setTag("turnUsagePanel");
        TextView title = style.label(chinese ? "本轮用量" : "Turn usage", Palette.TEXT_TITLE, style.ink); panel.addView(title);
        TextView total = style.label(TurnDetails.tokens(details.total()), Palette.TEXT_ROW, style.secondary);
        total.setPadding(0, style.dp(8), 0, style.dp(16)); panel.addView(total);
        ScrollView scroll = new ScrollView(anchor.getContext()); scroll.setVerticalScrollBarEnabled(false);
        LinearLayout rows = new LinearLayout(anchor.getContext()); rows.setOrientation(LinearLayout.VERTICAL); scroll.addView(rows);
        if (!details.model.isEmpty()) row(rows, style, chinese ? "模型" : "Model", details.model);
        if (details.cacheHit() != null) row(rows, style, chinese ? "缓存命中率" : "Cache hit rate", String.format(Locale.US, "%.1f%%", details.cacheHit()));
        if (details.input != null) row(rows, style, chinese ? "未缓存输入" : "Uncached input", TurnDetails.tokens(details.input));
        if (details.cacheRead != null) row(rows, style, chinese ? "缓存读取" : "Cache read", TurnDetails.tokens(details.cacheRead));
        if (details.cacheWrite != null) row(rows, style, chinese ? "缓存写入" : "Cache write", TurnDetails.tokens(details.cacheWrite));
        if (details.output != null) row(rows, style, chinese ? "输出" : "Output", TurnDetails.tokens(details.output));
        if (details.cost != null) row(rows, style, chinese ? "费用" : "Cost", String.format(Locale.US, "$%.4f", details.cost));
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, -2, 1));
        TextView close = style.label(chinese ? "关闭" : "Close", Palette.TEXT_INPUT, style.ink);
        close.setGravity(Gravity.CENTER); close.setMinHeight(style.dp(48)); close.setFocusable(true); panel.addView(close);
        AlertDialog dialog = new AlertDialog.Builder(anchor.getContext()).setView(panel).create(); anchor.dialog = dialog;
        close.setOnClickListener(view -> dialog.dismiss()); dialog.setOnDismissListener(ignored -> anchor.dialog = null);
        dialog.show(); style.sheetWindow(dialog.getWindow(), panel);
    }

    private static void row(LinearLayout parent, SettingsStyle style, String name, String value) {
        LinearLayout row = new LinearLayout(parent.getContext()); row.setGravity(Gravity.TOP); row.setPadding(0, style.dp(7), 0, style.dp(7));
        TextView label = style.label(name, Palette.TEXT_NOTE, style.palette().faint);
        TextView detail = style.label(value, Palette.TEXT_NOTE, style.secondary); detail.setGravity(Gravity.END); detail.setTextIsSelectable(true);
        boolean model = name.equals("模型") || name.equals("Model");
        row.addView(label, model ? new LinearLayout.LayoutParams(style.dp(48), -2) : new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout.LayoutParams valueParams = new LinearLayout.LayoutParams(0, -2, 1); valueParams.setMarginStart(style.dp(12));
        row.addView(detail, valueParams); parent.addView(row);
    }
}
