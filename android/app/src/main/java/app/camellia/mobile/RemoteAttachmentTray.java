package app.camellia.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.GradientDrawable;
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
import java.util.Locale;

final class RemoteAttachmentTray {
    private RemoteAttachmentTray() {}

    static View create(Context context, ChatStyle style, JSONArray files, long seq,
                       String address, String token, String conversation, boolean chinese) {
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
                images.addView(image(context, style, file, index, seq, address, token, conversation),
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
                              String address, String token, String conversation) {
        FrameLayout tile = new FrameLayout(context);
        tile.setTag("remoteAttachmentImage:" + index);
        tile.setClipToOutline(true);
        GradientDrawable background = style.rounded(style.surface);
        background.setCornerRadius(dp(context, 14));
        tile.setBackground(background);
        tile.setContentDescription(file.optString("name"));

        Bitmap preview = localPreview(context, file.optString("data"));
        if (preview != null) {
            showImage(context, tile, preview, file.optString("name"));
        } else {
            LinearLayout placeholder = new LinearLayout(context);
            placeholder.setOrientation(LinearLayout.VERTICAL);
            placeholder.setGravity(Gravity.CENTER);
            ImageView icon = new ImageView(context);
            icon.setImageDrawable(new LineIcon("image", style.muted));
            placeholder.addView(icon, new LinearLayout.LayoutParams(dp(context, 30), dp(context, 30)));
            TextView extension = new TextView(context);
            extension.setText(extension(file.optString("name")));
            extension.setTextColor(style.muted);
            extension.setTextSize(10);
            extension.setGravity(Gravity.CENTER);
            extension.setMaxLines(1);
            placeholder.addView(extension, new LinearLayout.LayoutParams(-2, -2));
            tile.addView(placeholder, new FrameLayout.LayoutParams(-1, -1));
            addCaption(context, tile, file.optString("name"));
            RemoteAttachmentThumbnails.load(address, token, conversation, seq, index, file.optLong("size", -1),
                new MarkdownView.ImageCallback() {
                    @Override public void loaded(Bitmap bitmap) { showImage(context, tile, bitmap, file.optString("name")); }
                    @Override public void failed() { }
                });
        }
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

    private static void showImage(Context context, FrameLayout tile, Bitmap bitmap, String name) {
        tile.removeAllViews();
        ImageView image = new ImageView(context);
        image.setImageBitmap(bitmap);
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        tile.addView(image, new FrameLayout.LayoutParams(-1, -1));
        addCaption(context, tile, name);
    }

    private static void addCaption(Context context, FrameLayout tile, String name) {
        TextView caption = new TextView(context);
        caption.setText(name);
        caption.setTextColor(android.graphics.Color.WHITE);
        caption.setTextSize(9);
        caption.setMaxLines(1);
        caption.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        caption.setPadding(dp(context, 4), dp(context, 2), dp(context, 4), dp(context, 2));
        caption.setBackgroundColor(0x99000000);
        tile.addView(caption, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
    }

    private static Bitmap localPreview(Context context, String reference) {
        if (!AttachmentStore.isReference(reference)) return null;
        try {
            byte[] bytes = AttachmentStore.preview(context, reference);
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 288)
                options.inSampleSize *= 2;
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        } catch (Exception error) {
            return null;
        }
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

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        String value = dot < 0 ? "IMG" : name.substring(dot + 1).toUpperCase(Locale.ROOT);
        return value.length() > 5 ? value.substring(0, 5) : value;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
