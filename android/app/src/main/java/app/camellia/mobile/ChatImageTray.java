package app.camellia.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import java.util.List;

// Pending attachments and already sent pictures use the same 88 dp tiles, so a
// local chat and a remote chat show images identically. A null remover renders
// the read-only row used inside a message.
final class ChatImageTray {
    interface Remover { void remove(int index); }

    private ChatImageTray() {}

    static void fill(Context context, LinearLayout tray, List<String> images, int surface, boolean chinese, Remover remover) {
        tray.removeAllViews();
        for (int index = 0; index < images.size(); index++) {
            final int position = index;
            byte[] bytes = android.util.Base64.decode(images.get(index), android.util.Base64.NO_WRAP);
            android.graphics.BitmapFactory.Options options = new android.graphics.BitmapFactory.Options(); options.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            options.inJustDecodeBounds = false; options.inSampleSize = 1;
            while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > dp(context, 144)) options.inSampleSize *= 2;
            ImageView preview = new ImageView(context);
            preview.setImageBitmap(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options));
            preview.setContentDescription((remover == null ? (chinese ? "图片 " : "Image ") : (chinese ? "待发送图片 " : "Image to send ")) + (index + 1));
            preview.setScaleType(ImageView.ScaleType.CENTER_CROP);
            GradientDrawable shape = new GradientDrawable(); shape.setColor(surface); shape.setCornerRadius(dp(context, 14));
            preview.setBackground(shape); preview.setClipToOutline(true);
            FrameLayout tile = new FrameLayout(context);
            FrameLayout.LayoutParams previewParams = new FrameLayout.LayoutParams(dp(context, 72), dp(context, 72));
            previewParams.setMargins(dp(context, 4), dp(context, 8), 0, 0); tile.addView(preview, previewParams);
            if (remover != null) {
                ImageButton close = new ImageButton(context);
                close.setImageDrawable(new LineIcon("close", Color.WHITE)); close.setPadding(dp(context, 12), dp(context, 12), dp(context, 12), dp(context, 12));
                GradientDrawable circle = new GradientDrawable(); circle.setShape(GradientDrawable.OVAL); circle.setColor(0xb3000000);
                close.setBackground(new android.graphics.drawable.InsetDrawable(circle, dp(context, 8)));
                close.setContentDescription((chinese ? "移除图片 " : "Remove image ") + (index + 1));
                close.setOnClickListener(view -> remover.remove(position));
                tile.addView(close, new FrameLayout.LayoutParams(dp(context, 40), dp(context, 40), Gravity.TOP | Gravity.RIGHT));
            }
            tray.addView(tile, new LinearLayout.LayoutParams(dp(context, 88), dp(context, 88)));
        }
    }

    private static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
