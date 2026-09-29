package app.camellia.mobile;

import android.content.Context;
import android.view.Gravity;
import android.widget.*;
import org.json.JSONObject;
import java.util.List;

final class ChatDocumentTray {
    private ChatDocumentTray() {}
    static void append(Context context, LinearLayout tray, List<JSONObject> documents, boolean chinese, ChatImageTray.Remover remover) {
        ChatStyle style = new ChatStyle(context);
        for (int index = 0; index < documents.size(); index++) {
            final int position = index; JSONObject document = documents.get(index);
            LinearLayout chip = new LinearLayout(context); chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setPadding(dp(context, 10), dp(context, 8), 0, dp(context, 8));
            ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon("file", style.ink));
            chip.addView(icon, new LinearLayout.LayoutParams(dp(context, 22), dp(context, 22)));
            TextView label = new TextView(context); label.setText(document.optString("name")); label.setTextColor(style.ink);
            label.setTextSize(13); label.setMaxLines(2); label.setMaxWidth(dp(context, 150)); label.setPadding(dp(context, 8), 0, dp(context, 4), 0);
            label.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE); chip.addView(label);
            if (remover != null) {
                ImageButton remove = style.lineButton("close", (chinese ? "移除文件 " : "Remove file ") + document.optString("name"), () -> remover.remove(position));
                chip.addView(remove, new LinearLayout.LayoutParams(dp(context, 40), dp(context, 40)));
            }
            chip.setTag("document:" + document.optString("name"));
            tray.addView(chip, new LinearLayout.LayoutParams(-2, dp(context, 88)));
        }
    }
    private static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
