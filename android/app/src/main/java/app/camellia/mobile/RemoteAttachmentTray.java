package app.camellia.mobile;

import android.content.Context;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

final class RemoteAttachmentTray {
    private RemoteAttachmentTray() {}

    static View create(Context context, ChatStyle style, JSONArray files, long seq,
                       String address, String token, String conversation, boolean chinese) {
        return create(context, style, files, seq, address, token, conversation, chinese, RemoteApi::new);
    }

    static View create(Context context, ChatStyle style, JSONArray files, long seq,
                       String address, String token, String conversation, boolean chinese,
                       java.util.function.Function<String, RemoteApi> clients) {
        if (files == null || files.length() == 0) return null;
        LinearLayout tray = new LinearLayout(context);
        tray.setOrientation(LinearLayout.VERTICAL);
        tray.setTag("remoteMessageAttachments");
        LinearLayout images = row(context, "remoteMessageImages");
        LinearLayout documents = row(context, "remoteMessageDocuments");
        for (int index = 0; index < files.length(); index++) {
            JSONObject file = files.optJSONObject(index);
            if (file == null) continue;
            String name = file.optString("name");
            if (name.isEmpty()) continue;
            if (file.optBoolean("isImage")) {
                images.addView(image(context, style, file, index, seq, address, token, conversation, clients),
                    new LinearLayout.LayoutParams(dp(context, 88), dp(context, 88)));
            } else {
                documents.addView(document(context, style, name, chinese),
                    new LinearLayout.LayoutParams(-2, dp(context, 48)));
            }
        }
        if (images.getChildCount() > 0) tray.addView(scroller(context, images));
        if (documents.getChildCount() > 0) tray.addView(scroller(context, documents));
        return tray;
    }

    private static View image(Context context, ChatStyle style, JSONObject file, int index, long seq,
                              String address, String token, String conversation, java.util.function.Function<String, RemoteApi> clients) {
        String reference = file.optString("data");
        AttachmentImages.Source source = reference.isEmpty()
            ? AttachmentImages.remote(address, token, conversation, seq, index, file.optLong("size", -1), clients)
            : AttachmentImages.local(context, reference);
        AttachmentImageView tile = new AttachmentImageView(context, style, file.optString("name"), source, true);
        tile.setTag("remoteAttachmentImage:" + index);
        return tile;
    }

    private static View document(Context context, ChatStyle style, String name, boolean chinese) {
        LinearLayout chip = new LinearLayout(context);
        chip.setGravity(Gravity.CENTER_VERTICAL);
        chip.setPadding(dp(context, 10), 0, dp(context, 12), 0);
        chip.setBackground(style.capsule(style.surface));
        chip.setTag("remoteAttachmentDocument");
        ImageView icon = new ImageView(context);
        icon.setImageDrawable(new LineIcon("file", style.ink));
        chip.addView(icon, new LinearLayout.LayoutParams(dp(context, 22), dp(context, 22)));
        TextView label = new TextView(context);
        label.setText(name);
        label.setTextColor(style.ink);
        label.setTextSize(Palette.TEXT_NOTE);
        label.setMaxLines(1);
        label.setMaxWidth(dp(context, 180));
        label.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        label.setPadding(dp(context, 8), 0, 0, 0);
        chip.addView(label);
        chip.setContentDescription((chinese ? "附件 " : "Attachment ") + name);
        return chip;
    }

    private static LinearLayout row(Context context, String tag) {
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setTag(tag);
        return row;
    }

    private static HorizontalScrollView scroller(Context context, LinearLayout row) {
        HorizontalScrollView scroll = new HorizontalScrollView(context);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setFillViewport(false);
        scroll.setClipToPadding(false);
        scroll.setPadding(0, 0, 0, dp(context, 4));
        scroll.addView(row, new FrameLayout.LayoutParams(-2, -2));
        return scroll;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
