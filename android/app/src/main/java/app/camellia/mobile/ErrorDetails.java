package app.camellia.mobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.text.TextUtils;
import android.widget.ScrollView;
import android.widget.TextView;

final class ErrorDetails {
    private static final int LIMIT = 8 * 1024;

    private ErrorDetails() {}

    static String describe(Throwable error) {
        if (error == null) return "";
        StringBuilder detail = new StringBuilder();
        Throwable current = error;
        for (int depth = 0; current != null && depth < 6; depth++) {
            String message = current.getMessage();
            boolean empty = message == null || message.trim().isEmpty();
            String value = empty
                ? current.getClass().getSimpleName()
                : current.getClass().getSimpleName() + ": " + message.trim();
            if (detail.indexOf(value) < 0) {
                if (detail.length() > 0) detail.append('\n');
                detail.append(value);
            }
            Throwable next = current.getCause();
            current = next == current ? null : next;
        }
        return limit(detail.toString());
    }

    static String withSummary(String summary, Throwable error) {
        String detail = describe(error);
        if (detail.isEmpty()) return summary;
        if (detail.contains(summary)) return detail;
        return summary + "\n" + detail;
    }

    static String limit(String value) {
        if (value == null || value.length() <= LIMIT) return value == null ? "" : value;
        return value.substring(0, LIMIT) + "\n…";
    }

    static void bindStatus(final Context context, final TextView status, final boolean chinese) {
        status.setOnClickListener(view -> show(context, chinese, status.getText().toString()));
    }

    static void show(final Context context, boolean chinese, String message) {
        String value = TextUtils.isEmpty(message)
            ? (chinese ? "没有可显示的错误信息。" : "No error details available.")
            : message;
        TextView details = new TextView(context);
        details.setText(value);
        details.setTextSize(15);
        details.setTextIsSelectable(true);
        details.setPadding(dp(context, 20), dp(context, 12), dp(context, 20), dp(context, 12));
        ScrollView panel = new ScrollView(context);
        panel.addView(details);
        new CamelliaDialog.Builder(context)
            .setTitle(chinese ? "状态与错误详情" : "Status and error details")
            .setView(panel)
            .setNeutralButton(chinese ? "复制" : "Copy", (dialog, which) -> copy(context, value))
            .setNegativeButton(chinese ? "关闭" : "Close", null)
            .show();
    }

    private static void copy(Context context, String value) {
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("Camellia error", value));
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
